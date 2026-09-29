import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { apiRequest, createSession, startMissionTestServer, stopMissionTestServer } from "./helpers/mission-integration.js";
import { createC6TestPool, createC6TestSchema, dropC6TestSchema, resolveC6TestDatabaseUrl } from "./helpers/c6-test-database.js";

const databaseUrl = resolveC6TestDatabaseUrl(process.env.TEST_DATABASE_URL);
const pepper = "telemetry-heartbeat-integration-test-pepper";
const path = "/api/telemetry/heartbeat";

const heartbeat = async (baseUrl, { credential, session, body = { schema: 1 } } = {}) => {
  const headers = { "content-type": "application/json" };
  if (credential) headers.authorization = `Bearer ${credential}`;
  if (session) headers.cookie = `bp_session=${session}`;
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  return { status: response.status, body: payload, headers: response.headers };
};

test("C6 heartbeat authenticates C3 devices, updates connection metadata, and enforces request limits", { skip: !databaseUrl }, async (t) => {
  let adminPool, pool, runtime, schemaName;
  const ownerId = randomUUID();
  const logDirectory = `telemetry-heartbeat-${process.pid}-${randomUUID()}`;
  try {
    adminPool = await createC6TestPool(databaseUrl);
    schemaName = `c6_heartbeat_${randomUUID().replaceAll("-", "")}`;
    await createC6TestSchema(adminPool, schemaName);
    const scoped = new URL(databaseUrl);
    // Keep fault-injection and assertions inside this test-owned schema. If
    // public is on the path, a renamed table can silently resolve there instead.
    scoped.searchParams.set("options", `-c search_path=${schemaName}`);
    runtime = await startMissionTestServer({ databaseUrl: scoped.toString(), pepper, logDirectory });
    await stopMissionTestServer(runtime); runtime = null;
    pool = await createC6TestPool(scoped.toString());
    await pool.query("INSERT INTO app_users (id,email,display_name,account_status) VALUES ($1,$2,'Heartbeat Owner','active')", [ownerId, `c6-${ownerId}@example.test`]);
    const session = await createSession(pool, pepper, ownerId);
    runtime = await startMissionTestServer({ databaseUrl: scoped.toString(), pepper, logDirectory });

    const pair = async () => {
      const code = await apiRequest(runtime.baseUrl, "/api/me/telemetry/pairing", { method: "POST", session, json: { schema: 1 } });
      assert.equal(code.status, 201);
      const claimed = await apiRequest(runtime.baseUrl, "/api/telemetry/pair", { method: "POST", json: { schema: 1, code: code.body.code } });
      assert.equal(claimed.status, 201);
      return { id: claimed.body.device_id, credential: claimed.body.device_credential };
    };
    const first = await pair(); const second = await pair(); const limited = await pair();
    const secrets = [first.credential, second.credential, limited.credential, session];
    const old = new Date("2020-01-01T00:00:00Z");

    await t.test("success refreshes only the authenticated device with the server receipt time", async () => {
      await pool.query("UPDATE telemetry_devices SET last_seen_at=$1,last_presence_revision=23 WHERE id=ANY($2::uuid[])", [old, [first.id, second.id]]);
      const response = await heartbeat(runtime.baseUrl, { credential: first.credential });
      assert.equal(response.status, 200);
      assert.deepEqual(Object.keys(response.body).sort(), ["ok", "received_at", "schema"]);
      assert.equal(response.body.schema, 1);
      assert.equal(response.body.ok, true);
      assert.match(response.body.received_at, /^\d{4}-\d\d-\d\dT.*Z$/);
      const rows = await pool.query("SELECT id,last_seen_at,last_presence_revision,revoked_at FROM telemetry_devices WHERE id=ANY($1::uuid[]) ORDER BY id", [[first.id, second.id]]);
      const updated = rows.rows.find((row) => row.id === first.id);
      const untouched = rows.rows.find((row) => row.id === second.id);
      assert.equal(updated.last_seen_at.toISOString(), response.body.received_at);
      assert.equal(updated.last_presence_revision, "23");
      assert.equal(untouched.last_seen_at.toISOString(), old.toISOString());
      assert.equal(untouched.last_presence_revision, "23");
      assert.equal(updated.revoked_at, null);
    });

    await t.test("device Bearer auth stays separate from browser cookies and C4 status", async () => {
      const missing = await heartbeat(runtime.baseUrl);
      assert.deepEqual([missing.status, missing.body, missing.headers.get("www-authenticate")], [401, { error: "invalid_device_credential" }, "Bearer"]);
      const cookieOnly = await heartbeat(runtime.baseUrl, { session });
      assert.equal(cookieOnly.status, 401);
      assert.equal(cookieOnly.headers.get("www-authenticate"), "Bearer");
      const wrong = await heartbeat(runtime.baseUrl, { credential: "vlt_" + "x".repeat(43) });
      assert.equal(wrong.status, 401);
      const browserRoute = await fetch(`${runtime.baseUrl}/api/me`, { headers: { authorization: `Bearer ${first.credential}` } });
      assert.equal(browserRoute.status, 401);

      const malformed = await heartbeat(runtime.baseUrl, { credential: second.credential, body: { schema: 2 } });
      assert.deepEqual([malformed.status, malformed.body], [400, { error: "unsupported_schema" }]);
      const extra = await heartbeat(runtime.baseUrl, { credential: second.credential, body: { schema: 1, extra: true } });
      assert.deepEqual([extra.status, extra.body], [400, { error: "invalid_payload" }]);
      const missingSchema = await heartbeat(runtime.baseUrl, { credential: second.credential, body: {} });
      assert.deepEqual([missingSchema.status, missingSchema.body], [400, { error: "invalid_payload" }]);
      const malformedBody = await fetch(`${runtime.baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${second.credential}` }, body: "{" });
      assert.deepEqual([malformedBody.status, await malformedBody.json()], [400, { error: "invalid_payload" }]);

      await pool.query("UPDATE telemetry_devices SET last_seen_at=$1 WHERE id=$2", [old, first.id]);
      await pool.query("UPDATE telemetry_devices SET revoked_at=now() WHERE id=$1", [first.id]);
      const revoked = await heartbeat(runtime.baseUrl, { credential: first.credential });
      assert.deepEqual([revoked.status, revoked.body], [401, { error: "device_revoked" }]);
      assert.equal(revoked.headers.get("www-authenticate"), "Bearer");
      assert.equal((await pool.query("SELECT last_seen_at FROM telemetry_devices WHERE id=$1", [first.id])).rows[0].last_seen_at.toISOString(), old.toISOString());

      await pool.query("UPDATE app_users SET account_status='blocked' WHERE id=$1", [ownerId]);
      const inactive = await heartbeat(runtime.baseUrl, { credential: second.credential });
      assert.deepEqual([inactive.status, inactive.body], [403, { error: "account_inactive" }]);
      assert.equal((await pool.query("SELECT last_seen_at FROM telemetry_devices WHERE id=$1", [second.id])).rows[0].last_seen_at.toISOString(), old.toISOString());
    });

    await t.test("successful attempts count toward the per-device request limit", async () => {
      await pool.query("UPDATE app_users SET account_status='active' WHERE id=$1", [ownerId]);
      await pool.query("UPDATE telemetry_devices SET last_seen_at=$1 WHERE id=$2", [old, limited.id]);
      for (let index = 0; index < 120; index += 1) {
        const response = await heartbeat(runtime.baseUrl, { credential: limited.credential });
        assert.equal(response.status, 200, `attempt ${index + 1}`);
      }
      await pool.query("UPDATE telemetry_devices SET last_seen_at=$1 WHERE id=$2", [old, limited.id]);
      const limitedResponse = await heartbeat(runtime.baseUrl, { credential: limited.credential });
      assert.deepEqual([limitedResponse.status, limitedResponse.body], [429, { error: "rate_limited" }]);
      assert.ok(Number(limitedResponse.headers.get("retry-after")) >= 1);
      assert.equal((await pool.query("SELECT last_seen_at FROM telemetry_devices WHERE id=$1", [limited.id])).rows[0].last_seen_at.toISOString(), old.toISOString());
    });

    await t.test("heartbeat changes no gameplay or presence state", async () => {
      const before = await pool.query("SELECT id,app_user_id,name,credential_hash,created_at,revoked_at,last_presence_revision FROM telemetry_devices WHERE id=$1", [second.id]);
      await pool.query(`INSERT INTO telemetry_presence
        (device_id,schema_version,revision,session_active,location_raw,location_observed_at,jurisdiction,
         ship_name,quantum_destination,quantum_state,last_event_at,received_at)
        VALUES ($1,1,23,true,'RR_CRU_L1','2026-09-24T12:00:00Z','Stanton','RSI_Hermes',
                'LOC_CRU_L1','target_selected','2026-09-24T12:00:02Z',$2)`, [second.id, old]);
      const presenceBefore = await pool.query(`SELECT device_id,schema_version,revision,session_active,location_raw,
        location_observed_at,jurisdiction,ship_name,quantum_destination,quantum_state,last_event_at,received_at
        FROM telemetry_presence WHERE device_id=$1`, [second.id]);
      await pool.query("UPDATE app_users SET account_status='active' WHERE id=$1", [ownerId]);
      const response = await heartbeat(runtime.baseUrl, { credential: second.credential });
      assert.equal(response.status, 200);
      const after = await pool.query("SELECT id,app_user_id,name,credential_hash,created_at,revoked_at,last_presence_revision FROM telemetry_devices WHERE id=$1", [second.id]);
      assert.deepEqual(after.rows, before.rows);
      const presenceAfter = await pool.query(`SELECT device_id,schema_version,revision,session_active,location_raw,
        location_observed_at,jurisdiction,ship_name,quantum_destination,quantum_state,last_event_at,received_at
        FROM telemetry_presence WHERE device_id=$1`, [second.id]);
      assert.deepEqual(presenceAfter.rows, presenceBefore.rows);
    });
    await t.test("authentication database failures consume the credential bucket and remain service errors", async () => {
      await pool.query("UPDATE app_users SET account_status='active' WHERE id=$1", [ownerId]);
      const before = (await pool.query("SELECT last_seen_at FROM telemetry_devices WHERE id=$1", [second.id])).rows[0].last_seen_at;
      await pool.query("ALTER TABLE telemetry_devices RENAME TO telemetry_devices_c6_hidden");
      try {
        let serviceUnavailable = 0;
        let limited;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          const response = await heartbeat(runtime.baseUrl, { credential: second.credential });
          if (response.status === 503) {
            serviceUnavailable += 1;
            assert.deepEqual(response.body, { error: "server_unavailable" });
            continue;
          }
          limited = response;
          break;
        }
        assert.ok(serviceUnavailable > 0, "an auth database exception must remain a 503 before the credential bucket fills");
        assert.deepEqual([limited?.status, limited?.body], [429, { error: "rate_limited" }]);
        assert.ok(Number(limited.headers.get("retry-after")) >= 1);
      } finally {
        await pool.query("ALTER TABLE telemetry_devices_c6_hidden RENAME TO telemetry_devices");
      }
      assert.equal((await pool.query("SELECT last_seen_at FROM telemetry_devices WHERE id=$1", [second.id])).rows[0].last_seen_at.toISOString(), before.toISOString());
    });

    const output = runtime.output.join("");
    for (const secret of secrets) assert.equal(output.includes(secret), false, "heartbeat credential or session appeared in server output");
  } finally {
    await stopMissionTestServer(runtime);
    if (pool) await pool.end();
    if (adminPool) {
      try { if (schemaName) await dropC6TestSchema(adminPool, schemaName); }
      finally { await adminPool.end(); }
    }
  }
});

test("CI provides the PostgreSQL C6 heartbeat integration database", () => {
  if (process.env.CI) assert.ok(databaseUrl, "TEST_DATABASE_URL must be set in CI");
});
