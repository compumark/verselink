import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTokenCodec } from "../src/integrations/versekit/tokens.js";
import { createOrdersCursorCodec } from "../src/integrations/versekit/orders.js";
import { VersekitTokenStore } from "../src/integrations/versekit/store.js";
import { activateVersekitAuthorizationGroup, initializeVersekitSchema } from "../src/integrations/versekit/schema.js";
import { assessLegacyVersekitCredentials, assertLegacyCleanupQuiesced, revokeLegacyVersekitCredentials } from "../scripts/versekit-legacy-credentials.js";
import { resolveC6TestDatabaseUrl } from "./helpers/c6-test-database.js";
import { createSession, createTestPool, startMissionTestServer, stopMissionTestServer } from "./helpers/mission-integration.js";

const SINK_PEPPER = "vk10-existing-sink-key-for-legacy-credential-fixture";
const VERSEKIT_PEPPER = "vk10-independent-versekit-key-for-new-credential-fixture";
const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const CLEANUP_SCRIPT = fileURLToPath(new URL("../scripts/versekit-legacy-credentials.js", import.meta.url));
const cleanupCli = (databaseUrl, versekitEnabled, args) => spawnSync(process.execPath, [CLEANUP_SCRIPT, ...args], {
  encoding: "utf8",
  env: { ...process.env, DATABASE_URL: databaseUrl, VERSEKIT_ENABLED: versekitEnabled }
});

