import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createVersekitAdapter } from "../src/integrations/versekit/index.js";
import { activateVersekitAuthorizationGroup } from "../src/integrations/versekit/schema.js";
import { createTokenCodec } from "../src/integrations/versekit/tokens.js";
import { VersekitTokenStore } from "../src/integrations/versekit/store.js";
import { resolveC6TestDatabaseUrl } from "./helpers/c6-test-database.js";
import { apiRequest, createSession, startMissionTestServer, stopMissionTestServer, VERSEKIT_TEST_TOKEN_PEPPER } from "./helpers/mission-integration.js";

const pepper = "vk04-lock-order-test-pepper-with-more-than-thirty-two-bytes";
const tokenPepper = VERSEKIT_TEST_TOKEN_PEPPER;
const quotaPolicy = Object.freeze({ capacity: 4096, refillIntervalSeconds: 3600 });
const boundedPool = async (url, pg, applicationName) => new pg.Pool({
  connectionString: url,
  application_name: applicationName,
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
  const poolErrors = [];
  const trackedPool = (name, value) => {
    value.on("error", (error) => poolErrors.push({ name, error }));
    return value;
  };
  const databaseAdmin = trackedPool("databaseAdmin", await boundedPool(adminUrl.toString(), pg, "vk04-lock-order-admin"));
  let pool;
  let monitor;
  let runtime;
  let blocker;
  let blockerInTransaction = false;
  let revocation;
  let authorization;
  let databaseCreated = false;
  let primaryError;
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

    pool = trackedPool("application pool", await boundedPool(databaseUrl, pg, "vk04-lock-order-main"));
    monitor = trackedPool("monitor pool", await boundedPool(databaseUrl, pg, "vk04-lock-order-monitor"));
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
    await createVersekitAdapter({ env: enabled, db: pool, tokenPepper, quotaPolicy, capabilities: ["orders:read"] });
    const codec = createTokenCodec(tokenPepper);
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

    const deletionPair = await issuePair();
    await pool.query("UPDATE group_members SET role='owner' WHERE group_id=$1 AND app_user_id=$2", [enabled.VERSEKIT_GROUP_ID, userId]);
    const session = await createSession(pool, pepper, userId);
    runtime = await startMissionTestServer({ databaseUrl, pepper, extraEnv: { VERSEKIT_ENABLED: "false" } });
    const deleteAuth = await pool.connect();
    const deleteAuthPid = Number((await deleteAuth.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
    let authOpen = false;
    let deleteResponse;
    let deleting;
    try {
      await deleteAuth.query("BEGIN");
      authOpen = true;
      const authorized = await store.authorizeAccess(deletionPair.access_token, { operation: "orders:read", client: deleteAuth });
      assert.equal(authorized.allowed, true);
      deleting = apiRequest(runtime.baseUrl, "/api/groups/delete", { method: "POST", session, form: { group_id: enabled.VERSEKIT_GROUP_ID } });
      const deleteWaiter = await waitFor(monitor, "production group deletion waiting on caller-owned authorization",
        (row) => row.query.includes("DELETE FROM blueprint_groups"));
      assert.ok(deleteWaiter.blockers.map(Number).includes(deleteAuthPid));
      await deleteAuth.query("COMMIT");
      authOpen = false;
      deleteResponse = await deleting;
      assert.equal(deleteResponse.status, 200);
    } finally {
      if (authOpen) await deleteAuth.query("ROLLBACK").catch(() => {});
      deleteAuth.release();
      await stopMissionTestServer(runtime);
      runtime = null;
    }
    assert.equal((await pool.query("SELECT 1 FROM blueprint_groups WHERE id=$1", [enabled.VERSEKIT_GROUP_ID])).rowCount, 0);
    assert.equal(await store.authenticateAccess(deletionPair.access_token), null);
    assert.deepEqual(await store.refresh({ refreshToken: deletionPair.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });
    assert.equal((await pool.query("SELECT 1 FROM blueprint_groups WHERE id=$1", [otherGroup])).rowCount, 1);

    const finalGroup = randomUUID();
    const survivingGroup = randomUUID();
    await pool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,'Final Refresh Test Group'),($2,'Unrelated Surviving Group')", [finalGroup, survivingGroup]);
    await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'owner')", [finalGroup, userId]);
    await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'member')", [survivingGroup, userId]);
    const runRefreshDeleteOrdering = async ({ groupId, refreshFirst }) => {
      const env = { ...enabled, VERSEKIT_GROUP_ID: groupId };
      await createVersekitAdapter({ env, db: pool, tokenPepper, quotaPolicy, capabilities: ["orders:read"] });
      const targetStore = new VersekitTokenStore({ db: pool, codec, groupId, operationalScopes: ["orders:read"] });
      const grant = await targetStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      assert.equal(await targetStore.consent({ grantId: grant.id, userId, scopes: ["orders:read"], approve: true }), true);
      const targetPair = (await targetStore.exchangeDeviceCode({ deviceCode: grant.deviceCode, clientId: "versekit" })).tokens;
      assert.ok(targetPair);
      await pool.query("UPDATE group_members SET role='owner' WHERE group_id=$1 AND app_user_id=$2", [groupId, userId]);
      const sessionCookie = await createSession(pool, pepper, userId);
      const groupBlocker = await pool.connect();
      let blockerOpen = false;
      let refreshPromise;
      let deletionPromise;
      let refreshResult;
      let releaseBarrier;
      try {
        const blockerPid = Number((await groupBlocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        if (refreshFirst) {
          const entered = (() => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; })();
          const refreshPool = {
            query: (...args) => pool.query(...args),
            async connect() {
              const client = await pool.connect();
              const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
              return {
                async query(sql, params) {
                  const result = await client.query(sql, params);
                  if (typeof sql === "string" && sql.includes("FOR KEY SHARE") && sql.includes("blueprint_groups")) { entered.resolve(pid); await releasePromise; }
                  return result;
                },
                release: () => client.release()
              };
            }
          };
          const releasePromise = new Promise((resolve) => { releaseBarrier = resolve; });
          const hookedStore = new VersekitTokenStore({ db: refreshPool, codec, groupId, operationalScopes: ["orders:read"] });
          refreshPromise = hookedStore.refresh({ refreshToken: targetPair.refresh_token, clientId: "versekit" });
          refreshPromise.catch(() => {});
          const refreshPid = await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error("refresh did not acquire the group lock")), 5000))]);
          deletionPromise = apiRequest(runtime.baseUrl, "/api/groups/delete", { method: "POST", session: sessionCookie, form: { group_id: groupId } });
          const deleteWaiter = await waitFor(monitor, "group deletion waiting on refresh-held group lock", (row) => row.query.includes("DELETE FROM blueprint_groups"));
          assert.ok(deleteWaiter.blockers.map(Number).includes(refreshPid));
          releaseBarrier();
          refreshResult = await refreshPromise;
          assert.ok(refreshResult.tokens, "refresh-first ordering completes rotation before deletion");
          const deletion = await deletionPromise;
          assert.equal(deletion.status, 200);
          assert.equal((await targetStore.authorizeAccess(targetPair.access_token, { operation: "me" })).allowed, false);
          assert.deepEqual(await targetStore.refresh({ refreshToken: refreshResult.tokens.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });
        } else {
          await groupBlocker.query("BEGIN");
          blockerOpen = true;
          await groupBlocker.query("SELECT id FROM blueprint_groups WHERE id=$1 FOR UPDATE", [groupId]);
          deletionPromise = apiRequest(runtime.baseUrl, "/api/groups/delete", { method: "POST", session: sessionCookie, form: { group_id: groupId } });
          const deleteWaiter = await waitFor(monitor, "group deletion waiting on explicit parent blocker", (row) => row.query.includes("DELETE FROM blueprint_groups"));
          const deletePid = Number(deleteWaiter.pid);
          assert.ok(deleteWaiter.blockers.map(Number).includes(blockerPid));
          refreshPromise = targetStore.refresh({ refreshToken: targetPair.refresh_token, clientId: "versekit" });
          refreshPromise.catch(() => {});
          const refreshWaiter = await waitFor(monitor, "refresh waiting behind group deletion", (row) => row.query.includes("FOR KEY SHARE") && row.query.includes("blueprint_groups"));
          assert.ok(refreshWaiter.blockers.map(Number).includes(deletePid));
          await groupBlocker.query("COMMIT");
          blockerOpen = false;
          const deletion = await deletionPromise;
          assert.equal(deletion.status, 200);
          refreshResult = await refreshPromise;
          assert.deepEqual(refreshResult, { error: "invalid_grant" });
        }
        const remaining = await pool.query("SELECT count(*)::int AS count FROM versekit_token_families WHERE group_id=$1", [groupId]);
        assert.equal(remaining.rows[0].count, 0, "group cascade leaves no partially rotated family");
        assert.equal((await pool.query("SELECT 1 FROM blueprint_groups WHERE id=$1", [survivingGroup])).rowCount, 1);
        assert.equal((await targetStore.authorizeAccess(targetPair.access_token, { operation: "me" })).allowed, false);
        assert.deepEqual(await targetStore.refresh({ refreshToken: targetPair.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });
      } finally {
        releaseBarrier?.();
        if (blockerOpen) await groupBlocker.query("ROLLBACK").catch(() => {});
        groupBlocker.release();
        await refreshPromise?.catch(() => {});
        await deletionPromise?.catch(() => {});
      }
    };
    runtime = await startMissionTestServer({ databaseUrl, pepper, extraEnv: { VERSEKIT_ENABLED: "false" } });
    await runRefreshDeleteOrdering({ groupId: otherGroup, refreshFirst: true });
    await runRefreshDeleteOrdering({ groupId: finalGroup, refreshFirst: false });

    const setupGroup = async (name) => {
      const groupId = randomUUID();
      await pool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,$2)", [groupId, name]);
      await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'owner')", [groupId, userId]);
      const env = { ...enabled, VERSEKIT_GROUP_ID: groupId };
      await createVersekitAdapter({ env, db: pool, tokenPepper, quotaPolicy, capabilities: ["orders:read"] });
      const targetStore = new VersekitTokenStore({ db: pool, codec, groupId, operationalScopes: ["orders:read"] });
      const grant = await targetStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      const sessionCookie = await createSession(pool, pepper, userId);
      return { groupId, targetStore, grant, sessionCookie };
    };
    const runParentLockBeforeDelete = async ({ name, prepare, invoke, afterDelete }) => {
      const fixture = await setupGroup(name);
      await prepare?.(fixture);
      let release;
      const entered = (() => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; })();
      const released = new Promise((resolve) => { release = resolve; });
      const hookedPool = {
        query: (...args) => pool.query(...args),
        async connect() {
          const client = await pool.connect();
          const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
          return {
            async query(sql, params) {
              const result = await client.query(sql, params);
              if (typeof sql === "string" && sql.includes("FOR KEY SHARE") && sql.includes("blueprint_groups")) {
                entered.resolve(pid);
                await released;
              }
              return result;
            },
            release: () => client.release()
          };
        }
      };
      const hookedStore = new VersekitTokenStore({ db: hookedPool, codec, groupId: fixture.groupId, operationalScopes: ["orders:read"] });
      let operation;
      let deletion;
      try {
        operation = invoke(hookedStore, fixture);
        operation.catch(() => {});
        const operationPid = await Promise.race([entered.promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${name}: operation did not acquire group lock`)), 5_000))]);
        deletion = apiRequest(runtime.baseUrl, "/api/groups/delete", { method: "POST", session: fixture.sessionCookie, form: { group_id: fixture.groupId } });
        const waiter = await waitFor(monitor, `${name}: group deletion waits for the operation`, (row) => row.query.includes("DELETE FROM blueprint_groups"));
        assert.ok(waiter.blockers.map(Number).includes(operationPid), `${name}: pg_blocking_pids identifies the operation's parent lock`);
        release();
        const value = await operation;
        const response = await deletion;
        assert.equal(response.status, 200, `${name}: group deletion completes`);
        await afterDelete(fixture, value);
      } finally {
        release();
        await operation?.catch(() => {});
        await deletion?.catch(() => {});
      }
    };

    await runParentLockBeforeDelete({
      name: "device grant consent",
      invoke: async (targetStore, { grant }) => targetStore.consent({ grantId: grant.id, userId, scopes: ["orders:read"], approve: true }),
      afterDelete: async ({ targetStore, grant }, approved) => {
        assert.equal(approved, true, "consent completes before the serialized group deletion");
        assert.deepEqual(await targetStore.exchangeDeviceCode({ deviceCode: grant.deviceCode, clientId: "versekit" }), { error: "invalid_grant" });
      }
    });
    await runParentLockBeforeDelete({
      name: "consent challenge creation",
      invoke: (targetStore, { grant }) => targetStore.createConsentChallenge({ userCode: grant.userCode, userId, sessionHash: "a".repeat(64) }),
      afterDelete: async ({ targetStore }, challenge) => {
        assert.ok(challenge?.challenge, "challenge creation completed before deletion");
        assert.equal(await targetStore.decideConsent({ challenge: challenge.challenge, userId, sessionHash: "a".repeat(64), scopes: ["orders:read"], approve: true }), false,
          "cascaded challenge cannot be consumed after deletion");
      }
    });
    await runParentLockBeforeDelete({
      name: "consent challenge consumption",
      prepare: async ({ targetStore, grant }) => {
        const challenge = await targetStore.createConsentChallenge({ userCode: grant.userCode, userId, sessionHash: "b".repeat(64) });
        assert.ok(challenge?.challenge);
        grant.challenge = challenge.challenge;
      },
      invoke: (targetStore, { grant }) => targetStore.decideConsent({
        challenge: grant.challenge,
        userId,
        sessionHash: "b".repeat(64),
        scopes: ["orders:read"],
        approve: true
      }),
      afterDelete: async ({ targetStore, grant }, decided) => {
        assert.equal(decided, true, "challenge consumption serializes before deletion");
        assert.deepEqual(await targetStore.exchangeDeviceCode({ deviceCode: grant.deviceCode, clientId: "versekit" }), { error: "invalid_grant" });
      }
    });
    await runParentLockBeforeDelete({
      name: "device-code exchange",
      prepare: async ({ targetStore, grant }) => {
        assert.equal(await targetStore.consent({ grantId: grant.id, userId, scopes: ["orders:read"], approve: true }), true);
      },
      invoke: (targetStore, { grant }) => targetStore.exchangeDeviceCode({ deviceCode: grant.deviceCode, clientId: "versekit" }),
      afterDelete: async ({ targetStore }, exchanged) => {
        assert.ok(exchanged.tokens, `exchange completes before group deletion (returned ${exchanged.error || "no error code"})`);
        assert.equal((await targetStore.authorizeAccess(exchanged.tokens.access_token, { operation: "orders:read" })).allowed, false);
        assert.deepEqual(await targetStore.refresh({ refreshToken: exchanged.tokens.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });
      }
    });

    // Hold the group DELETE after its row lock is acquired with a test-only
    // advisory-lock trigger. This proves exchange waits on the actual deleter,
    // not merely on an unrelated parent-row blocker.
    const deleteFirst = await setupGroup("Delete-first exchange group");
    assert.equal(await deleteFirst.targetStore.consent({ grantId: deleteFirst.grant.id, userId, scopes: ["orders:read"], approve: true }), true);
    const advisory = await pool.connect();
    let advisoryHeld = false;
    let deletion;
    let exchange;
    try {
      await pool.query(`CREATE FUNCTION vk04_pause_group_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(27182,431); RETURN OLD; END $$`);
      await pool.query("CREATE TRIGGER vk04_pause_group_delete BEFORE DELETE ON blueprint_groups FOR EACH ROW EXECUTE FUNCTION vk04_pause_group_delete()");
      const advisoryPid = Number((await advisory.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await advisory.query("SELECT pg_advisory_lock(27182,431)");
      advisoryHeld = true;
      deletion = apiRequest(runtime.baseUrl, "/api/groups/delete", { method: "POST", session: deleteFirst.sessionCookie, form: { group_id: deleteFirst.groupId } });
      const deleteWaiter = await waitFor(monitor, "delete-first exchange: production DELETE waits in trigger", (row) => row.query.includes("DELETE FROM blueprint_groups"));
      const deletePid = Number(deleteWaiter.pid);
      assert.ok(deleteWaiter.blockers.map(Number).includes(advisoryPid), "test trigger deterministically pauses the actual DELETE transaction");
      exchange = deleteFirst.targetStore.exchangeDeviceCode({ deviceCode: deleteFirst.grant.deviceCode, clientId: "versekit" });
      exchange.catch(() => {});
      const exchangeWaiter = await waitFor(monitor, "delete-first exchange: exchange waits on deleted parent row",
        (row) => row.query.includes("FOR KEY SHARE") && row.query.includes("blueprint_groups"));
      assert.ok(exchangeWaiter.blockers.map(Number).includes(deletePid), "pg_blocking_pids identifies the production DELETE transaction as exchange blocker");
      await advisory.query("SELECT pg_advisory_unlock(27182,431)");
      advisoryHeld = false;
      const response = await deletion;
      assert.equal(response.status, 200);
      assert.deepEqual(await exchange, { error: "invalid_grant" }, "exchange fails closed after the group deletion commits");
      assert.equal((await pool.query("SELECT 1 FROM versekit_token_families WHERE group_id=$1", [deleteFirst.groupId])).rowCount, 0,
        "delete-first exchange creates no credential family");
    } finally {
      if (advisoryHeld) await advisory.query("SELECT pg_advisory_unlock(27182,431)").catch(() => {});
      await exchange?.catch(() => {});
      await deletion?.catch(() => {});
      advisory.release();
      await pool.query("DROP TRIGGER IF EXISTS vk04_pause_group_delete ON blueprint_groups").catch(() => {});
      await pool.query("DROP FUNCTION IF EXISTS vk04_pause_group_delete()").catch(() => {});
    }

    // Counterfactual: child-first challenge deletion followed by a blocking
    // parent grant delete forms the inversion that SKIP LOCKED must prevent.
    const counterFixture = await setupGroup("Cleanup counterfactual group");
    const counterChallenge = await counterFixture.targetStore.createConsentChallenge({
      userCode: counterFixture.grant.userCode, userId, sessionHash: "c".repeat(64)
    });
    await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '32 days',expires_at=now()-interval '31 days' WHERE id=$1", [counterFixture.grant.id]);
    await pool.query("UPDATE versekit_consent_challenges SET expires_at=now()-interval '2 days' WHERE challenge_hash=$1", [codec.hash("consent_challenge", counterChallenge.challenge)]);
    const counterCleanupClient = await pool.connect();
    let counterCleanupOpen = false;
    let counterGrantLockRelease;
    const counterGrantLockEntered = (() => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; })();
    const counterGrantLockGate = new Promise((resolve) => { counterGrantLockRelease = resolve; });
    const counterDecisionDb = {
      query: (...args) => pool.query(...args),
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params) {
            const result = await client.query(sql, params);
            if (typeof sql === "string" && sql.includes("FROM versekit_device_grants WHERE id=(SELECT grant_id") && sql.includes("FOR UPDATE")) {
              counterGrantLockEntered.resolve(Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid));
              await counterGrantLockGate;
            }
            return result;
          },
          release: () => client.release()
        };
      }
    };
    const counterDecisionStore = new VersekitTokenStore({ db: counterDecisionDb, codec, groupId: counterFixture.groupId, operationalScopes: ["orders:read"] });
    let counterDecision;
    let counterParentDelete;
    try {
      await counterCleanupClient.query("BEGIN");
      counterCleanupOpen = true;
      const counterCleanupPid = Number((await counterCleanupClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await counterCleanupClient.query("DELETE FROM versekit_consent_challenges WHERE challenge_hash=$1", [codec.hash("consent_challenge", counterChallenge.challenge)]);
      counterDecision = counterDecisionStore.decideConsent({
        challenge: counterChallenge.challenge, userId, sessionHash: "c".repeat(64), scopes: ["orders:read"], approve: true
      });
      counterDecision.catch(() => {});
      const decisionPid = await Promise.race([
        counterGrantLockEntered.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("counterfactual decision did not lock the grant")), 5_000))
      ]);
      counterParentDelete = counterCleanupClient.query("DELETE FROM versekit_device_grants WHERE id=$1", [counterFixture.grant.id]);
      counterParentDelete.catch(() => {});
      const parentWaiter = await waitFor(monitor, "counterfactual cleanup waiting on decision-held grant",
        (row) => Number(row.pid) === counterCleanupPid && row.query.includes("DELETE FROM versekit_device_grants"));
      assert.ok(parentWaiter.blockers.map(Number).includes(decisionPid), "counterfactual parent deletion waits on the grant lock held by consent");
      counterGrantLockRelease();
      const challengeWaiter = await waitFor(monitor, "counterfactual decision waiting on cleanup-held challenge",
        (row) => Number(row.pid) === decisionPid && row.query.includes("versekit_consent_challenges") && row.query.includes("FOR UPDATE"));
      assert.ok(challengeWaiter.blockers.map(Number).includes(counterCleanupPid), "counterfactual consent waits on the challenge held by cleanup");
      const counterfactualResults = await Promise.race([
        Promise.allSettled([counterParentDelete, counterDecision]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("PostgreSQL did not resolve counterfactual deadlock")), 5_000))
      ]);
      const deadlock = counterfactualResults.find((result) => result.status === "rejected" && result.reason?.code === "40P01");
      assert.ok(deadlock, "PostgreSQL confirms the test-only child/grant lock-order cycle with 40P01");
      await counterCleanupClient.query("ROLLBACK").catch(() => {});
      counterCleanupOpen = false;
    } finally {
      counterGrantLockRelease();
      if (counterCleanupOpen) await counterCleanupClient.query("ROLLBACK").catch(() => {});
      counterCleanupClient.release();
      await counterParentDelete?.catch(() => {});
      await counterDecision?.catch(() => {});
    }
    await pool.query("DELETE FROM versekit_device_grants WHERE id=$1", [counterFixture.grant.id]);

    // Production cleanup keeps challenge -> grant ordering, but the grant
    // selector's SKIP LOCKED must avoid waiting on a consent-held grant.
    // Pause both transactions after their real SQL has acquired those locks.
    const cleanupFixture = await setupGroup("Cleanup production group");
    const cleanupChallenge = await cleanupFixture.targetStore.createConsentChallenge({
      userCode: cleanupFixture.grant.userCode, userId, sessionHash: "d".repeat(64)
    });
    await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '32 days',expires_at=now()-interval '31 days' WHERE id=$1", [cleanupFixture.grant.id]);
    await pool.query("UPDATE versekit_consent_challenges SET expires_at=now()-interval '2 days' WHERE challenge_hash=$1", [codec.hash("consent_challenge", cleanupChallenge.challenge)]);
    let cleanupChallengeRelease;
    let cleanupGrantRelease;
    let decisionGrantRelease;
    const cleanupChallengeEntered = (() => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; })();
    const cleanupGrantEntered = (() => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; })();
    const decisionGrantEntered = (() => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; })();
    const cleanupChallengeGate = new Promise((resolve) => { cleanupChallengeRelease = resolve; });
    const cleanupGrantGate = new Promise((resolve) => { cleanupGrantRelease = resolve; });
    const decisionGrantGate = new Promise((resolve) => { decisionGrantRelease = resolve; });
    const coordinatedCleanupDb = {
      query: (...args) => pool.query(...args),
      async connect() {
        const client = await pool.connect();
        const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        return {
          async query(sql, params) {
            const result = await client.query(sql, params);
            if (typeof sql === "string" && sql.includes("versekit_consent_challenges") && sql.includes("WITH doomed AS")) {
              cleanupChallengeEntered.resolve(pid);
              await cleanupChallengeGate;
            }
            if (typeof sql === "string" && sql.includes("FROM versekit_device_grants g WHERE expires_at") && sql.includes("SKIP LOCKED")) {
              cleanupGrantEntered.resolve(pid);
              await cleanupGrantGate;
            }
            return result;
          },
          release: () => client.release()
        };
      }
    };
    const coordinatedCleanupStore = new VersekitTokenStore({ db: coordinatedCleanupDb, codec, groupId: cleanupFixture.groupId, operationalScopes: ["orders:read"] });
    const coordinatedDecisionDb = {
      query: (...args) => pool.query(...args),
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, params) {
            const result = await client.query(sql, params);
            if (typeof sql === "string" && sql.includes("FROM versekit_device_grants WHERE id=(SELECT grant_id") && sql.includes("FOR UPDATE")) {
              const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
              decisionGrantEntered.resolve(pid);
              await decisionGrantGate;
            }
            return result;
          },
          release: () => client.release()
        };
      }
    };
    const coordinatedDecisionStore = new VersekitTokenStore({ db: coordinatedDecisionDb, codec, groupId: cleanupFixture.groupId, operationalScopes: ["orders:read"] });
    let productionCleanup;
    let productionDecision;
    try {
      productionCleanup = coordinatedCleanupStore.cleanupCredentials();
      productionCleanup.catch(() => {});
      const cleanupPid = await Promise.race([
        cleanupChallengeEntered.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("production cleanup did not lock expired challenge")), 5_000))
      ]);
      productionDecision = coordinatedDecisionStore.decideConsent({
        challenge: cleanupChallenge.challenge, userId, sessionHash: "d".repeat(64), scopes: ["orders:read"], approve: true
      });
      productionDecision.catch(() => {});
      const decisionPid = await Promise.race([
        decisionGrantEntered.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("production consent did not lock grant")), 5_000))
      ]);
      cleanupChallengeRelease();
      decisionGrantRelease();
      const challengeWaiter = await waitFor(monitor, "production consent waits for cleanup-held challenge",
        (row) => Number(row.pid) === decisionPid && row.query.includes("versekit_consent_challenges") && row.query.includes("FOR UPDATE"));
      assert.ok(challengeWaiter.blockers.map(Number).includes(cleanupPid), "consent is waiting on the active cleanup transaction");
      const grantsAfterSkip = await Promise.race([
        cleanupGrantEntered.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("production cleanup did not reach grant retention")), 5_000))
      ]);
      assert.equal(grantsAfterSkip, cleanupPid);
      cleanupGrantRelease();
      const cleanupResult = await productionCleanup;
      assert.equal(cleanupResult.challenges, 1, "retention cleanup removes the expired challenge");
      assert.equal(cleanupResult.grants, 0, "SKIP LOCKED safely defers the consent-locked old grant");
      assert.equal(await productionDecision, false, "consent fails closed after cleanup commits the challenge deletion");
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [cleanupFixture.grant.id])).rowCount, 1,
        "skipped grant remains for a later bounded cleanup pass");
      const retry = await cleanupFixture.targetStore.cleanupCredentials();
      assert.equal(retry.grants, 1, "a later cleanup pass removes the deferred eligible grant");
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [cleanupFixture.grant.id])).rowCount, 0);
    } finally {
      cleanupChallengeRelease();
      cleanupGrantRelease();
      decisionGrantRelease();
      await productionCleanup?.catch(() => {});
      await productionDecision?.catch(() => {});
    }

    const familyCleanupFixture = await setupGroup("Family cleanup concurrency group");
    assert.equal(await familyCleanupFixture.targetStore.consent({
      grantId: familyCleanupFixture.grant.id, userId, scopes: ["orders:read"], approve: true
    }), true);
    const familyCleanupPair = (await familyCleanupFixture.targetStore.exchangeDeviceCode({
      deviceCode: familyCleanupFixture.grant.deviceCode, clientId: "versekit"
    })).tokens;
    assert.ok(familyCleanupPair);
    const familyCleanupId = (await pool.query("SELECT id FROM versekit_token_families WHERE grant_id=$1", [familyCleanupFixture.grant.id])).rows[0].id;
    await pool.query("UPDATE versekit_token_families SET absolute_expires_at=now()-interval '8 days' WHERE id=$1", [familyCleanupId]);
    await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '32 days',expires_at=now()-interval '31 days' WHERE id=$1", [familyCleanupFixture.grant.id]);
    const familyCleanupEntered = (() => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; })();
    let releaseFamilyCleanup;
    const familyCleanupGate = new Promise((resolve) => { releaseFamilyCleanup = resolve; });
    const familyCleanupDb = {
      query: (...args) => pool.query(...args),
      async connect() {
        const client = await pool.connect();
        const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        return {
          async query(sql, params) {
            const result = await client.query(sql, params);
            if (typeof sql === "string" && sql.includes("versekit_token_families WHERE absolute_expires_at") && sql.includes("SKIP LOCKED")) {
              familyCleanupEntered.resolve(pid);
              await familyCleanupGate;
            }
            return result;
          },
          release: () => client.release()
        };
      }
    };
    const familyCleanupStore = new VersekitTokenStore({ db: familyCleanupDb, codec, groupId: familyCleanupFixture.groupId, operationalScopes: ["orders:read"] });
    let familyCleanup;
    let familyRefresh;
    try {
      familyCleanup = familyCleanupStore.cleanupCredentials();
      familyCleanup.catch(() => {});
      const cleanupPid = await Promise.race([
        familyCleanupEntered.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("family cleanup did not delete the expired family")), 5_000))
      ]);
      familyRefresh = familyCleanupFixture.targetStore.refresh({ refreshToken: familyCleanupPair.refresh_token, clientId: "versekit" });
      familyRefresh.catch(() => {});
      const refreshWaiter = await waitFor(monitor, "refresh waits for the active family cleanup cascade",
        (row) => row.query.includes("versekit_token_families WHERE id=$1 FOR UPDATE"));
      assert.ok(refreshWaiter.blockers.map(Number).includes(cleanupPid), "family cleanup is the PostgreSQL blocker for refresh");
      releaseFamilyCleanup();
      const [cleanupResult, refreshResult] = await Promise.all([familyCleanup, familyRefresh]);
      assert.equal(cleanupResult.families, 1);
      assert.equal(cleanupResult.grants, 1, "orphan grant retention runs after family cascade in the same pass");
      assert.deepEqual(refreshResult, { error: "invalid_grant" }, "refresh fails closed after the family cascade commits");
      assert.equal((await pool.query("SELECT 1 FROM versekit_token_families WHERE id=$1", [familyCleanupId])).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM versekit_tokens WHERE family_id=$1", [familyCleanupId])).rowCount, 0,
        "family cleanup cascades all token history");
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [familyCleanupFixture.grant.id])).rowCount, 0);
    } finally {
      releaseFamilyCleanup();
      await familyCleanup?.catch(() => {});
      await familyRefresh?.catch(() => {});
    }

    // Configuration invalidation serializes through the marker row. First let
    // an authorization transaction hold its shared marker lock, then confirm
    // activation waits and revokes the old credentials after authorization
    // completes. Then reverse the ordering: activation owns the marker first,
    // and authorization must wait and fail closed against the new group.
    const configA = await setupGroup("Configuration serialization A");
    const configPair = (await (async () => {
      assert.equal(await configA.targetStore.consent({ grantId: configA.grant.id, userId, scopes: ["orders:read"], approve: true }), true);
      return configA.targetStore.exchangeDeviceCode({ deviceCode: configA.grant.deviceCode, clientId: "versekit" });
    })()).tokens;
    assert.ok(configPair);
    const configBId = randomUUID();
    await pool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,'Configuration serialization B')", [configBId]);
    await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'owner')", [configBId, userId]);
    const configAuth = await pool.connect();
    let configAuthOpen = false;
    let configActivation;
    try {
      const configAuthPid = Number((await configAuth.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await configAuth.query("BEGIN");
      configAuthOpen = true;
      assert.equal((await configA.targetStore.authorizeAccess(configPair.access_token, { operation: "orders:read", client: configAuth })).allowed, true);
      configActivation = activateVersekitAuthorizationGroup(pool, configBId);
      configActivation.catch(() => {});
      const activationWaiter = await waitFor(monitor, "configuration activation waits for caller-owned authorization",
        (row) => row.query.includes("versekit_authorization_config") && row.query.includes("FOR UPDATE"));
      assert.ok(activationWaiter.blockers.map(Number).includes(configAuthPid), "configuration marker row waits for the active authorization transaction");
      await configAuth.query("COMMIT");
      configAuthOpen = false;
      await configActivation;
      assert.equal((await configA.targetStore.authorizeAccess(configPair.access_token, { operation: "orders:read" })).allowed, false,
        "completed A-to-B activation invalidates the old A credential");
      assert.deepEqual(await configA.targetStore.refresh({ refreshToken: configPair.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });
    } finally {
      if (configAuthOpen) await configAuth.query("ROLLBACK").catch(() => {});
      configAuth.release();
      await configActivation?.catch(() => {});
    }
    const configB = new VersekitTokenStore({ db: pool, codec, groupId: configBId, operationalScopes: ["orders:read"] });
    const configBGrant = await configB.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    assert.equal(await configB.consent({ grantId: configBGrant.id, userId, scopes: ["orders:read"], approve: true }), true);
    const configBPair = (await configB.exchangeDeviceCode({ deviceCode: configBGrant.deviceCode, clientId: "versekit" })).tokens;
    assert.ok(configBPair);
    const configCId = randomUUID();
    await pool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,'Configuration serialization C')", [configCId]);
    await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'owner')", [configCId, userId]);
    let releaseActivation;
    const activationEntered = (() => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; })();
    const activationGate = new Promise((resolve) => { releaseActivation = resolve; });
    const activationDb = {
      query: (...args) => pool.query(...args),
      async connect() {
        const client = await pool.connect();
        const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        return {
          async query(sql, params) {
            const result = await client.query(sql, params);
            if (typeof sql === "string" && sql.includes("versekit_authorization_config WHERE id=true FOR UPDATE")) {
              activationEntered.resolve(pid);
              await activationGate;
            }
            return result;
          },
          release: () => client.release()
        };
      }
    };
    let activationFirst;
    let authorizationSecond;
    try {
      activationFirst = activateVersekitAuthorizationGroup(activationDb, configCId);
      activationFirst.catch(() => {});
      const activationPid = await Promise.race([
        activationEntered.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("configuration activation did not acquire the marker lock")), 5_000))
      ]);
      authorizationSecond = configB.authorizeAccess(configBPair.access_token, { operation: "orders:read" });
      authorizationSecond.catch(() => {});
      const authWaiter = await waitFor(monitor, "authorization waits behind configuration invalidation",
        (row) => row.query.includes("versekit_authorization_config") && row.query.includes("FOR SHARE"));
      assert.ok(authWaiter.blockers.map(Number).includes(activationPid), "authorization is blocked by the marker-owning activation transaction");
      releaseActivation();
      await activationFirst;
      assert.equal((await authorizationSecond).allowed, false, "authorization fails closed after the active group changes");
      assert.equal((await configB.authorizeAccess(configBPair.access_token, { operation: "orders:read" })).allowed, false);
      assert.deepEqual(await configB.refresh({ refreshToken: configBPair.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });
      const activeC = new VersekitTokenStore({ db: pool, codec, groupId: configCId, operationalScopes: ["orders:read"] });
      const cGrant = await activeC.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      assert.equal(await activeC.consent({ grantId: cGrant.id, userId, scopes: ["orders:read"], approve: true }), true);
      assert.ok((await activeC.exchangeDeviceCode({ deviceCode: cGrant.deviceCode, clientId: "versekit" })).tokens,
        "credentials for the newly configured group remain usable");
    } finally {
      releaseActivation?.();
      await activationFirst?.catch(() => {});
      await authorizationSecond?.catch(() => {});
    }

    const createActivationDeleteFixture = async (label) => {
      const oldGroupId = randomUUID();
      const targetGroupId = randomUUID();
      await pool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,$2),($3,$4)",
        [oldGroupId, `${label} old group`, targetGroupId, `${label} target group`]);
      await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'owner'),($3,$2,'owner')",
        [oldGroupId, userId, targetGroupId]);
      await activateVersekitAuthorizationGroup(pool, oldGroupId);
      const oldStore = new VersekitTokenStore({ db: pool, codec, groupId: oldGroupId, operationalScopes: ["orders:read"] });
      const pendingGrant = await oldStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      const consumedGrant = await oldStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      assert.equal(await oldStore.consent({ grantId: consumedGrant.id, userId, scopes: ["orders:read"], approve: true }), true);
      const pair = (await oldStore.exchangeDeviceCode({ deviceCode: consumedGrant.deviceCode, clientId: "versekit" })).tokens;
      assert.ok(pair);
      const familyId = (await pool.query("SELECT id FROM versekit_token_families WHERE grant_id=$1", [consumedGrant.id])).rows[0].id;
      return { oldGroupId, targetGroupId, oldStore, pendingGrant, consumedGrant, pair, familyId, sessionCookie: await createSession(pool, pepper, userId) };
    };

    // Counterfactual for the former family-before-grant activation order.
    // The test-only deleter takes group -> pending grant, while the simulated
    // old activation takes family -> pending grant; the deleter then requests
    // that family, creating the exact grant/family cycle.
    const activationFixture = await createActivationDeleteFixture("Activation deletion ordering");
    const counterDeleteClient = await pool.connect();
    const counterActivationClient = await pool.connect();
    let counterDeleteOpen = false;
    let counterActivationOpen = false;
    let counterDeleteFamily;
    let counterActivationGrant;
    try {
      const deletePid = Number((await counterDeleteClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const activationPid = Number((await counterActivationClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await counterDeleteClient.query("SET deadlock_timeout='8s'");
      await counterActivationClient.query("SET deadlock_timeout='8s'");
      await counterDeleteClient.query("SET lock_timeout='12s'");
      await counterActivationClient.query("SET lock_timeout='12s'");
      await counterDeleteClient.query("BEGIN");
      counterDeleteOpen = true;
      await counterDeleteClient.query("SELECT id FROM blueprint_groups WHERE id=$1 FOR UPDATE", [activationFixture.oldGroupId]);
      await counterDeleteClient.query("SELECT id FROM versekit_device_grants WHERE id=$1 FOR UPDATE", [activationFixture.pendingGrant.id]);
      await counterActivationClient.query("BEGIN");
      counterActivationOpen = true;
      await counterActivationClient.query("SELECT id FROM versekit_token_families WHERE id=$1 FOR UPDATE", [activationFixture.familyId]);
      counterDeleteFamily = counterDeleteClient.query("SELECT id FROM versekit_token_families WHERE id=$1 FOR UPDATE", [activationFixture.familyId]);
      counterDeleteFamily.catch(() => {});
      const deleteFamilyWait = await waitFor(monitor, "counterfactual group cascade waits on activation-held family",
        (row) => Number(row.pid) === deletePid && row.query.includes("versekit_token_families") && row.query.includes("FOR UPDATE"));
      assert.ok(deleteFamilyWait.blockers.map(Number).includes(activationPid));
      counterActivationGrant = counterActivationClient.query("SELECT id FROM versekit_device_grants WHERE id=$1 FOR UPDATE", [activationFixture.pendingGrant.id]);
      counterActivationGrant.catch(() => {});
      const activationGrantWait = await waitFor(monitor, "counterfactual activation waits on cascade-held grant",
        (row) => Number(row.pid) === activationPid && row.query.includes("versekit_device_grants") && row.query.includes("FOR UPDATE"));
      assert.ok(activationGrantWait.blockers.map(Number).includes(deletePid));
      const counterfactual = await Promise.allSettled([counterDeleteFamily, counterActivationGrant]);
      assert.ok(counterfactual.some((result) => result.status === "rejected" && result.reason?.code === "40P01"),
        "PostgreSQL detects the original family/grant lock inversion with 40P01");
    } finally {
      if (counterDeleteOpen) await counterDeleteClient.query("ROLLBACK").catch(() => {});
      if (counterActivationOpen) await counterActivationClient.query("ROLLBACK").catch(() => {});
      await counterDeleteFamily?.catch(() => {});
      await counterActivationGrant?.catch(() => {});
      counterDeleteClient.release();
      counterActivationClient.release();
    }

    // Activation-first: hold the real production activation after its parent
    // group lock, then prove the production delete route blocks on that PID.
    let releaseActivationParent;
    const activationParentEntered = (() => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; })();
    const activationParentGate = new Promise((resolve) => { releaseActivationParent = resolve; });
    const activationParentDb = {
      query: (...args) => pool.query(...args),
      async connect() {
        const client = await pool.connect();
        const pid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        return {
          async query(sql, params) {
            const result = await client.query(sql, params);
            if (typeof sql === "string" && sql.includes("FROM blueprint_groups WHERE id=$1 FOR KEY SHARE")
                && params?.[0] === activationFixture.oldGroupId) {
              activationParentEntered.resolve(pid);
              await activationParentGate;
            }
            return result;
          },
          release: () => client.release()
        };
      }
    };
    let activationFirstDelete;
    let activationFirstConfig;
    try {
      activationFirstConfig = activateVersekitAuthorizationGroup(activationParentDb, activationFixture.targetGroupId);
      activationFirstConfig.catch(() => {});
      const activationPid = await Promise.race([
        activationParentEntered.promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("activation-first did not acquire the old group parent lock")), 5_000))
      ]);
      activationFirstDelete = apiRequest(runtime.baseUrl, "/api/groups/delete", {
        method: "POST", session: activationFixture.sessionCookie, form: { group_id: activationFixture.oldGroupId }
      });
      activationFirstDelete.catch(() => {});
      const deleteWait = await waitFor(monitor, "group deletion waits for activation's parent lock",
        (row) => row.query.includes("DELETE FROM blueprint_groups"));
      const deletePid = Number(deleteWait.pid);
      assert.ok(deleteWait.blockers.map(Number).includes(activationPid), "production group deletion waits on the activation transaction's parent lock");
      releaseActivationParent();
      const [activated, deleted] = await Promise.all([activationFirstConfig, activationFirstDelete]);
      assert.equal(activated, undefined);
      assert.equal(deleted.status, 200);
      assert.equal((await pool.query("SELECT group_id FROM versekit_authorization_config WHERE id=true")).rows[0].group_id, activationFixture.targetGroupId);
      assert.equal((await pool.query("SELECT 1 FROM blueprint_groups WHERE id=$1", [activationFixture.oldGroupId])).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM versekit_token_families WHERE id=$1", [activationFixture.familyId])).rowCount, 0);
      assert.equal(await activationFixture.oldStore.authenticateAccess(activationFixture.pair.access_token), null);
      assert.deepEqual(await activationFixture.oldStore.refresh({ refreshToken: activationFixture.pair.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [activationFixture.pendingGrant.id])).rowCount, 0);
    } finally {
      releaseActivationParent();
      await activationFirstConfig?.catch(() => {});
      await activationFirstDelete?.catch(() => {});
    }

    // Deletion-first: a trigger pauses the real DELETE after the group tuple is
    // locked. Activation must wait on that parent, then switch safely after
    // the cascade removes the old group's grants and families.
    const deletionFirstFixture = await createActivationDeleteFixture("Deletion-first activation ordering");
    const activationDeleteAdvisory = await pool.connect();
    let activationDeleteAdvisoryHeld = false;
    let deletionFirstDelete;
    let deletionFirstConfig;
    try {
      await pool.query(`CREATE FUNCTION vk04_pause_activation_group_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(27182,434); RETURN OLD; END $$`);
      await pool.query("CREATE TRIGGER vk04_pause_activation_group_delete BEFORE DELETE ON blueprint_groups FOR EACH ROW EXECUTE FUNCTION vk04_pause_activation_group_delete()");
      const advisoryPid = Number((await activationDeleteAdvisory.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await activationDeleteAdvisory.query("SELECT pg_advisory_lock(27182,434)");
      activationDeleteAdvisoryHeld = true;
      deletionFirstDelete = apiRequest(runtime.baseUrl, "/api/groups/delete", {
        method: "POST", session: deletionFirstFixture.sessionCookie, form: { group_id: deletionFirstFixture.oldGroupId }
      });
      deletionFirstDelete.catch(() => {});
      const deleteWait = await waitFor(monitor, "deletion-first group delete pauses after acquiring its parent lock",
        (row) => row.query.includes("DELETE FROM blueprint_groups"));
      const deletePid = Number(deleteWait.pid);
      assert.ok(deleteWait.blockers.map(Number).includes(advisoryPid), "test trigger holds the production deletion transaction after parent lock acquisition");
      deletionFirstConfig = activateVersekitAuthorizationGroup(pool, deletionFirstFixture.targetGroupId);
      deletionFirstConfig.catch(() => {});
      const activationWait = await waitFor(monitor, "configuration activation waits on deleting old group parent",
        (row) => row.query.includes("FOR KEY SHARE") && row.blockers.map(Number).includes(deletePid));
      assert.ok(activationWait.blockers.map(Number).includes(deletePid), "pg_blocking_pids identifies the production deletion as activation blocker");
      await activationDeleteAdvisory.query("SELECT pg_advisory_unlock(27182,434)");
      activationDeleteAdvisoryHeld = false;
      const [deleted, activated] = await Promise.all([deletionFirstDelete, deletionFirstConfig]);
      assert.equal(deleted.status, 200);
      assert.equal(activated, undefined);
      assert.equal((await pool.query("SELECT group_id FROM versekit_authorization_config WHERE id=true")).rows[0].group_id, deletionFirstFixture.targetGroupId);
      assert.equal((await pool.query("SELECT 1 FROM blueprint_groups WHERE id=$1", [deletionFirstFixture.oldGroupId])).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE group_id=$1", [deletionFirstFixture.oldGroupId])).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM versekit_token_families WHERE group_id=$1", [deletionFirstFixture.oldGroupId])).rowCount, 0);
      assert.equal(await deletionFirstFixture.oldStore.authenticateAccess(deletionFirstFixture.pair.access_token), null);
      assert.deepEqual(await deletionFirstFixture.oldStore.refresh({ refreshToken: deletionFirstFixture.pair.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });
    } finally {
      if (activationDeleteAdvisoryHeld) await activationDeleteAdvisory.query("SELECT pg_advisory_unlock(27182,434)").catch(() => {});
      await deletionFirstDelete?.catch(() => {});
      await deletionFirstConfig?.catch(() => {});
      activationDeleteAdvisory.release();
      await pool.query("DROP TRIGGER IF EXISTS vk04_pause_activation_group_delete ON blueprint_groups").catch(() => {});
      await pool.query("DROP FUNCTION IF EXISTS vk04_pause_activation_group_delete()").catch(() => {});
    }

    // Account deletion removes memberships before deleting the app_user row,
    // whose FK cascades into VerseKit credentials. Pause the real membership
    // DELETE after it has locked its row, then run real authorization through
    // the same group/family/user/membership lock path.
    const accountFixture = await setupGroup("Account deletion lock-order group");
    const accountTargetId = randomUUID();
    const adminId = randomUUID();
    await pool.query("INSERT INTO app_users(id,email,display_name,account_status) VALUES($1,$2,'Account test member','active'),($3,$4,'Account test admin','active')",
      [accountTargetId, `vk04-member-${accountTargetId}@example.test`, adminId, `vk04-admin-${adminId}@example.test`]);
    await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'member')", [accountFixture.groupId, accountTargetId]);
    const accountTargetGrant = accountFixture.grant;
    assert.equal(await accountFixture.targetStore.consent({ grantId: accountTargetGrant.id, userId: accountTargetId, scopes: ["orders:read"], approve: true }), true);
    const accountTargetPair = (await accountFixture.targetStore.exchangeDeviceCode({ deviceCode: accountTargetGrant.deviceCode, clientId: "versekit" })).tokens;
    assert.ok(accountTargetPair);
    const ownerGrant = await accountFixture.targetStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    assert.equal(await accountFixture.targetStore.consent({ grantId: ownerGrant.id, userId, scopes: ["orders:read"], approve: true }), true);
    const ownerPair = (await accountFixture.targetStore.exchangeDeviceCode({ deviceCode: ownerGrant.deviceCode, clientId: "versekit" })).tokens;
    assert.ok(ownerPair);
    const adminSession = await createSession(pool, pepper, adminId);
    await stopMissionTestServer(runtime);
    runtime = await startMissionTestServer({ databaseUrl, pepper, extraEnv: { VERSEKIT_ENABLED: "false", APP_ADMIN_USER_IDS: adminId } });
    const accountAdvisory = await pool.connect();
    let accountAdvisoryHeld = false;
    let accountDeletion;
    let accountAuthorization;
    try {
      await pool.query(`CREATE FUNCTION vk04_pause_account_membership_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(27182,432); RETURN OLD; END $$`);
      await pool.query("CREATE TRIGGER vk04_pause_account_membership_delete AFTER DELETE ON group_members FOR EACH ROW EXECUTE FUNCTION vk04_pause_account_membership_delete()");
      const advisoryPid = Number((await accountAdvisory.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await accountAdvisory.query("SELECT pg_advisory_lock(27182,432)");
      accountAdvisoryHeld = true;
      accountDeletion = apiRequest(runtime.baseUrl, "/api/admin/users/delete", { method: "POST", session: adminSession, form: { user_id: accountTargetId } });
      accountDeletion.catch(() => {});
      const membershipDelete = await waitFor(monitor, "account deletion holds the target membership row",
        (row) => row.query.includes("DELETE FROM group_members WHERE app_user_id"));
      const deletePid = Number(membershipDelete.pid);
      assert.ok(membershipDelete.blockers.map(Number).includes(advisoryPid), "test trigger pauses the real account-delete membership cascade deterministically");
      accountAuthorization = accountFixture.targetStore.authorizeAccess(accountTargetPair.access_token, { operation: "orders:read" });
      accountAuthorization.catch(() => {});
      const authWaiter = await waitFor(monitor, "authorization waits on account deletion membership removal",
        (row) => row.query.includes("FOR KEY SHARE") && row.query.includes("blueprint_groups"));
      assert.ok(authWaiter.blockers.map(Number).includes(deletePid), "parent-first account deletion blocks authorization before it can lock dependent credentials");
      await accountAdvisory.query("SELECT pg_advisory_unlock(27182,432)");
      accountAdvisoryHeld = false;
      const settled = await Promise.race([
        Promise.allSettled([accountDeletion, accountAuthorization]),
        new Promise((_, reject) => setTimeout(() => reject(new Error("account deletion and authorization race did not settle")), 10_000))
      ]);
      const deadlock = settled.find((result) => result.status === "rejected" && result.reason?.code === "40P01");
      assert.equal(deadlock, undefined, "account deletion and authorization complete without PostgreSQL deadlock");
      assert.equal(settled[0].status, "fulfilled");
      assert.equal(settled[0].value.status, 200, "real account deletion completes");
      assert.equal(settled[1].status, "fulfilled");
      assert.equal(settled[1].value.allowed, false, "authorization fails closed after membership/account deletion");
      assert.equal((await pool.query("SELECT 1 FROM app_users WHERE id=$1", [accountTargetId])).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM blueprint_groups WHERE id=$1", [accountFixture.groupId])).rowCount, 1,
        "deleting a non-owner account preserves the unrelated group");
      assert.equal((await accountFixture.targetStore.authorizeAccess(ownerPair.access_token, { operation: "orders:read" })).allowed, true,
        "another account's credential in the same surviving group is unaffected");
      assert.equal((await pool.query("SELECT 1 FROM versekit_token_families WHERE app_user_id=$1", [accountTargetId])).rowCount, 0,
        "account FK cascade removes the deleted member's credential family");
    } finally {
      if (accountAdvisoryHeld) await accountAdvisory.query("SELECT pg_advisory_unlock(27182,432)").catch(() => {});
      await accountDeletion?.catch(() => {});
      await accountAuthorization?.catch(() => {});
      accountAdvisory.release();
      await pool.query("DROP TRIGGER IF EXISTS vk04_pause_account_membership_delete ON group_members").catch(() => {});
      await pool.query("DROP FUNCTION IF EXISTS vk04_pause_account_membership_delete()").catch(() => {});
    }

    // Invite acceptance used to lock the child invite before its FK checked
    // the parent group. Exercise it against the real group-deletion route.
    const inviteFixture = await setupGroup("Invite cascade lock-order group");
    const inviteeId = randomUUID();
    await pool.query("INSERT INTO app_users(id,email,display_name,account_status) VALUES($1,$2,'Invitee','active')",
      [inviteeId, `vk04-invitee-${inviteeId}@example.test`]);
    const inviteeSession = await createSession(pool, pepper, inviteeId);
    const inviteResponse = await apiRequest(runtime.baseUrl, "/api/invites", {
      method: "POST", session: inviteFixture.sessionCookie, form: { group_id: inviteFixture.groupId }
    });
    assert.equal(inviteResponse.status, 201);
    const inviteAdvisory = await pool.connect();
    let inviteAdvisoryHeld = false;
    let groupDeletion;
    let inviteJoin;
    try {
      await pool.query(`CREATE FUNCTION vk04_pause_invite_group_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(27182,433); RETURN OLD; END $$`);
      await pool.query("CREATE TRIGGER vk04_pause_invite_group_delete BEFORE DELETE ON blueprint_groups FOR EACH ROW EXECUTE FUNCTION vk04_pause_invite_group_delete()");
      const advisoryPid = Number((await inviteAdvisory.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await inviteAdvisory.query("SELECT pg_advisory_lock(27182,433)");
      inviteAdvisoryHeld = true;
      groupDeletion = apiRequest(runtime.baseUrl, "/api/groups/delete", {
        method: "POST", session: inviteFixture.sessionCookie, form: { group_id: inviteFixture.groupId }
      });
      groupDeletion.catch(() => {});
      const deleteWaiter = await waitFor(monitor, "group deletion pauses after acquiring parent lock",
        (row) => row.query.includes("DELETE FROM blueprint_groups"));
      const deletePid = Number(deleteWaiter.pid);
      assert.ok(deleteWaiter.blockers.map(Number).includes(advisoryPid));
      inviteJoin = apiRequest(runtime.baseUrl, "/api/invites/join", {
        method: "POST", session: inviteeSession, form: { invite: inviteResponse.body.invite }
      });
      inviteJoin.catch(() => {});
      const joinWaiter = await waitFor(monitor, "invite join waits for parent group before locking child invite",
        (row) => row.query.includes("FOR KEY SHARE") && row.query.includes("blueprint_groups"));
      assert.ok(joinWaiter.blockers.map(Number).includes(deletePid), "invite acceptance waits on the actual group DELETE before it owns the invite row");
      await inviteAdvisory.query("SELECT pg_advisory_unlock(27182,433)");
      inviteAdvisoryHeld = false;
      const [deleted, joined] = await Promise.all([groupDeletion, inviteJoin]);
      assert.equal(deleted.status, 200);
      assert.equal(joined.status, 400, "invite cannot join a group after its parent was deleted");
      assert.equal((await pool.query("SELECT 1 FROM blueprint_groups WHERE id=$1", [inviteFixture.groupId])).rowCount, 0);
      assert.equal((await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND app_user_id=$2", [inviteFixture.groupId, inviteeId])).rowCount, 0);
    } finally {
      if (inviteAdvisoryHeld) await inviteAdvisory.query("SELECT pg_advisory_unlock(27182,433)").catch(() => {});
      await groupDeletion?.catch(() => {});
      await inviteJoin?.catch(() => {});
      inviteAdvisory.release();
      await pool.query("DROP TRIGGER IF EXISTS vk04_pause_invite_group_delete ON blueprint_groups").catch(() => {});
      await pool.query("DROP FUNCTION IF EXISTS vk04_pause_invite_group_delete()").catch(() => {});
    }
    await stopMissionTestServer(runtime);
    runtime = null;
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors = [];
    const captureCleanup = async (description, action) => {
      try { await action(); }
      catch (error) { cleanupErrors.push(`${description}: ${error?.stack || error}`); }
    };
    if (blockerInTransaction) await captureCleanup("rollback blocker transaction", () => blocker.query("ROLLBACK"));
    await captureCleanup("release blocker client", async () => blocker?.release());
    await captureCleanup("settle revocation", async () => { if (revocation) await revocation; });
    await captureCleanup("settle authorization", async () => { if (authorization) await authorization; });
    await captureCleanup("stop HTTP test server", () => stopMissionTestServer(runtime));
    await captureCleanup("close monitor pool", async () => { if (monitor) await monitor.end(); });
    await captureCleanup("close application pool", async () => { if (pool) await pool.end(); });
    if (databaseCreated) {
      let residualSessions = [];
      await captureCleanup("inspect remaining PostgreSQL sessions", async () => {
        const snapshot = await databaseAdmin.query(
          "SELECT pid,application_name,backend_type,state,wait_event_type,wait_event,backend_xid,query_start,left(query,500) AS query FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid() ORDER BY pid",
          [databaseName]
        );
        residualSessions = snapshot.rows;
      });
      if (residualSessions.length) {
        const diagnostic = JSON.stringify(residualSessions);
        console.error(`[vk04 lock-order cleanup] residual sessions after owned server and pools closed: ${diagnostic}`);
        await captureCleanup("terminate orphan sessions after recording diagnostics", async () => {
          await databaseAdmin.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid=ANY($2::int[]) AND pid<>pg_backend_pid()",
            [databaseName, residualSessions.map((row) => Number(row.pid))]
          );
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            const remaining = await databaseAdmin.query(
              "SELECT pid,application_name,state,wait_event_type,wait_event FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid() ORDER BY pid",
              [databaseName]
            );
            if (!remaining.rowCount) return;
            await new Promise((resolve) => setImmediate(resolve));
          }
          throw new Error(`orphan PostgreSQL sessions did not exit: ${diagnostic}`);
        });
      }
      await captureCleanup("drop disposable regression database", () => databaseAdmin.query(`DROP DATABASE IF EXISTS "${databaseName}"`));
    }
    await captureCleanup("close databaseAdmin pool", async () => { await databaseAdmin.end(); });
    if (poolErrors.length) {
      cleanupErrors.push(`PostgreSQL pool error events: ${poolErrors.map(({ name, error }) => `${name}: ${error?.stack || error}`).join("\n")}`);
    }
    if (cleanupErrors.length) {
      const cleanupDiagnostic = cleanupErrors.join("\n");
      if (primaryError) primaryError.message += `\nCleanup diagnostics (original test failure preserved):\n${cleanupDiagnostic}`;
      else throw new Error(`PostgreSQL test cleanup failed:\n${cleanupDiagnostic}`);
    }
  }
});
