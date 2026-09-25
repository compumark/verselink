import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { hashDeviceCredential, hashPairingCode, normalizePairingCode, generatePairingCode } from "../src/telemetry-pairing.js";
import {
  apiRequest,
  createSession,
  createTestPool,
  startMissionTestServer,
  stopMissionTestServer
} from "./helpers/mission-integration.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pepper = "telemetry-pairing-integration-test-pepper";
const creationPath = "/api/me/telemetry/pairing";
const claimPath = "/api/telemetry/pair";

const rawRequest = async (baseUrl, path, { session, body, contentType = "application/json", origin } = {}) => {
  const headers = {};
  if (session) headers.cookie = `bp_session=${session}`;
  if (contentType) headers["content-type"] = contentType;
  if (origin) headers.origin = origin;
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, body: payload, headers: response.headers };
};

const makeBody = (value) => ({ method: "POST", json: value });

test("C3 pairing creation, claim, lifecycle, rate limits, and secret handling use PostgreSQL and HTTP", { skip: !databaseUrl }, async (t) => {
  let adminPool;
  let pool;
  let runtime;
  let rateRuntime;
  let schemaName;
  const secrets = [];
  const serverOutput = [];
  const ids = {
    admin: randomUUID(),
    owner: randomUUID(),
    secondOwner: randomUUID(),
    malformedOwner: randomUUID(),
    limitedOwner: randomUUID(),
    lifecycleOwner: randomUUID()
  };
  const extraEnv = { APP_ADMIN_USER_IDS: ids.admin, LOG_LEVEL: "DEBUG", VERSELINK_APP_URL: "https://verselink.example.test" };
  try {
    adminPool = await createTestPool(databaseUrl);
    schemaName = `c3_pairing_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.searchParams.set("options", `-c search_path=${schemaName},public`);
    const scopedDatabaseUrl = isolatedUrl.toString();

    runtime = await startMissionTestServer({ databaseUrl: scopedDatabaseUrl, pepper, extraEnv });
    serverOutput.push(...runtime.output);
    await stopMissionTestServer(runtime);
    runtime = null;
    pool = await createTestPool(scopedDatabaseUrl);
    await pool.query(
      `INSERT INTO app_users (id,email,display_name,account_status) VALUES
       ($1,$2,'C3 Test Admin','active'),
       ($3,$4,'Pairing Owner','active'),
       ($5,$6,'Second Pairing Owner','active'),
       ($7,$8,'Malformed Request Owner','active'),
       ($9,$10,'Rate Limited Owner','active'),
       ($11,$12,'Lifecycle Owner','active')`,
      [ids.admin, `c3-${ids.admin}@example.test`, ids.owner, `c3-${ids.owner}@example.test`, ids.secondOwner, `c3-${ids.secondOwner}@example.test`, ids.malformedOwner, `c3-${ids.malformedOwner}@example.test`, ids.limitedOwner, `c3-${ids.limitedOwner}@example.test`, ids.lifecycleOwner, `c3-${ids.lifecycleOwner}@example.test`]
    );
    runtime = await startMissionTestServer({ databaseUrl: scopedDatabaseUrl, pepper, extraEnv });
    const admin = await pool.query("SELECT is_admin FROM app_users WHERE id=$1", [ids.admin]);
    assert.equal(admin.rows[0].is_admin, true);
    const sessions = {
      admin: await createSession(pool, pepper, ids.admin),
      owner: await createSession(pool, pepper, ids.owner),
      secondOwner: await createSession(pool, pepper, ids.secondOwner),
      malformedOwner: await createSession(pool, pepper, ids.malformedOwner),
      limitedOwner: await createSession(pool, pepper, ids.limitedOwner),
      lifecycleOwner: await createSession(pool, pepper, ids.lifecycleOwner)
    };
    const request = (path, options = {}) => apiRequest(runtime.baseUrl, path, options);
    const createPairing = async (session) => {
      const response = await request(creationPath, { ...makeBody({ schema: 1 }), session });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.deepEqual(Object.keys(response.body).sort(), ["code", "expires_at", "schema"]);
      assert.equal(response.body.schema, 1);
      assert.match(response.body.code, /^(?:[0-9A-HJKMNP-TV-Z]{4}-){3}[0-9A-HJKMNP-TV-Z]{4}$/);
      assert.ok(Date.parse(response.body.expires_at) >= Date.now() + 9 * 60_000);
      assert.ok(Date.parse(response.body.expires_at) <= Date.now() + 11 * 60_000);
      secrets.push(response.body.code, normalizePairingCode(response.body.code));
      return response.body.code;
    };

    await t.test("creation requires an active browser session and enforces JSON/schema/body errors", async () => {
      const unauthenticated = await request(creationPath, makeBody({ schema: 1 }));
      assert.equal(unauthenticated.status, 401);

      const foreignOrigin = await rawRequest(runtime.baseUrl, creationPath, {
        session: sessions.malformedOwner,
        body: JSON.stringify({ schema: 1 }),
        origin: "https://attacker.example"
      });
      assert.deepEqual([foreignOrigin.status, foreignOrigin.body], [401, { error: "login required" }]);
      const sameOrigin = await rawRequest(runtime.baseUrl, creationPath, {
        session: sessions.malformedOwner,
        body: JSON.stringify({ schema: 1 }),
        origin: "https://verselink.example.test"
      });
      assert.equal(sameOrigin.status, 201, JSON.stringify(sameOrigin.body));
      secrets.push(sameOrigin.body.code, normalizePairingCode(sameOrigin.body.code));

      const badSchema = await request(creationPath, { ...makeBody({ schema: 2 }), session: sessions.malformedOwner });
      assert.deepEqual([badSchema.status, badSchema.body], [400, { error: "unsupported_schema" }]);
      const invalidJson = await rawRequest(runtime.baseUrl, creationPath, { session: sessions.malformedOwner, body: "{" });
      assert.deepEqual([invalidJson.status, invalidJson.body], [400, { error: "invalid_payload" }]);
      const oversized = await rawRequest(runtime.baseUrl, creationPath, { session: sessions.malformedOwner, body: `{"schema":1,"x":"${"a".repeat(4100)}"}` });
      assert.deepEqual([oversized.status, oversized.body], [413, { error: "payload_too_large" }]);
      const wrongType = await rawRequest(runtime.baseUrl, creationPath, { session: sessions.malformedOwner, body: "schema=1", contentType: "application/x-www-form-urlencoded" });
      assert.deepEqual([wrongType.status, wrongType.body], [400, { error: "invalid_payload" }]);
    });

    await t.test("creation stores only the HMAC and replacement invalidates the prior code", async () => {
      const firstCode = await createPairing(sessions.owner);
      const firstHash = hashPairingCode(pepper, normalizePairingCode(firstCode));
      secrets.push(firstHash);
      const firstRow = await pool.query("SELECT id,code_hash,consumed_at,invalidated_at,expires_at FROM telemetry_pairing_codes WHERE app_user_id=$1 AND code_hash=$2", [ids.owner, firstHash]);
      assert.equal(firstRow.rowCount, 1);
      assert.equal(firstRow.rows[0].code_hash, firstHash);
      assert.equal(firstRow.rows[0].consumed_at, null);
      assert.equal(firstRow.rows[0].invalidated_at, null);
      assert.equal(JSON.stringify(firstRow.rows).includes(normalizePairingCode(firstCode)), false);

      const secondCode = await createPairing(sessions.owner);
      const secondHash = hashPairingCode(pepper, normalizePairingCode(secondCode));
      secrets.push(secondHash);
      const rows = await pool.query("SELECT code_hash,consumed_at,invalidated_at FROM telemetry_pairing_codes WHERE app_user_id=$1 ORDER BY created_at", [ids.owner]);
      assert.equal(rows.rowCount, 2);
      assert.equal(rows.rows[0].invalidated_at instanceof Date, true);
      assert.equal(rows.rows[1].invalidated_at, null);
      assert.equal(rows.rows[1].consumed_at, null);
      const oldClaim = await request(claimPath, makeBody({ schema: 1, code: firstCode }));
      assert.deepEqual([oldClaim.status, oldClaim.body], [409, { error: "pairing_code_used" }]);
    });

    await t.test("claim is unauthenticated, one-time, owner-bound, and stores only a credential HMAC", async () => {
      const code = await createPairing(sessions.secondOwner);
      const response = await request(claimPath, { ...makeBody({ schema: 1, code, device_name: "  Gaming PC  " }), session: sessions.owner });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.match(response.body.device_id, /^[0-9a-f-]{36}$/i);
      assert.equal(response.body.device_name, "Gaming PC");
      assert.match(response.body.device_credential, /^vlt_[A-Za-z0-9_-]{43}$/);
      assert.equal(response.body.token_type, "Bearer");
      assert.ok(Number.isFinite(Date.parse(response.body.created_at)));
      assert.equal(Object.hasOwn(response.body, "app_user_id"), false);
      assert.equal(Object.hasOwn(response.body, "credential_hash"), false);
      assert.equal(Object.hasOwn(response.body, "code_hash"), false);
      const credentialHash = hashDeviceCredential(pepper, response.body.device_credential);
      secrets.push(response.body.device_credential, credentialHash);
      const device = await pool.query("SELECT id,app_user_id,name,credential_hash,created_at,last_seen_at,revoked_at,last_presence_revision FROM telemetry_devices WHERE id=$1", [response.body.device_id]);
      assert.equal(device.rowCount, 1);
      assert.equal(device.rows[0].app_user_id, ids.secondOwner);
      assert.equal(device.rows[0].name, "Gaming PC");
      assert.equal(device.rows[0].credential_hash, credentialHash);
      assert.equal(device.rows[0].last_presence_revision, "0");
      assert.equal(JSON.stringify(device.rows).includes(response.body.device_credential), false);
      const pairing = await pool.query("SELECT consumed_at,invalidated_at FROM telemetry_pairing_codes WHERE app_user_id=$1 AND code_hash=$2", [ids.secondOwner, hashPairingCode(pepper, normalizePairingCode(code))]);
      assert.ok(pairing.rows[0].consumed_at instanceof Date);
      assert.equal(pairing.rows[0].invalidated_at, null);
      const replay = await request(claimPath, makeBody({ schema: 1, code }));
      assert.deepEqual([replay.status, replay.body], [409, { error: "pairing_code_used" }]);
    });

    await t.test("claim errors follow the C1 precedence and reject invalid names and oversized bodies", async () => {
      const malformed = await request(claimPath, makeBody({ schema: 1, code: "not a code" }));
      assert.deepEqual([malformed.status, malformed.body], [400, { error: "invalid_pairing_code" }]);
      const unknown = await request(claimPath, makeBody({ schema: 1, code: "0000000000000000" }));
      assert.deepEqual([unknown.status, unknown.body], [400, { error: "invalid_pairing_code" }]);
      const invalidName = await request(claimPath, makeBody({ schema: 1, code: "0000000000000000", device_name: "\ud800" }));
      assert.deepEqual([invalidName.status, invalidName.body], [400, { error: "invalid_payload" }]);
      const unsupported = await request(claimPath, makeBody({ schema: 2, code: "0000000000000000" }));
      assert.deepEqual([unsupported.status, unsupported.body], [400, { error: "unsupported_schema" }]);
      const invalidJson = await rawRequest(runtime.baseUrl, claimPath, { body: "{" });
      assert.deepEqual([invalidJson.status, invalidJson.body], [400, { error: "invalid_payload" }]);
      const oversized = await rawRequest(runtime.baseUrl, claimPath, { body: `{"schema":1,"code":"${"A".repeat(4100)}"}` });
      assert.deepEqual([oversized.status, oversized.body], [413, { error: "payload_too_large" }]);

      const expiredCode = generatePairingCode();
      secrets.push(expiredCode, normalizePairingCode(expiredCode), hashPairingCode(pepper, normalizePairingCode(expiredCode)));
      const expiredHash = hashPairingCode(pepper, normalizePairingCode(expiredCode));
      await pool.query("INSERT INTO telemetry_pairing_codes (app_user_id,code_hash,created_at,expires_at) VALUES ($1,$2,now()-interval '2 hours',now()-interval '1 hour')", [ids.owner, expiredHash]);
      const expired = await request(claimPath, makeBody({ schema: 1, code: expiredCode }));
      assert.deepEqual([expired.status, expired.body], [410, { error: "expired_pairing_code" }]);
    });

    await t.test("concurrent claims atomically create one device and consume once", async () => {
      const code = await createPairing(sessions.owner);
      const before = await pool.query("SELECT count(*)::int AS count FROM telemetry_devices WHERE app_user_id=$1", [ids.owner]);
      const results = await Promise.all([
        request(claimPath, makeBody({ schema: 1, code, device_name: "Concurrent A" })),
        request(claimPath, makeBody({ schema: 1, code, device_name: "Concurrent B" }))
      ]);
      assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
      assert.deepEqual(results.find((result) => result.status === 409).body, { error: "pairing_code_used" });
      const after = await pool.query("SELECT count(*)::int AS count FROM telemetry_devices WHERE app_user_id=$1", [ids.owner]);
      assert.equal(after.rows[0].count, before.rows[0].count + 1);
      const codeHash = hashPairingCode(pepper, normalizePairingCode(code));
      const pairing = await pool.query("SELECT consumed_at FROM telemetry_pairing_codes WHERE code_hash=$1", [codeHash]);
      assert.ok(pairing.rows[0].consumed_at instanceof Date);
    });

    await t.test("account deactivation invalidates codes transactionally without revoking devices", async () => {
      const liveCode = await createPairing(sessions.lifecycleOwner);
      const deviceResponse = await request(claimPath, makeBody({ schema: 1, code: liveCode }));
      assert.equal(deviceResponse.status, 201);
      const deviceId = deviceResponse.body.device_id;
      secrets.push(deviceResponse.body.device_credential, hashDeviceCredential(pepper, deviceResponse.body.device_credential));
      const openCode = await createPairing(sessions.lifecycleOwner);
      const openHash = hashPairingCode(pepper, normalizePairingCode(openCode));
      secrets.push(openHash);
      const status = await request("/api/admin/users/status", { method: "POST", session: sessions.admin, form: { user_id: ids.lifecycleOwner, status: "blocked" } });
      assert.equal(status.status, 200, JSON.stringify(status.body));
      const rows = await pool.query("SELECT invalidated_at,consumed_at FROM telemetry_pairing_codes WHERE code_hash=$1", [openHash]);
      assert.ok(rows.rows[0].invalidated_at instanceof Date);
      assert.equal(rows.rows[0].consumed_at, null);
      const device = await pool.query("SELECT revoked_at FROM telemetry_devices WHERE id=$1", [deviceId]);
      assert.equal(device.rows[0].revoked_at, null);
      const claim = await request(claimPath, makeBody({ schema: 1, code: openCode }));
      assert.deepEqual([claim.status, claim.body], [409, { error: "pairing_code_used" }]);
      const blockedSession = await createSession(pool, pepper, ids.lifecycleOwner);
      const inactiveCreate = await request(creationPath, { ...makeBody({ schema: 1 }), session: blockedSession });
      assert.deepEqual([inactiveCreate.status, inactiveCreate.body], [403, { error: "account_inactive" }]);
    });

    await stopMissionTestServer(runtime);
    serverOutput.push(...runtime.output);
    runtime = null;
    rateRuntime = await startMissionTestServer({ databaseUrl: scopedDatabaseUrl, pepper, extraEnv });
    const rateSession = await createSession(pool, pepper, ids.limitedOwner);
    for (let index = 0; index < 5; index += 1) {
      const response = await apiRequest(rateRuntime.baseUrl, creationPath, { method: "POST", session: rateSession, json: { schema: 1 } });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      secrets.push(response.body.code, normalizePairingCode(response.body.code), hashPairingCode(pepper, normalizePairingCode(response.body.code)));
    }
    const createLimited = await apiRequest(rateRuntime.baseUrl, creationPath, { method: "POST", session: rateSession, json: { schema: 1 } });
    assert.deepEqual([createLimited.status, createLimited.body], [429, { error: "rate_limited" }]);
    assert.ok(Number(createLimited.headers.get("Retry-After")) > 0);

    for (let index = 0; index < 20; index += 1) {
      const response = await apiRequest(rateRuntime.baseUrl, claimPath, { method: "POST", json: { schema: 1, code: "0000000000000000" } });
      assert.equal(response.status, 400);
    }
    const claimLimited = await apiRequest(rateRuntime.baseUrl, claimPath, { method: "POST", json: { schema: 1, code: "0000000000000000" } });
    assert.deepEqual([claimLimited.status, claimLimited.body], [429, { error: "rate_limited" }]);
    assert.ok(Number(claimLimited.headers.get("Retry-After")) > 0);

    const output = [...serverOutput, ...(rateRuntime.output || [])].join("");
    const logFiles = await readdir(rateRuntime.logDirectory).catch(() => []);
    const logText = (await Promise.all(logFiles.map((file) => readFile(`${rateRuntime.logDirectory}/${file}`, "utf8").catch(() => "")))).join("\n");
    const captured = `${output}\n${logText}`;
    for (const secret of secrets.filter(Boolean)) assert.equal(captured.includes(secret), false, `secret leaked to server output/logs: ${secret}`);
  } finally {
    try { await stopMissionTestServer(runtime); } finally {
      try { await stopMissionTestServer(rateRuntime); } finally {
        try { if (pool) await pool.end(); } finally {
          if (adminPool) {
            try { if (schemaName) await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); }
            finally { await adminPool.end(); }
          }
        }
      }
    }
  }
});

test("CI provides the PostgreSQL C3 pairing test database", () => {
  if (process.env.CI) assert.ok(databaseUrl, "TEST_DATABASE_URL must be set in CI");
});