test("VerseKit codecs are independent from the Sink key in both directions", () => {
  const first = createTokenCodec(VERSEKIT_PEPPER);
  const second = createTokenCodec(VERSEKIT_PEPPER);
  const anotherSinkKey = createTokenCodec("vk10-a-different-sink-key-but-not-used-by-versekit");
  assert.equal(first.hash("access", "vka_example"), second.hash("access", "vka_example"));
  assert.notEqual(first.hash("access", "vka_example"), anotherSinkKey.hash("access", "vka_example"));
  const cursor = createOrdersCursorCodec(VERSEKIT_PEPPER);
  const changedVersekitKey = createOrdersCursorCodec(`${VERSEKIT_PEPPER}-rotated`);
  const payload = { v: 1, g: GROUP_ID, scope: "orders:read",
    s: { created: "2026-11-19T10:00:00.123456Z", id: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
    l: { created: "2026-11-19T09:00:00.123456Z", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } };
  const signed = cursor.encode(payload, GROUP_ID);
  assert.deepEqual(createOrdersCursorCodec(VERSEKIT_PEPPER).decode(signed, GROUP_ID), payload);
  assert.equal(changedVersekitKey.decode(signed, GROUP_ID), null);
});

test("manual legacy cleanup requires an explicitly disabled and quiesced VerseKit deployment", () => {
  assert.throws(() => assertLegacyCleanupQuiesced({ versekitEnabled: "true", allInstancesQuiesced: true }), /VERSEKIT_ENABLED=false/);
  assert.throws(() => assertLegacyCleanupQuiesced({ versekitEnabled: "false", allInstancesQuiesced: false }), /every VerseLink instance/);
  assert.doesNotThrow(() => assertLegacyCleanupQuiesced({ versekitEnabled: "false", allInstancesQuiesced: true }));
});

test("PostgreSQL cleanup preflight blocks active instances and quiesced apply is scoped, idempotent and rollback-safe", {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60_000
}, async () => {
  const { default: pg } = await import("pg");
  const safeUrl = resolveC6TestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const databaseName = `vk10_cleanup_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(safeUrl); adminUrl.pathname = "/postgres";
  const admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 2 });
  let created = false;
  let pool;
  let runtime;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    const databaseUrl = new URL(safeUrl); databaseUrl.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 8 });

    assert.deepEqual(await assessLegacyVersekitCredentials(pool), {
      schemaPresent: false, active_families: 0, active_tokens: 0, undecided_grants: 0, live_challenges: 0
    }, "an installation with no VerseKit schema is a read-only no-op");
    assert.deepEqual(await revokeLegacyVersekitCredentials(pool, { versekitEnabled: "false", allInstancesQuiesced: true }), {
      schemaPresent: false, revoked_families: 0, revoked_tokens: 0, denied_grants: 0, expired_challenges: 0
    });

    runtime = await startMissionTestServer({ databaseUrl: databaseUrl.toString(), pepper: "short-sink-vk10", extraEnv: {
      VERSEKIT_ENABLED: "false", VERSEKIT_TOKEN_PEPPER: "", VERSELINK_APP_URL: "http://localhost:3000"
    } });
    const userId = randomUUID();
    await pool.query("INSERT INTO app_users(id,email,display_name,account_status) VALUES($1,$2,'Legacy Test Member','active')",
      [userId, `vk10-${userId}@example.test`]);
    await pool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,'VK10 Cleanup Org')", [GROUP_ID]);
    await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'owner')", [GROUP_ID, userId]);
    const sessionToken = await createSession(pool, "short-sink-vk10", userId);
    await initializeVersekitSchema(pool);
    await activateVersekitAuthorizationGroup(pool, GROUP_ID);

    const legacyCodec = createTokenCodec(SINK_PEPPER);
    const legacyStore = new VersekitTokenStore({ db: pool, codec: legacyCodec, groupId: GROUP_ID, operationalScopes: ["orders:read"] });
    const pending = await legacyStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    const challenge = await legacyStore.createConsentChallenge({
      userCode: pending.userCode, userId,
      sessionHash: legacyCodec.hash("browser_session", sessionToken)
    });
    assert.ok(challenge, "legacy consent challenge fixture exists");

    // Obtain a real CSRF value while the legacy VerseKit key is active, then
    // stop that adapter before running any manual maintenance operation.
    await stopMissionTestServer(runtime); runtime = null;
    runtime = await startMissionTestServer({ databaseUrl: databaseUrl.toString(), pepper: "short-sink-vk10", extraEnv: {
      VERSEKIT_ENABLED: "true", VERSEKIT_GROUP_ID: GROUP_ID, VERSEKIT_PUBLIC_URL: "https://verse.example.org",
      VERSEKIT_TOKEN_PEPPER: SINK_PEPPER, VERSELINK_APP_URL: "http://localhost:3000"
    } });
    const legacyConsentResponse = await fetch(`${runtime.baseUrl}/device`, { headers: { cookie: `bp_session=${sessionToken}` } });
    assert.equal(legacyConsentResponse.status, 200);
    const legacyConsentHtml = await legacyConsentResponse.text();
    const legacyCsrf = /name="csrf" value="([^"]+)"/.exec(legacyConsentHtml)?.[1];
    assert.ok(legacyCsrf, "legacy-key consent page issues a CSRF challenge");
    await stopMissionTestServer(runtime); runtime = null;

    // Maintenance runs beside a restarted VerseLink process with the adapter
    // disabled. That process has no VerseKit cleanup timer or HTTP routes.
    runtime = await startMissionTestServer({ databaseUrl: databaseUrl.toString(), pepper: "short-sink-vk10", extraEnv: {
      VERSEKIT_ENABLED: "false", VERSEKIT_TOKEN_PEPPER: "", VERSELINK_APP_URL: "http://localhost:3000"
    } });
    assert.equal((await fetch(`${runtime.baseUrl}/versekit/v1/device/code`, { method: "POST" })).status, 404);

    const newStore = new VersekitTokenStore({ db: pool, codec: createTokenCodec(VERSEKIT_PEPPER), groupId: GROUP_ID, operationalScopes: ["orders:read"] });
    const newSessionHash = newStore.codec.hash("browser_session", sessionToken);
    assert.equal(await newStore.decideConsent({
      challenge: challenge.challenge, userId, sessionHash: newSessionHash, scopes: ["orders:read"], approve: true
    }), false, "pepper B cannot accept a consent challenge created with pepper A before cleanup");
    assert.notEqual(legacyCodec.hash("csrf", "legacy-payload"), newStore.codec.hash("csrf", "legacy-payload"),
      "CSRF signatures are purpose-separated under independent key material");
    const freshGrant = await newStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    const freshChallenge = await newStore.createConsentChallenge({ userCode: freshGrant.userCode, userId, sessionHash: newSessionHash });
    assert.ok(freshChallenge, "pepper B creates a fresh consent challenge");
    assert.equal(await newStore.decideConsent({
      challenge: freshChallenge.challenge, userId, sessionHash: newSessionHash, scopes: ["orders:read"], approve: true
    }), true, "pepper B accepts its own fresh consent challenge");

    const approved = await legacyStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    assert.equal(await legacyStore.consent({ grantId: approved.id, userId, scopes: ["orders:read"], approve: true }), true);
    const issued = await legacyStore.exchangeDeviceCode({ deviceCode: approved.deviceCode, clientId: "versekit" });
    assert.ok(issued.tokens);
    assert.equal((await legacyStore.authorizeAccess(issued.tokens.access_token, { operation: "orders:read" })).allowed, true,
      "the former shared-key credential would be valid if the old image were restored without cleanup");

    const before = await assessLegacyVersekitCredentials(pool);
    assert.equal(before.schemaPresent, true);
    assert.equal(before.active_families, 1);
    assert.equal(before.active_tokens, 2);
    assert.equal(before.undecided_grants, 2);
    assert.equal(before.live_challenges, 1);
    const stillBefore = await pool.query("SELECT revoked_at FROM versekit_token_families WHERE id=(SELECT family_id FROM versekit_tokens WHERE token_hash=$1 AND token_type='access')",
      [legacyCodec.hash("access", issued.tokens.access_token)]);
    assert.equal(stillBefore.rows[0].revoked_at, null, "dry-run changes no credential rows");

    assert.equal(await newStore.authenticateAccess(issued.tokens.access_token), null, "the new key rejects a legacy access token");
    assert.deepEqual(await newStore.refresh({ refreshToken: issued.tokens.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });

    const activeInstanceAttempt = cleanupCli(databaseUrl.toString(), "true", [
      "--apply", "--confirm-versekit-only-revocation", "--confirm-all-versekit-instances-quiesced"
    ]);
    assert.equal(activeInstanceAttempt.status, 1, "CLI refuses apply when its environment says VerseKit is enabled");
    assert.match(activeInstanceAttempt.stderr, /Set VERSEKIT_ENABLED=false/);
    assert.equal((await pool.query("SELECT revoked_at FROM versekit_token_families WHERE id=(SELECT family_id FROM versekit_tokens WHERE token_hash=$1 AND token_type='access')",
      [legacyCodec.hash("access", issued.tokens.access_token)])).rows[0].revoked_at, null,
    "the active-instance guard leaves credential rows untouched");

    const dryRun = cleanupCli(databaseUrl.toString(), "false", ["--dry-run"]);
    assert.equal(dryRun.status, 0, "read-only assessment is available once the instance is disabled");
    assert.equal(JSON.parse(dryRun.stdout).mode, "dry-run");
    const applyCli = cleanupCli(databaseUrl.toString(), "false", [
      "--apply", "--confirm-versekit-only-revocation", "--confirm-all-versekit-instances-quiesced"
    ]);
    assert.equal(applyCli.status, 0, applyCli.stderr);
    const applied = JSON.parse(applyCli.stdout);
    assert.deepEqual(applied, {
      mode: "apply", schemaPresent: true, revoked_families: 1, revoked_tokens: 2, denied_grants: 2, expired_challenges: 1
    });
    assert.equal(await legacyStore.authenticateAccess(issued.tokens.access_token), null, "rollback to the former key cannot reactivate access");
    assert.deepEqual(await legacyStore.refresh({ refreshToken: issued.tokens.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });
    assert.deepEqual(await legacyStore.exchangeDeviceCode({ deviceCode: pending.deviceCode, clientId: "versekit" }), { error: "access_denied" });
    assert.equal(await legacyStore.decideConsent({ challenge: challenge.challenge, userId, sessionHash: legacyCodec.hash("browser_session", sessionToken), scopes: ["orders:read"], approve: true }), false);
    assert.equal(await newStore.authenticateAccess(issued.tokens.access_token), null, "new-key verification also remains fail closed");
    assert.deepEqual(await revokeLegacyVersekitCredentials(pool, { versekitEnabled: "false", allInstancesQuiesced: true }), {
      schemaPresent: true, revoked_families: 0, revoked_tokens: 0, denied_grants: 0, expired_challenges: 0
    }, "the procedure can be repeated safely");

    const issuePair = async (store) => {
      const grant = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      assert.equal(await store.consent({ grantId: grant.id, userId, scopes: ["orders:read"], approve: true }), true);
      return (await store.exchangeDeviceCode({ deviceCode: grant.deviceCode, clientId: "versekit" })).tokens;
    };
    const currentTokens = await issuePair(newStore);
    assert.equal((await newStore.authorizeAccess(currentTokens.access_token, { operation: "orders:read" })).allowed, true);
    await stopMissionTestServer(runtime); runtime = null;
    runtime = await startMissionTestServer({ databaseUrl: databaseUrl.toString(), pepper: "short-sink-vk10", extraEnv: {
      VERSEKIT_ENABLED: "true", VERSEKIT_GROUP_ID: GROUP_ID, VERSEKIT_PUBLIC_URL: "https://verse.example.org", VERSEKIT_TOKEN_PEPPER: VERSEKIT_PEPPER,
      VERSELINK_APP_URL: "http://localhost:3000", SCMDB_SINK_BASE_URL: "https://sink.example.test/v1/scmdb"
    } });
    let consentPage = await fetch(`${runtime.baseUrl}/device`, { headers: { cookie: `bp_session=${sessionToken}` } });
    assert.match(await consentPage.text(), /<span>SIGNED IN AS<\/span><strong>Legacy Test Member<\/strong>/, "unchanged Sink pepper preserves the VerseLink browser session");

    const rejectedLegacyCsrf = await fetch(`${runtime.baseUrl}/device`, {
      method: "POST",
      headers: {
        cookie: `bp_session=${sessionToken}`,
        origin: "http://localhost:3000",
        "content-type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ action: "lookup", csrf: legacyCsrf, user_code: pending.userCode })
    });
    assert.equal(rejectedLegacyCsrf.status, 403, "pepper B rejects a CSRF signature generated under pepper A");

    const sinkConnectionResponse = await fetch(`${runtime.baseUrl}/api/profile/scmdb/connect`, {
      method: "POST", headers: { cookie: `bp_session=${sessionToken}` }
    });
    assert.equal(sinkConnectionResponse.status, 201);
    const sinkConnection = await sinkConnectionResponse.json();
    const sinkToken = sinkConnection.sink_token;
    const sinkTokenHash = createHmac("sha256", "short-sink-vk10").update(sinkToken).digest("hex");
    await pool.query("UPDATE scmdb_connections SET scmdb_user_id='vk10-user',connection_status='connected' WHERE token_hash=$1", [sinkTokenHash]);
    const duplicateEventId = `vk10-duplicate-${randomUUID()}`;
    await pool.query("INSERT INTO scmdb_events(event_id,token_hash,event_name,event_ts) VALUES($1,$2,'profile.snapshot',$3)",
      [duplicateEventId, sinkTokenHash, Date.now()]);
    const postSinkDuplicate = (baseUrl) => fetch(`${baseUrl}/v1/scmdb/${sinkToken}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema: 1, event_id: duplicateEventId, event: "profile.snapshot", ts: Date.now(),
        user: { id: "vk10-user", handle: "vk10" }, payload: {} })
    });
    assert.equal((await postSinkDuplicate(runtime.baseUrl)).status, 204,
      "an existing Sink-keyed SCMDB token authenticates before the VerseKit key changes");

    const publicLinkResponse = await fetch(`${runtime.baseUrl}/api/public-links`, {
      method: "POST", headers: { cookie: `bp_session=${sessionToken}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ group_id: GROUP_ID, label: "VK10 isolation test" })
    });
    assert.equal(publicLinkResponse.status, 201);
    const publicLink = await publicLinkResponse.json();
    const publicLinkToken = publicLink.token;
    const publicLinkHash = createHmac("sha256", "short-sink-vk10").update(`public-link:${publicLinkToken}`).digest("hex");
    assert.equal((await pool.query("SELECT 1 FROM public_group_links WHERE token_hash=$1", [publicLinkHash])).rowCount, 1);
    const publicLinks = await fetch(`${runtime.baseUrl}/api/public-links?group_id=${GROUP_ID}`, {
      headers: { cookie: `bp_session=${sessionToken}` }
    }).then((response) => response.json());
    assert.equal(publicLinks.links.find((link) => link.id === publicLink.link.id)?.public_path, `/public/${publicLinkToken}`,
      "public-link ciphertext still decrypts with the unchanged Sink pepper");
    assert.equal((await fetch(`${runtime.baseUrl}/api/public/groups/${publicLinkToken}/blueprints`)).status, 200,
      "public-link hash lookup still works with the unchanged Sink pepper");

    await stopMissionTestServer(runtime); runtime = null;

    const rotatedVersekitPepper = `${VERSEKIT_PEPPER}-rotated`;
    const rotatedStore = new VersekitTokenStore({ db: pool, codec: createTokenCodec(rotatedVersekitPepper), groupId: GROUP_ID, operationalScopes: ["orders:read"] });
    runtime = await startMissionTestServer({ databaseUrl: databaseUrl.toString(), pepper: "short-sink-vk10", extraEnv: {
      VERSEKIT_ENABLED: "true", VERSEKIT_GROUP_ID: GROUP_ID, VERSEKIT_PUBLIC_URL: "https://verse.example.org", VERSEKIT_TOKEN_PEPPER: rotatedVersekitPepper,
      VERSELINK_APP_URL: "http://localhost:3000", SCMDB_SINK_BASE_URL: "https://sink.example.test/v1/scmdb"
    } });
    consentPage = await fetch(`${runtime.baseUrl}/device`, { headers: { cookie: `bp_session=${sessionToken}` } });
    assert.match(await consentPage.text(), /<span>SIGNED IN AS<\/span><strong>Legacy Test Member<\/strong>/, "changing only the VerseKit key preserves the authenticated VerseLink member identity");
    assert.equal(await rotatedStore.authenticateAccess(currentTokens.access_token), null, "VerseKit key rotation rejects old access credentials");
    assert.deepEqual(await rotatedStore.refresh({ refreshToken: currentTokens.refresh_token, clientId: "versekit" }), { error: "invalid_grant" },
      "VerseKit key rotation rejects old refresh credentials");
    assert.equal((await postSinkDuplicate(runtime.baseUrl)).status, 204,
      "the existing SCMDB token remains usable when only the VerseKit key changes");
    const publicLinksAfterRotation = await fetch(`${runtime.baseUrl}/api/public-links?group_id=${GROUP_ID}`, {
      headers: { cookie: `bp_session=${sessionToken}` }
    }).then((response) => response.json());
    assert.equal(publicLinksAfterRotation.links.find((link) => link.id === publicLink.link.id)?.public_path, `/public/${publicLinkToken}`);
    assert.equal((await fetch(`${runtime.baseUrl}/api/public/groups/${publicLinkToken}/blueprints`)).status, 200);
    const rotatedTokens = await issuePair(rotatedStore);
    await stopMissionTestServer(runtime); runtime = null;

    runtime = await startMissionTestServer({ databaseUrl: databaseUrl.toString(), pepper: "another-short-sink-vk10", extraEnv: {
      VERSEKIT_ENABLED: "true", VERSEKIT_GROUP_ID: GROUP_ID, VERSEKIT_PUBLIC_URL: "https://verse.example.org", VERSEKIT_TOKEN_PEPPER: rotatedVersekitPepper,
      SCMDB_SINK_BASE_URL: "https://sink.example.test/v1/scmdb"
    } });
    consentPage = await fetch(`${runtime.baseUrl}/device`, { headers: { cookie: `bp_session=${sessionToken}` } });
    assert.match(await consentPage.text(), /href="\/login"/, "changing only the Sink key keeps its established session invalidation behavior");
    assert.equal((await rotatedStore.authorizeAccess(rotatedTokens.access_token, { operation: "orders:read" })).allowed, true,
      "changing only the Sink key leaves VerseKit grants under its unchanged key valid");
    assert.equal((await fetch(`${runtime.baseUrl}/versekit/v1/orders?limit=1`, {
      headers: { authorization: `Bearer ${rotatedTokens.access_token}` }
    })).status, 200, "the live VerseKit adapter still accepts its token after only the Sink key changes");
    assert.equal(rotatedStore.codec.hash("access", rotatedTokens.access_token),
      createTokenCodec(rotatedVersekitPepper).hash("access", rotatedTokens.access_token),
      "VerseKit token hashes remain under the unchanged VerseKit key");
    assert.equal((await postSinkDuplicate(runtime.baseUrl)).status, 401,
      "changing the Sink pepper retains its established SCMDB-token invalidation behavior");
    assert.equal((await fetch(`${runtime.baseUrl}/api/public/groups/${publicLinkToken}/blueprints`)).status, 404,
      "changing the Sink pepper retains its established public-link lookup invalidation behavior");

    const sessionHash = createHmac("sha256", "short-sink-vk10").update(`session:${sessionToken}`).digest("hex");
    assert.equal((await pool.query("SELECT 1 FROM dashboard_sessions WHERE session_hash=$1", [sessionHash])).rowCount, 1,
      "ordinary VerseLink session remains unchanged");
    assert.equal((await pool.query("SELECT 1 FROM blueprint_groups WHERE id=$1", [GROUP_ID])).rowCount, 1,
      "business group data remains unchanged");
  } finally {
    await stopMissionTestServer(runtime);
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
});
