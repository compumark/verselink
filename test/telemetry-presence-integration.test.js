import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apiRequest, createSession, startMissionTestServer, stopMissionTestServer } from "./helpers/mission-integration.js";
import { createC6TestPool, createC7TestSchema, dropC7TestSchema, resolveC6TestDatabaseUrl } from "./helpers/c6-test-database.js";

const databaseUrl = resolveC6TestDatabaseUrl(process.env.TEST_DATABASE_URL);
const pepper = "telemetry-presence-integration-test-pepper";
const path = "/api/telemetry/presence";
const payload = (revision, changes = {}) => ({
  schema: 1, revision, session_active: true, shard: "pu-test-01",
  location: { raw: "RR_CRU_L1", observed_at: "2026-09-24T12:00:00.123456789Z" },
  jurisdiction: "Stanton", ship: { name: "RSI_Hermes" },
  quantum: { destination: "LOC_CRU_L1", state: "target_selected" }, party_count: 2,
  last_event_at: "2026-09-24T12:00:02.456Z", ...changes
});

const request = async (baseUrl, { credential, cookie, body, rawBody } = {}) => {
  const headers = { "content-type": "application/json" };
  if (credential) headers.authorization = `Bearer ${credential}`;
  if (cookie) headers.cookie = `bp_session=${cookie}`;
  const response = await fetch(`${baseUrl}${path}`, { method: "PUT", headers, body: rawBody ?? JSON.stringify(body) });
  return { status: response.status, body: await response.json(), headers: response.headers };
};

