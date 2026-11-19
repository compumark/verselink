import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createVersekitAdapter } from "../src/integrations/versekit/index.js";
import { createTokenCodec } from "../src/integrations/versekit/tokens.js";
import { VersekitTokenStore } from "../src/integrations/versekit/store.js";
import { resolveC6TestDatabaseUrl } from "./helpers/c6-test-database.js";
import { startMissionTestServer, stopMissionTestServer } from "./helpers/mission-integration.js";

const pepper = "vk04-lock-order-test-pepper-with-more-than-thirty-two-bytes";
const quotaPolicy = Object.freeze({ capacity: 4096, refillIntervalSeconds: 3600 });
const boundedPool = async (url, pg) => new pg.Pool({
  connectionString: url,
  max: 6,
  connectionTimeoutMillis: 3_000,
  statement_timeout: 10_000,
  query_timeout: 12_000,
  lock_timeout: 7_000
});

const waitFor = async (pool, description, predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await pool.query({
      text: "SELECT pid,state,wait_event_type,wait_event,query,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND wait_event_type='Lock' ORDER BY query_start",
      query_timeout: 1_000
    });
    const found = result.rows.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out observing PostgreSQL lock wait: ${description}`);
};

test("VerseKit authorization and refresh-token revocation follow family-before-token lock order", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 50_000
}, async () => {
  const { default: pg } = await import("pg");
  const safeUrl = resolveC6TestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const databaseName = `vk04_lock_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(safeUrl);
  adminUrl.pathname = "/postgres";
  const databaseAdmin = await boundedPool(adminUrl.toString(), pg);
  let pool;
  let monitor;
  let runtime;
  let blocker;
  let blockerInTransaction = false;
  let revocation;
  let authorization;
  let databaseCreated = false;
  try {
    assert.match(databaseName, /^vk04_lock_[a-f0-9]{32}$/);
    await databaseAdmin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const databaseUrlObject = new URL(safeUrl);
    databaseUrlObject.pathname = `/${databaseName}`;
    const databaseUrl = databaseUrlObject.toString();

    runtime = await startMissionTestServer({ databaseUrl, pepper, extraEnv: { VERSEKIT_ENABLED: "false" } });
    await stopMissionTestServer(runtime);
    runtime = null;

    pool = await boundedPool(databaseUrl, pg);
    monitor = await boundedPool(databaseUrl, pg);
    const enabled = {
      VERSEKIT_ENABLED: "true",
      VERSEKIT_GROUP_ID: randomUUID(),
      VERSEKIT_PUBLIC_URL: "https://verse.example.org/"
    };
    const otherGroup = randomUUID();
    const userId = randomUUID();
    await pool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,'Lock Order Group'),($2,'Unrelated Group')", [enabled.VERSEKIT_GROUP_ID, otherGroup]);
    await pool.query("INSERT INTO app_users(id,email,display_name,account_status) VALUES($1,$2,'Lock Order Member','active')", [userId, `vk04-lock-${userId}@example.test`]);
    await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'member'),($3,$2,'member')", [enabled.VERSEKIT_GROUP_ID, userId, otherGroup]);
    await createVersekitAdapter({ env: enabled, db: pool, pepper, quotaPolicy, capabilities: ["orders:read"] });
    const codec = createTokenCodec(pepper);
    const store = new VersekitTokenStore({ db: pool, codec, groupId: enabled.VERSEKIT_GROUP_ID, operationalScopes: ["orders:read"] });
    const issuePair = async () => {
      const grant = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      assert.equal(await store.consent({ grantId: grant.id, userId, scopes: ["orders:read"], approve: true }), true);
      const exchanged = await store.exchangeDeviceCode({ deviceCode: grant.deviceCode, clientId: "versekit" });
      assert.ok(exchanged.tokens);
      return exchanged.tokens;
    };
    const target = await issuePair();
    const unrelated = await issuePair();
    const targetFamily = (await pool.query("SELECT family_id FROM versekit_tokens WHERE token_hash=$1 AND token_type='refresh'", [codec.hash("refresh", target.refresh_token)])).rows[0].family_id;

    // Counterfactual: the previous authorization statement locked token (t)
    // before family (f). Queue production revoke() on the family first, then
    // issue only that prior FOR SHARE lock ordering in a test-only transaction.
    const counterfactual = await issuePair();
    const counterfactualFamily = (await pool.query("SELECT family_id FROM versekit_tokens WHERE token_hash=$1 AND token_type='refresh'", [codec.hash("refresh", counterfactual.refresh_token)])).rows[0].family_id;
    const counterBlocker = await pool.connect();
    let counterBlockerOpen = false;
    let counterAuthClient;
    let counterAuthOpen = false;
    let counterRevoke;
    let counterAuthorization;
    try {
      const counterBlockerPid = Number((await counterBlocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await counterBlocker.query("BEGIN");
      counterBlockerOpen = true;
      await counterBlocker.query("SELECT id FROM versekit_token_families WHERE id=$1 FOR UPDATE", [counterfactualFamily]);
      counterRevoke = store.revoke(counterfactual.refresh_token);
      counterRevoke.catch(() => {});
      const counterRevokeWaiter = await waitFor(monitor, "counterfactual revoke queued on family",
        (row) => row.query.includes("versekit_token_families") && row.query.includes("FOR UPDATE"));
      const counterRevokePid = Number(counterRevokeWaiter.pid);
      assert.ok(counterRevokeWaiter.blockers.map(Number).includes(counterBlockerPid));
      counterAuthClient = await pool.connect();
      const counterAuthPid = Number((await counterAuthClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await counterAuthClient.query("BEGIN");
      counterAuthOpen = true;
      counterAuthorization = counterAuthClient.query({
        text: "SELECT t.id FROM versekit_tokens t JOIN versekit_token_families f ON f.id=t.family_id WHERE t.token_hash=$1 AND t.token_type='access' FOR SHARE OF t,f",
        values: [codec.hash("access", counterfactual.access_token)]
      });
      counterAuthorization.catch(() => {});
      const counterAuthWaiter = await waitFor(monitor, "counterfactual prior authorization lock order",
        (row) => Number(row.pid) === counterAuthPid && row.query.includes("FOR SHARE OF t,f"));
      assert.ok(counterAuthWaiter.blockers.map(Number).includes(counterRevokePid),
        "the old token-first authorization queues behind revoke while holding the token row lock");
      await counterBlocker.query("COMMIT");
      counterBlockerOpen = false;
      const counterResults = await Promise.allSettled([counterRevoke, counterAuthorization]);
      const deadlock = counterResults.find((result) => result.status === "rejected" && result.reason?.code === "40P01");
      assert.ok(deadlock, "PostgreSQL detects the previous token/family lock-order deadlock (40P01)");
    } finally {
      if (counterBlockerOpen) await counterBlocker.query("ROLLBACK").catch(() => {});
      if (counterAuthOpen) await counterAuthClient.query("ROLLBACK").catch(() => {});
      counterBlocker.release();
      counterAuthClient?.release();
      await counterRevoke?.catch(() => {});
      await counterAuthorization?.catch(() => {});
    }

    blocker = await pool.connect();
    const blockerPid = Number((await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    await blocker.query("BEGIN");
    blockerInTransaction = true;
    await blocker.query("SELECT id FROM versekit_token_families WHERE id=$1 FOR UPDATE", [targetFamily]);

    revocation = store.revoke(target.refresh_token);
    revocation.catch(() => {});
    const revokeWaiter = await waitFor(monitor, "production revoke() waiting on the target family",
      (row) => row.query.includes("versekit_token_families") && row.query.includes("FOR UPDATE"));
    const revokePid = Number(revokeWaiter.pid);
    assert.ok(revokeWaiter.blockers.map(Number).includes(blockerPid), "pg_blocking_pids identifies the external family blocker ahead of revoke");

    const authClient = await pool.connect();
    const authPid = Number((await authClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    let authInTransaction = false;
    try {
      await authClient.query("BEGIN");
      authInTransaction = true;
      authorization = store.authorizeAccess(target.access_token, { operation: "orders:read", client: authClient });
      authorization.catch(() => {});
      const authWaiter = await waitFor(monitor, "production authorizeAccess() waiting on the target family",
        (row) => Number(row.pid) === authPid && row.query.includes("versekit_token_families"));
      assert.ok(authWaiter.blockers.map(Number).includes(revokePid), "pg_blocking_pids proves authorization queued behind production revoke");
      await blocker.query("COMMIT");
      blockerInTransaction = false;
      await revocation;
      revocation = null;
      const authResult = await authorization;
      authorization = null;
      assert.equal(authResult.allowed, false, "authorization queued behind revocation fails closed after it commits");
      await authClient.query("COMMIT");
      authInTransaction = false;
    } finally {
      if (authInTransaction) await authClient.query("ROLLBACK").catch(() => {});
      authClient.release();
    }

    assert.equal(await store.authenticateAccess(target.access_token), null, "target access credential was revoked");
    assert.deepEqual(await store.refresh({ refreshToken: target.refresh_token, clientId: "versekit" }), { error: "invalid_grant" }, "the same family's refresh credential remains revoked");
    assert.equal((await store.authorizeAccess(unrelated.access_token, { operation: "orders:read" })).allowed, true, "unrelated token family remains authorized");
  } catch (error) {
    throw error;
  } finally {
    if (blockerInTransaction) await blocker.query("ROLLBACK").catch(() => {});
    blocker?.release();
    if (revocation) await revocation.catch(() => {});
    if (authorization) await authorization.catch(() => {});
    await stopMissionTestServer(runtime);
    await monitor?.end();
    await pool?.end();
    if (databaseCreated) {
      await databaseAdmin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [databaseName]);
      await databaseAdmin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
    await databaseAdmin.end();
  }
});