test("C7 stores the latest allowlisted snapshot with atomic per-device revision semantics", { skip: !databaseUrl }, async (t) => {
  let adminPool, pool, runtime, schemaName;
  const ownerId = randomUUID(), adminId = randomUUID();
  const logDirectory = join(tmpdir(), `telemetry-c7-${process.pid}-${randomUUID()}`);
  try {
    adminPool = await createC6TestPool(databaseUrl);
    schemaName = `c7_presence_${randomUUID().replaceAll("-", "")}`;
    await createC7TestSchema(adminPool, schemaName);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-c search_path=${schemaName}`);
    runtime = await startMissionTestServer({ databaseUrl: scoped.toString(), pepper, logDirectory });
    await stopMissionTestServer(runtime); runtime = null;
    pool = await createC6TestPool(scoped.toString());
    await pool.query("INSERT INTO app_users (id,email,display_name,account_status,is_admin) VALUES ($1,$2,'Presence Owner','active',false),($3,$4,'Presence Admin','active',true)", [ownerId, `c7-${ownerId}@example.test`, adminId, `c7-${adminId}@example.test`]);
    const ownerSession = await createSession(pool, pepper, ownerId);
    const adminSession = await createSession(pool, pepper, adminId);
    runtime = await startMissionTestServer({ databaseUrl: scoped.toString(), pepper, logDirectory });
    const created = await apiRequest(runtime.baseUrl, "/api/me/telemetry/pairing", { method: "POST", session: ownerSession, json: { schema: 1 } });
    assert.equal(created.status, 201);
    const claimed = await apiRequest(runtime.baseUrl, "/api/telemetry/pair", { method: "POST", json: { schema: 1, code: created.body.code } });
    assert.equal(claimed.status, 201);
    const credential = claimed.body.device_credential;
    const secondCode = await apiRequest(runtime.baseUrl, "/api/me/telemetry/pairing", { method: "POST", session: ownerSession, json: { schema: 1 } });
    assert.equal(secondCode.status, 201);
    const secondClaim = await apiRequest(runtime.baseUrl, "/api/telemetry/pair", { method: "POST", json: { schema: 1, code: secondCode.body.code } });
    assert.equal(secondClaim.status, 201);

    await t.test("auth is Bearer-only, validates payload, and enforces body limit", async () => {
      assert.deepEqual(await request(runtime.baseUrl, { cookie: ownerSession, body: payload(1) }).then(({ status, body }) => [status, body]), [401, { error: "invalid_device_credential" }]);
      assert.deepEqual(await request(runtime.baseUrl, { credential, body: { ...payload(1), schema: 2 } }).then(({ status, body }) => [status, body]), [400, { error: "unsupported_schema" }]);
      assert.deepEqual(await request(runtime.baseUrl, { credential, body: { ...payload(1), party_count: 101 } }).then(({ status, body }) => [status, body]), [400, { error: "invalid_payload" }]);
      const large = await request(runtime.baseUrl, { credential, rawBody: JSON.stringify(payload(1, { shard: "x".repeat(17_000) })) });
      assert.deepEqual([large.status, large.body], [413, { error: "payload_too_large" }]);
    });

    await t.test("new revision persists only C1 allowlist fields; equal revision ignores shard and party count", async () => {
      const accepted = await request(runtime.baseUrl, { credential, body: payload(1) });
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.accepted, true);
      assert.equal(accepted.body.revision, 1);
      const firstRow = await pool.query("SELECT * FROM telemetry_presence WHERE device_id=$1", [claimed.body.device_id]);
      assert.equal(firstRow.rowCount, 1);
      assert.equal(firstRow.rows[0].location_observed_at, "2026-09-24T12:00:00.123456789Z");
      const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='telemetry_presence'", [schemaName]);
      const names = columns.rows.map((row) => row.column_name);
      assert.equal(names.includes("shard"), false);
      assert.equal(names.includes("party_count"), false);
      assert.equal(names.includes("payload"), false);
      const receivedAt = firstRow.rows[0].received_at.toISOString();
      const duplicate = await request(runtime.baseUrl, { credential, body: payload(1, { shard: "other", party_count: 87, ignored: "ignored" }) });
      assert.deepEqual([duplicate.status, duplicate.body.accepted, duplicate.body.revision], [200, false, 1]);
      const afterDuplicate = await pool.query("SELECT received_at FROM telemetry_presence WHERE device_id=$1", [claimed.body.device_id]);
      assert.equal(afterDuplicate.rows[0].received_at.toISOString(), receivedAt);
    });

    await t.test("revision conflicts, stale input, and account deactivation preserve high-water and device", async () => {
      const changedAtSameRevision = await request(runtime.baseUrl, { credential, body: payload(1, { jurisdiction: "Terra" }) });
      assert.deepEqual([changedAtSameRevision.status, changedAtSameRevision.body.error, changedAtSameRevision.body.current_revision], [409, "revision_conflict", 1]);
      const stale = await request(runtime.baseUrl, { credential, body: payload(0) });
      assert.deepEqual([stale.status, stale.body.error], [400, "invalid_payload"]);
      const accepted = await request(runtime.baseUrl, { credential, body: payload(3) });
      assert.deepEqual([accepted.status, accepted.body.accepted, accepted.body.revision], [200, true, 3]);
      const older = await request(runtime.baseUrl, { credential, body: payload(2) });
      assert.deepEqual([older.status, older.body.error, older.body.current_revision], [409, "stale_revision", 3]);

      const form = new URLSearchParams({ user_id: ownerId, status: "blocked" });
      const blocked = await fetch(`${runtime.baseUrl}/api/admin/users/status`, { method: "POST", headers: { cookie: `bp_session=${adminSession}`, "content-type": "application/x-www-form-urlencoded" }, body: form });
      assert.equal(blocked.status, 200);
      const [presence, device] = await Promise.all([
        pool.query("SELECT 1 FROM telemetry_presence WHERE device_id=$1", [claimed.body.device_id]),
        pool.query("SELECT last_presence_revision,revoked_at FROM telemetry_devices WHERE id=$1", [claimed.body.device_id])
      ]);
      assert.equal(presence.rowCount, 0);
      assert.equal(device.rows[0].last_presence_revision, "3");
      assert.equal(device.rows[0].revoked_at, null);
      assert.equal((await request(runtime.baseUrl, { credential, body: payload(4) })).status, 403);

      const reactivated = await fetch(`${runtime.baseUrl}/api/admin/users/status`, { method: "POST", headers: { cookie: `bp_session=${adminSession}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ user_id: ownerId, status: "active" }) });
      assert.equal(reactivated.status, 200);
      const resumed = await request(runtime.baseUrl, { credential, body: payload(4) });
      assert.deepEqual([resumed.status, resumed.body.accepted, resumed.body.revision], [200, true, 4]);
      assert.equal((await pool.query("SELECT 1 FROM telemetry_presence WHERE device_id=$1", [claimed.body.device_id])).rowCount, 1);

    });

    await t.test("concurrent higher revisions leave one complete highest-revision snapshot", async () => {
      const lowerPayload = payload(5, {
        session_active: true,
        location: { raw: "LOWER_REVISION_LOCATION", observed_at: "2026-09-24T12:00:05Z" },
        jurisdiction: "Lower Revision",
        ship: { name: "Lower Revision Ship" },
        quantum: { destination: "LOWER_DESTINATION", state: "target_selected" },
        last_event_at: "2026-09-24T12:00:05Z"
      });
      const higherPayload = payload(6, {
        session_active: false,
        location: { raw: "HIGHER_REVISION_LOCATION", observed_at: "2026-09-24T12:00:06Z" },
        jurisdiction: "Higher Revision",
        ship: { name: "Higher Revision Ship" },
        quantum: { destination: "HIGHER_DESTINATION", state: "fuel_requested" },
        last_event_at: "2026-09-24T12:00:06Z"
      });
      let ready = 0;
      let openGate;
      const gate = new Promise((resolve) => { openGate = resolve; });
      const submitTogether = async (body) => {
        ready += 1;
        if (ready === 2) openGate();
        await gate;
        return request(runtime.baseUrl, { credential, body });
      };
      const [lower, higher] = await Promise.all([
        submitTogether(lowerPayload),
        submitTogether(higherPayload)
      ]);

      assert.deepEqual([higher.status, higher.body.accepted, higher.body.revision], [200, true, 6]);
      if (lower.status === 200) {
        assert.deepEqual([lower.body.accepted, lower.body.revision], [true, 5]);
      } else {
        assert.deepEqual([lower.status, lower.body.error, lower.body.current_revision], [409, "stale_revision", 6]);
      }

      const [device, presence] = await Promise.all([
        pool.query("SELECT last_presence_revision FROM telemetry_devices WHERE id=$1", [claimed.body.device_id]),
        pool.query(`SELECT revision,session_active,location_raw,location_observed_at,jurisdiction,ship_name,
                           quantum_destination,quantum_state,last_event_at,received_at IS NOT NULL AS has_received_at
                    FROM telemetry_presence WHERE device_id=$1`, [claimed.body.device_id])
      ]);
      assert.equal(device.rows[0].last_presence_revision, "6");
      assert.equal(presence.rowCount, 1);
      assert.deepEqual(presence.rows[0], {
        revision: "6",
        session_active: false,
        location_raw: "HIGHER_REVISION_LOCATION",
        location_observed_at: "2026-09-24T12:00:06Z",
        jurisdiction: "Higher Revision",
        ship_name: "Higher Revision Ship",
        quantum_destination: "HIGHER_DESTINATION",
        quantum_state: "fuel_requested",
        last_event_at: "2026-09-24T12:00:06Z",
        has_received_at: true
      });
    });

    await t.test("revoked credentials cannot mutate presence while another device remains usable", async () => {
      const before = await pool.query(`SELECT revision,session_active,location_raw,location_observed_at,jurisdiction,
                                              ship_name,quantum_destination,quantum_state,last_event_at,received_at::text AS received_at
                                       FROM telemetry_presence WHERE device_id=$1`, [claimed.body.device_id]);
      assert.equal(before.rowCount, 1);
      const revisionBefore = await pool.query("SELECT last_presence_revision FROM telemetry_devices WHERE id=$1", [claimed.body.device_id]);
      assert.equal(revisionBefore.rows[0].last_presence_revision, "6");
      await pool.query("UPDATE telemetry_devices SET revoked_at=clock_timestamp() WHERE id=$1", [claimed.body.device_id]);

      const rejected = await request(runtime.baseUrl, { credential, body: payload(7) });
      assert.deepEqual([rejected.status, rejected.body.error], [401, "device_revoked"]);
      assert.equal(rejected.headers.get("www-authenticate"), "Bearer");
      const [after, revisionAfter] = await Promise.all([
        pool.query(`SELECT revision,session_active,location_raw,location_observed_at,jurisdiction,
                           ship_name,quantum_destination,quantum_state,last_event_at,received_at::text AS received_at
                    FROM telemetry_presence WHERE device_id=$1`, [claimed.body.device_id]),
        pool.query("SELECT last_presence_revision FROM telemetry_devices WHERE id=$1", [claimed.body.device_id])
      ]);
      assert.deepEqual(after.rows, before.rows, "revoked request changed Presence or received_at");
      assert.equal(revisionAfter.rows[0].last_presence_revision, "6");

      const sibling = await request(runtime.baseUrl, { credential: secondClaim.body.device_credential, body: payload(1) });
      assert.deepEqual([sibling.status, sibling.body.accepted, sibling.body.revision], [200, true, 1]);
      const siblingState = await pool.query("SELECT revision,location_raw FROM telemetry_presence WHERE device_id=$1", [secondClaim.body.device_id]);
      assert.deepEqual(siblingState.rows, [{ revision: "1", location_raw: "RR_CRU_L1" }]);
    });

    await t.test("presence request limit counts successful idempotent requests", async () => {
      // The sibling-device lifecycle test already used one successful request
      // for this credential; reach the limit with exactly 120 successes total.
      for (let index = 0; index < 119; index += 1) {
        const result = await request(runtime.baseUrl, { credential: secondClaim.body.device_credential, body: payload(1) });
        assert.equal(result.status, 200, `request ${index + 2} was not counted/accepted`);
      }
      const limited = await request(runtime.baseUrl, { credential: secondClaim.body.device_credential, body: payload(1) });
      assert.deepEqual([limited.status, limited.body.error], [429, "rate_limited"]);
    });

    await t.test("hard account deletion cascades devices and presence and invalidates old credentials", async () => {
      const currentPresence = await pool.query("SELECT device_id FROM telemetry_presence WHERE device_id = ANY($1::uuid[])", [[claimed.body.device_id, secondClaim.body.device_id]]);
      assert.equal(currentPresence.rowCount, 2);
      const currentDevices = await pool.query("SELECT id FROM telemetry_devices WHERE app_user_id=$1", [ownerId]);
      assert.equal(currentDevices.rowCount, 2);

      await createSession(pool, pepper, ownerId);
      const ownerSessions = await pool.query("DELETE FROM dashboard_sessions WHERE app_user_id=$1 RETURNING session_hash", [ownerId]);
      assert.equal(ownerSessions.rowCount, 1, "remove only the test owner's session before hard delete");
      const deleted = await pool.query("DELETE FROM app_users WHERE id=$1 RETURNING id", [ownerId]);
      assert.equal(deleted.rowCount, 1);

      const [devices, presence] = await Promise.all([
        pool.query("SELECT id FROM telemetry_devices WHERE app_user_id=$1", [ownerId]),
        pool.query("SELECT device_id FROM telemetry_presence WHERE device_id = ANY($1::uuid[])", [[claimed.body.device_id, secondClaim.body.device_id]])
      ]);
      assert.equal(devices.rowCount, 0);
      assert.equal(presence.rowCount, 0);
      const oldCredential = await request(runtime.baseUrl, { credential, body: payload(5) });
      assert.deepEqual([oldCredential.status, oldCredential.body.error], [401, "invalid_device_credential"]);
      assert.equal(oldCredential.headers.get("www-authenticate"), "Bearer");

      const deleteOwnerId = randomUUID();
      await pool.query("INSERT INTO app_users (id,email,display_name,account_status,is_admin) VALUES ($1,$2,'Hard Delete Owner','active',false)", [deleteOwnerId, `c7-delete-${deleteOwnerId}@example.test`]);
      const deleteOwnerSession = await createSession(pool, pepper, deleteOwnerId);
      const deletePairing = await apiRequest(runtime.baseUrl, "/api/me/telemetry/pairing", { method: "POST", session: deleteOwnerSession, json: { schema: 1 } });
      assert.equal(deletePairing.status, 201);
      const deleteClaim = await apiRequest(runtime.baseUrl, "/api/telemetry/pair", { method: "POST", json: { schema: 1, code: deletePairing.body.code } });
      assert.equal(deleteClaim.status, 201);
      const deleteCredential = deleteClaim.body.device_credential;
      const deleteDeviceId = deleteClaim.body.device_id;
      const createdPresence = await request(runtime.baseUrl, { credential: deleteCredential, body: payload(1) });
      assert.deepEqual([createdPresence.status, createdPresence.body.accepted, createdPresence.body.revision], [200, true, 1]);

      assert.equal((await pool.query("SELECT 1 FROM telemetry_devices WHERE id=$1 AND app_user_id=$2", [deleteDeviceId, deleteOwnerId])).rowCount, 1);
      assert.equal((await pool.query("SELECT 1 FROM telemetry_presence WHERE device_id=$1", [deleteDeviceId])).rowCount, 1);
      const deleteOwnerSessions = await pool.query("DELETE FROM dashboard_sessions WHERE app_user_id=$1 RETURNING session_hash", [deleteOwnerId]);
      assert.equal(deleteOwnerSessions.rowCount, 1, "remove only the dedicated hard-delete owner's session");
      const deleteOwner = await pool.query("DELETE FROM app_users WHERE id=$1 RETURNING id", [deleteOwnerId]);
      assert.equal(deleteOwner.rowCount, 1);
      const [deletedDevice, deletedPresence] = await Promise.all([
        pool.query("SELECT id FROM telemetry_devices WHERE id=$1", [deleteDeviceId]),
        pool.query("SELECT device_id FROM telemetry_presence WHERE device_id=$1", [deleteDeviceId])
      ]);
      assert.equal(deletedDevice.rowCount, 0);
      assert.equal(deletedPresence.rowCount, 0);
      const deletedCredential = await request(runtime.baseUrl, { credential: deleteCredential, body: payload(2) });
      assert.deepEqual([deletedCredential.status, deletedCredential.body.error], [401, "invalid_device_credential"]);
      assert.equal(deletedCredential.headers.get("www-authenticate"), "Bearer");
    });

  } finally {
    if (runtime) await stopMissionTestServer(runtime);
    await pool?.end();
    if (schemaName) await dropC7TestSchema(adminPool, schemaName);
    await adminPool?.end();
  }
});
