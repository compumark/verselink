import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apiRequest, createSession, startMissionTestServer, stopMissionTestServer } from "./helpers/mission-integration.js";
import { createC6TestPool, createC8TestSchema, dropC8TestSchema, resolveC6TestDatabaseUrl } from "./helpers/c6-test-database.js";
import { cleanupExpiredTelemetryHistory } from "../src/telemetry-history-cleanup.js";

const databaseUrl = resolveC6TestDatabaseUrl(process.env.TEST_DATABASE_URL);
const pepper = "telemetry-c8-device-management-integration-test-pepper";
const presencePath = "/api/telemetry/presence";
const payload = (revision, changes = {}) => ({
  schema: 1,
  revision,
  session_active: true,
  shard: "private-shard-not-retained",
  location: { raw: "RR_CRU_L1", observed_at: "2026-09-29T12:00:00.123456789Z" },
  jurisdiction: "Stanton",
  ship: { name: "RSI_Hermes" },
  quantum: { destination: "LOC_CRU_L1", state: "target_selected" },
  party_count: 2,
  last_event_at: "2026-09-29T12:00:01Z",
  ...changes
});

const deviceRequest = async (baseUrl, { credential, cookie, body, method = "PUT", path = presencePath } = {}) => {
  const headers = { "content-type": "application/json" };
  if (credential) headers.authorization = `Bearer ${credential}`;
  if (cookie) headers.cookie = `bp_session=${cookie}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
};

const heartbeatRequest = async (baseUrl, credential) => {
  const response = await fetch(`${baseUrl}/api/telemetry/heartbeat`, {
    method: "POST",
    headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify({ schema: 1 })
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
};

const pairDevice = async (baseUrl, session, name) => {
  const created = await apiRequest(baseUrl, "/api/me/telemetry/pairing", { method: "POST", session, json: { schema: 1 } });
  assert.equal(created.status, 201);
  const claim = await apiRequest(baseUrl, "/api/telemetry/pair", { method: "POST", json: { schema: 1, code: created.body.code, device_name: name } });
  assert.equal(claim.status, 201);
  return { id: claim.body.device_id, credential: claim.body.device_credential };
};

const getHistory = async (baseUrl, session, query = "") => apiRequest(baseUrl, `/api/me/telemetry/history${query}`, { session });
const managementRequest = async (baseUrl, path, { session, method = "GET", json: body, origin = "http://localhost:3000", bearer, forwarded = false } = {}) => {
  const headers = {};
  if (origin) headers.origin = origin;
  if (forwarded) {
    headers["x-forwarded-host"] = "localhost:3000";
    headers["x-forwarded-proto"] = "http";
    headers.forwarded = "host=localhost:3000;proto=http";
  }
  if (session) headers.cookie = `bp_session=${session}`;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const crossOriginMutation = (baseUrl, path, options = {}) => managementRequest(baseUrl, path, { ...options, origin: "https://attacker.example", forwarded: true });

test("C8 manages own devices and stores private accepted-snapshot history with bounded retention", { skip: !databaseUrl }, async () => {
  let adminPool, pool, runtime, schemaName;
  const ids = { owner: randomUUID(), other: randomUUID(), admin: randomUUID(), deleteOwner: randomUUID() };
  const logDirectory = join(tmpdir(), `telemetry-c8-${process.pid}-${randomUUID()}`);
  try {
    adminPool = await createC6TestPool(databaseUrl);
    schemaName = `c8_history_${randomUUID().replaceAll("-", "")}`;
    await createC8TestSchema(adminPool, schemaName);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-c search_path=${schemaName},public`);
    runtime = await startMissionTestServer({ databaseUrl: scoped.toString(), pepper, logDirectory });
    await stopMissionTestServer(runtime);
    runtime = null;
    pool = await createC6TestPool(scoped.toString());
    await pool.query(
      `INSERT INTO app_users (id,email,display_name,account_status,is_admin) VALUES
       ($1,$2,'C8 Owner','active',false),($3,$4,'C8 Other','active',false),
       ($5,$6,'C8 Admin','active',true),($7,$8,'C8 Delete Owner','active',false)`,
      [ids.owner, `c8-${ids.owner}@example.test`, ids.other, `c8-${ids.other}@example.test`, ids.admin, `c8-${ids.admin}@example.test`, ids.deleteOwner, `c8-${ids.deleteOwner}@example.test`]
    );
    let ownerSession = await createSession(pool, pepper, ids.owner);
    const otherSession = await createSession(pool, pepper, ids.other);
    const adminSession = await createSession(pool, pepper, ids.admin);
    const deleteOwnerSession = await createSession(pool, pepper, ids.deleteOwner);
    runtime = await startMissionTestServer({ databaseUrl: scoped.toString(), pepper, logDirectory, extraEnv: { APP_ADMIN_USER_IDS: ids.admin, VERSELINK_APP_URL: "http://localhost:3000" } });

    const ownerDevice = await pairDevice(runtime.baseUrl, ownerSession, "Owner PC");
    const siblingDevice = await pairDevice(runtime.baseUrl, ownerSession, "Owner Laptop");
    const otherDevice = await pairDevice(runtime.baseUrl, otherSession, "Other PC");
    const crossOriginRename = await crossOriginMutation(runtime.baseUrl, `/api/me/telemetry/devices/${ownerDevice.id}`, { session: ownerSession, method: "PATCH", json: { schema: 1, name: "Cross-Origin" } });
    assert.deepEqual([crossOriginRename.status, crossOriginRename.body.error], [401, "login required"]);
    const unchangedName = await pool.query("SELECT name FROM telemetry_devices WHERE id=$1", [ownerDevice.id]);
    assert.equal(unchangedName.rows[0].name, "Owner PC", "cross-origin mutation cannot rename a device");
    const missingOriginRename = await managementRequest(runtime.baseUrl, `/api/me/telemetry/devices/${ownerDevice.id}`, { session: ownerSession, method: "PATCH", origin: null, json: { schema: 1, name: "Missing Origin" } });
    assert.deepEqual([missingOriginRename.status, missingOriginRename.body.error], [401, "login required"]);
    const bearerOnlyRename = await managementRequest(runtime.baseUrl, `/api/me/telemetry/devices/${ownerDevice.id}`, { method: "PATCH", bearer: ownerDevice.credential, json: { schema: 1, name: "Bearer Only" } });
    assert.deepEqual([bearerOnlyRename.status, bearerOnlyRename.body.error], [401, "login required"]);
    assert.equal((await pool.query("SELECT name FROM telemetry_devices WHERE id=$1", [ownerDevice.id])).rows[0].name, "Owner PC", "rejected mutations leave device data unchanged");
    const otherInitial = await deviceRequest(runtime.baseUrl, { credential: otherDevice.credential, body: payload(1) });
    const otherRetry = await deviceRequest(runtime.baseUrl, { credential: otherDevice.credential, body: payload(1) });
    assert.deepEqual([otherInitial.status, otherInitial.body.accepted, otherRetry.status, otherRetry.body.accepted], [200, true, 200, false]);
    const otherHistoryCount = Number((await pool.query("SELECT count(*)::int AS count FROM telemetry_presence_history WHERE device_id=$1", [otherDevice.id])).rows[0].count);
    assert.equal(otherHistoryCount, 1);
    for (let index = 0; index < 118; index += 1) assert.equal((await deviceRequest(runtime.baseUrl, { credential: otherDevice.credential, body: payload(1) })).status, 200);
    const otherRateLimited = await deviceRequest(runtime.baseUrl, { credential: otherDevice.credential, body: payload(1) });
    assert.deepEqual([otherRateLimited.status, otherRateLimited.body.error], [429, "rate_limited"]);
    assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM telemetry_presence_history WHERE device_id=$1", [otherDevice.id])).rows[0].count), otherHistoryCount, "rate-limited requests cannot create history");

    assert.equal((await deviceRequest(runtime.baseUrl, { cookie: ownerSession, body: payload(1) })).status, 401, "browser cookie does not authenticate C7 device routes");
    assert.equal((await apiRequest(runtime.baseUrl, "/api/me/telemetry/devices", {})).status, 401);
    const ownDevices = await apiRequest(runtime.baseUrl, "/api/me/telemetry/devices", { session: ownerSession });
    assert.equal(ownDevices.status, 200);
    assert.deepEqual(new Set(ownDevices.body.devices.map((device) => device.id)), new Set([ownerDevice.id, siblingDevice.id]));
    assert.doesNotMatch(JSON.stringify(ownDevices.body), /credential|vlt_|[0-9a-f]{64}/i);
    const otherView = await apiRequest(runtime.baseUrl, "/api/me/telemetry/devices", { session: otherSession });
    assert.deepEqual(otherView.body.devices.map((device) => device.id), [otherDevice.id]);

    const renamed = await managementRequest(runtime.baseUrl, `/api/me/telemetry/devices/${ownerDevice.id}`, { method: "PATCH", session: ownerSession, json: { schema: 1, name: "  Test Rig  " } });
    assert.deepEqual([renamed.status, renamed.body.device.name], [200, "Test Rig"]);
    const invalidName = await managementRequest(runtime.baseUrl, `/api/me/telemetry/devices/${ownerDevice.id}`, { method: "PATCH", session: ownerSession, json: { schema: 1, name: "  " } });
    assert.deepEqual([invalidName.status, invalidName.body.error], [400, "invalid_payload"]);
    const foreignRename = await managementRequest(runtime.baseUrl, `/api/me/telemetry/devices/${ownerDevice.id}`, { method: "PATCH", session: otherSession, json: { schema: 1, name: "Stolen" } });
    const foreignRevoke = await managementRequest(runtime.baseUrl, `/api/me/telemetry/devices/${ownerDevice.id}`, { method: "DELETE", session: otherSession });
    assert.deepEqual([foreignRename.status, foreignRename.body.error], [404, "not_found"]);
    assert.deepEqual([foreignRevoke.status, foreignRevoke.body.error], [404, "not_found"]);

    const first = payload(1);
    const ownerInitial = await deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: first });
    const ownerRetry = await deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: first });
    assert.deepEqual([ownerInitial.status, ownerInitial.body.accepted, ownerRetry.status, ownerRetry.body.accepted], [200, true, 200, false]);
    let historyRows = await pool.query("SELECT revision,location_raw,location_observed_at,jurisdiction,ship_name FROM telemetry_presence_history WHERE device_id=$1 ORDER BY revision", [ownerDevice.id]);
    assert.equal(historyRows.rowCount, 1, "accepted snapshot plus identical retry creates exactly one history entry");
    assert.equal(historyRows.rows[0].location_raw, "RR_CRU_L1");
    assert.equal(historyRows.rows[0].location_observed_at, "2026-09-29T12:00:00.123456789Z");

    const next = payload(2, { location: { raw: "RR_MIC_L1", observed_at: "2026-09-29T12:01:00Z" }, jurisdiction: "UEE", ship: { name: "Anvil_Carrack" } });
    assert.equal((await deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: next })).body.accepted, true);
    const conflict = payload(2, { jurisdiction: "Conflict" });
    assert.deepEqual([(await deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: conflict })).status, (await deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: payload(1) })).status], [409, 409]);
    const sameProjectionNewRevision = { ...next, revision: 3 };
    assert.equal((await deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: sameProjectionNewRevision })).body.accepted, true);
    assert.equal((await pool.query("SELECT id FROM telemetry_presence_history WHERE device_id=$1", [ownerDevice.id])).rowCount, 2, "consecutive identical projections are deduplicated across a higher revision");

    const third = payload(4, { location: { raw: "RR_AREA18", observed_at: "2026-09-29T12:02:00Z" }, jurisdiction: "Stanton", ship: null });
    assert.equal((await deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: third })).status, 200);
    const unknown = payload(5, { location: null, ship: null, jurisdiction: null, quantum: null, last_event_at: null });
    assert.equal((await deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: unknown })).body.accepted, true);
    const unknownRow = await pool.query("SELECT location_raw,location_observed_at,ship_name FROM telemetry_presence_history WHERE device_id=$1 AND revision=5", [ownerDevice.id]);
    assert.deepEqual(unknownRow.rows[0], { location_raw: null, location_observed_at: null, ship_name: null });

    await pool.query("ALTER TABLE telemetry_presence_history ADD CONSTRAINT c8_test_reject_revision_six CHECK (revision <> 6)");
    const revisionSix = payload(6, { location: { raw: "RR_CRU_L2", observed_at: "2026-09-29T12:03:00Z" }, ship: { name: "Test_Ship_6" } });
    const rejectedHistoryWrite = await deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: revisionSix });
    assert.deepEqual([rejectedHistoryWrite.status, rejectedHistoryWrite.body.error], [503, "server_unavailable"]);
    const [deviceAfterRollback, presenceAfterRollback, partialHistory] = await Promise.all([
      pool.query("SELECT last_presence_revision FROM telemetry_devices WHERE id=$1", [ownerDevice.id]),
      pool.query("SELECT revision,location_raw,ship_name FROM telemetry_presence WHERE device_id=$1", [ownerDevice.id]),
      pool.query("SELECT 1 FROM telemetry_presence_history WHERE device_id=$1 AND revision=6", [ownerDevice.id])
    ]);
    assert.equal(Number(deviceAfterRollback.rows[0].last_presence_revision), 5, "history failure rolls the device revision back");
    assert.deepEqual(presenceAfterRollback.rows[0], { revision: "5", location_raw: null, ship_name: null }, "history failure rolls the current snapshot back");
    assert.equal(partialHistory.rowCount, 0, "failed history insert leaves no partial row");
    await pool.query("ALTER TABLE telemetry_presence_history DROP CONSTRAINT c8_test_reject_revision_six");
    const retriedRevisionSix = await deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: revisionSix });
    assert.deepEqual([retriedRevisionSix.status, retriedRevisionSix.body.accepted], [200, true]);
    assert.equal((await pool.query("SELECT 1 FROM telemetry_presence_history WHERE device_id=$1 AND revision=6", [ownerDevice.id])).rowCount, 1, "the same revision succeeds once after rollback");

    const revisionSeven = payload(7, { location: { raw: "RR_MIC_L1", observed_at: "2026-09-29T12:04:00Z" }, ship: { name: "Test_Ship_7" } });
    const revisionEight = payload(8, { location: { raw: "RR_AREA18", observed_at: "2026-09-29T12:05:00Z" }, ship: { name: "Test_Ship_8" } });
    const [parallelSeven, parallelEight] = await Promise.all([
      deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: revisionSeven }),
      deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: revisionEight })
    ]);
    assert.deepEqual([parallelEight.status, parallelEight.body.accepted], [200, true]);
    if (parallelSeven.status === 200) assert.equal(parallelSeven.body.accepted, true);
    else assert.deepEqual([parallelSeven.status, parallelSeven.body.error, parallelSeven.body.current_revision], [409, "stale_revision", 8]);
    const [parallelDevice, parallelPresence, parallelHistory] = await Promise.all([
      pool.query("SELECT last_presence_revision FROM telemetry_devices WHERE id=$1", [ownerDevice.id]),
      pool.query("SELECT revision,location_raw,ship_name FROM telemetry_presence WHERE device_id=$1", [ownerDevice.id]),
      pool.query("SELECT revision,location_raw,ship_name FROM telemetry_presence_history WHERE device_id=$1 AND revision IN (7,8) ORDER BY revision", [ownerDevice.id])
    ]);
    assert.equal(Number(parallelDevice.rows[0].last_presence_revision), 8);
    assert.deepEqual(parallelPresence.rows[0], { revision: "8", location_raw: "RR_AREA18", ship_name: "Test_Ship_8" });
    assert.deepEqual(parallelHistory.rows, parallelSeven.status === 200
      ? [{ revision: "7", location_raw: "RR_MIC_L1", ship_name: "Test_Ship_7" }, { revision: "8", location_raw: "RR_AREA18", ship_name: "Test_Ship_8" }]
      : [{ revision: "8", location_raw: "RR_AREA18", ship_name: "Test_Ship_8" }], "parallel revisions store only complete, accepted projections");

    const pageOne = await getHistory(runtime.baseUrl, ownerSession, "?limit=2");
    assert.equal(pageOne.status, 200);
    assert.equal(pageOne.body.entries.length, 2);
    assert.ok(pageOne.body.next_cursor);
    const pageTwo = await getHistory(runtime.baseUrl, ownerSession, `?limit=2&cursor=${encodeURIComponent(pageOne.body.next_cursor)}`);
    assert.equal(pageTwo.status, 200);
    const allIds = [...pageOne.body.entries, ...pageTwo.body.entries].map((entry) => entry.id);
    assert.equal(new Set(allIds).size, allIds.length, "keyset pages contain no duplicate row");
    assert.ok(pageOne.body.entries[0].received_at >= pageOne.body.entries[1].received_at);
    const unknownEntry = [...pageOne.body.entries, ...pageTwo.body.entries].find((entry) => entry.location_raw === null && entry.ship_name === null);
    assert.ok(unknownEntry, "paginated history preserves a genuinely unknown location and ship");
    assert.equal(unknownEntry.time_source, "received");
    assert.deepEqual((await getHistory(runtime.baseUrl, otherSession)).body.entries.map((entry) => entry.device_id), [otherDevice.id], "another account sees only its own history");
    assert.equal((await getHistory(runtime.baseUrl, ownerSession, "?limit=101")).status, 400);
    assert.equal((await getHistory(runtime.baseUrl, ownerSession, "?cursor=not-a-cursor")).status, 400);

    const invalidCredential = await deviceRequest(runtime.baseUrl, { credential: "vlt_invalid", body: payload(1) });
    assert.equal(invalidCredential.status, 401);
    const beforeBlockCount = Number((await pool.query("SELECT count(*)::int AS count FROM telemetry_presence_history WHERE device_id=$1", [ownerDevice.id])).rows[0].count);
    const blocked = await apiRequest(runtime.baseUrl, "/api/admin/users/status", { method: "POST", session: adminSession, form: { user_id: ids.owner, status: "blocked" } });
    assert.equal(blocked.status, 200);
    assert.equal((await deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: payload(6) })).status, 403);
    assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM telemetry_presence_history WHERE device_id=$1", [ownerDevice.id])).rows[0].count), beforeBlockCount);
    assert.equal((await getHistory(runtime.baseUrl, ownerSession)).status, 401, "deactivation removes browser sessions and blocks history access");
    assert.equal((await apiRequest(runtime.baseUrl, "/api/admin/users/status", { method: "POST", session: adminSession, form: { user_id: ids.owner, status: "active" } })).status, 200);
    ownerSession = await createSession(pool, pepper, ids.owner);
    assert.ok((await getHistory(runtime.baseUrl, ownerSession)).body.entries.length > 0, "reactivation restores access to retained, unexpired history");

    await deviceRequest(runtime.baseUrl, { credential: siblingDevice.credential, body: payload(1) });
    const beforeRevokeHistory = Number((await pool.query("SELECT count(*)::int AS count FROM telemetry_presence_history WHERE device_id=$1", [ownerDevice.id])).rows[0].count);
    const crossOriginRevoke = await crossOriginMutation(runtime.baseUrl, `/api/me/telemetry/devices/${ownerDevice.id}`, { session: ownerSession, method: "DELETE" });
    assert.deepEqual([crossOriginRevoke.status, crossOriginRevoke.body.error], [401, "login required"]);
    assert.equal((await pool.query("SELECT revoked_at FROM telemetry_devices WHERE id=$1", [ownerDevice.id])).rows[0].revoked_at, null, "cross-origin request cannot revoke a device");
    const missingOriginRevoke = await managementRequest(runtime.baseUrl, `/api/me/telemetry/devices/${ownerDevice.id}`, { session: ownerSession, method: "DELETE", origin: null });
    assert.deepEqual([missingOriginRevoke.status, missingOriginRevoke.body.error], [401, "login required"]);
    assert.equal((await pool.query("SELECT revoked_at FROM telemetry_devices WHERE id=$1", [ownerDevice.id])).rows[0].revoked_at, null, "missing Origin cannot revoke a device");
    const revoked = await managementRequest(runtime.baseUrl, `/api/me/telemetry/devices/${ownerDevice.id}`, { method: "DELETE", session: ownerSession });
    assert.equal(revoked.status, 204);
    assert.equal((await pool.query("SELECT 1 FROM telemetry_presence WHERE device_id=$1", [ownerDevice.id])).rowCount, 0, "revoke deletes current presence atomically");
    assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM telemetry_presence_history WHERE device_id=$1", [ownerDevice.id])).rows[0].count), beforeRevokeHistory, "revoked device's existing history remains for the retention period");
    const revokedHeartbeat = await heartbeatRequest(runtime.baseUrl, ownerDevice.credential);
    assert.deepEqual([revokedHeartbeat.status, revokedHeartbeat.body.error], [401, "device_revoked"]);
    const historyBeforeRevokedPresence = Number((await pool.query("SELECT count(*)::int AS count FROM telemetry_presence_history WHERE device_id=$1", [ownerDevice.id])).rows[0].count);
    const revokedPresence = await deviceRequest(runtime.baseUrl, { credential: ownerDevice.credential, body: payload(6) });
    assert.deepEqual([revokedPresence.status, revokedPresence.body.error], [401, "device_revoked"]);
    assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM telemetry_presence_history WHERE device_id=$1", [ownerDevice.id])).rows[0].count), historyBeforeRevokedPresence, "revoked device cannot add a history entry");
    assert.equal((await deviceRequest(runtime.baseUrl, { credential: siblingDevice.credential, body: payload(2) })).status, 200, "sibling device remains usable");
    assert.equal((await pool.query("SELECT 1 FROM telemetry_presence WHERE device_id=$1", [siblingDevice.id])).rowCount, 1);

    const ownerHistoryBeforeDelete = Number((await pool.query("SELECT count(*)::int AS count FROM telemetry_presence_history h JOIN telemetry_devices d ON d.id=h.device_id WHERE d.app_user_id=$1", [ids.owner])).rows[0].count);
    const crossOriginHistoryDelete = await crossOriginMutation(runtime.baseUrl, "/api/me/telemetry/history", { session: ownerSession, method: "DELETE" });
    assert.deepEqual([crossOriginHistoryDelete.status, crossOriginHistoryDelete.body.error], [401, "login required"]);
    assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM telemetry_presence_history h JOIN telemetry_devices d ON d.id=h.device_id WHERE d.app_user_id=$1", [ids.owner])).rows[0].count), ownerHistoryBeforeDelete, "cross-origin request cannot delete private history");
    const missingOriginHistoryDelete = await managementRequest(runtime.baseUrl, "/api/me/telemetry/history", { session: ownerSession, method: "DELETE", origin: null });
    assert.deepEqual([missingOriginHistoryDelete.status, missingOriginHistoryDelete.body.error], [401, "login required"]);
    assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM telemetry_presence_history h JOIN telemetry_devices d ON d.id=h.device_id WHERE d.app_user_id=$1", [ids.owner])).rows[0].count), ownerHistoryBeforeDelete, "missing Origin cannot delete private history");
    const deleteHistory = await managementRequest(runtime.baseUrl, "/api/me/telemetry/history", { method: "DELETE", session: ownerSession });
    assert.deepEqual([deleteHistory.status, deleteHistory.body.deleted], [200, ownerHistoryBeforeDelete]);
    assert.equal((await pool.query("SELECT 1 FROM telemetry_devices WHERE id=$1", [siblingDevice.id])).rowCount, 1);
    assert.equal((await pool.query("SELECT 1 FROM telemetry_presence WHERE device_id=$1", [siblingDevice.id])).rowCount, 1, "history deletion leaves device and current presence intact");
    assert.equal((await getHistory(runtime.baseUrl, ownerSession)).body.entries.length, 0);
    assert.deepEqual((await getHistory(runtime.baseUrl, otherSession)).body.entries.map((entry) => entry.device_id), [otherDevice.id], "owner deletion leaves another user's history intact");

    const deleteDevice = await pairDevice(runtime.baseUrl, deleteOwnerSession, "Delete Cascade Device");
    assert.equal((await deviceRequest(runtime.baseUrl, { credential: deleteDevice.credential, body: payload(1) })).status, 200);
    const cleanupRows = await pool.query(
      `INSERT INTO telemetry_presence_history(device_id,revision,location_raw,location_observed_at,received_at)
       VALUES ($1,2,'OLD_A','2026-06-01T00:00:00Z',clock_timestamp()-interval '92 days'),
              ($1,3,'OLD_B','2026-06-02T00:00:00Z',clock_timestamp()-interval '91 days'),
              ($1,4,'FRESH','2026-09-01T00:00:00Z',clock_timestamp()-interval '89 days')
       RETURNING id,revision`,
      [deleteDevice.id]
    );
    const oldHistoryIds = cleanupRows.rows.filter((row) => [2, 3].includes(Number(row.revision))).map((row) => row.id);
    const deleteOwnerHistoryBeforeCleanup = await getHistory(runtime.baseUrl, deleteOwnerSession);
    assert.equal(deleteOwnerHistoryBeforeCleanup.status, 200);
    assert.equal(deleteOwnerHistoryBeforeCleanup.body.entries.some((entry) => oldHistoryIds.includes(entry.id)), false, "API hides expired history before cleanup runs");
    assert.equal(await cleanupExpiredTelemetryHistory(pool, 1), 1, "one cleanup batch never exceeds its configured bound");
    const afterFirstCleanup = await pool.query("SELECT revision FROM telemetry_presence_history WHERE device_id=$1 ORDER BY revision", [deleteDevice.id]);
    assert.equal(afterFirstCleanup.rowCount, 3, "first batch removes only one expired row");
    assert.ok(afterFirstCleanup.rows.some((row) => Number(row.revision) === 4), "history still within retention remains");
    assert.equal(await cleanupExpiredTelemetryHistory(pool, 1), 1, "a later batch continues the expiry backlog");
    const afterSecondCleanup = await pool.query("SELECT revision FROM telemetry_presence_history WHERE device_id=$1 ORDER BY revision", [deleteDevice.id]);
    assert.deepEqual(afterSecondCleanup.rows.map((row) => Number(row.revision)), [1, 4], "only expired rows were physically removed");
    await pool.query("DELETE FROM dashboard_sessions WHERE app_user_id=$1", [ids.deleteOwner]);
    await pool.query("DELETE FROM app_users WHERE id=$1", [ids.deleteOwner]);
    assert.equal((await pool.query("SELECT 1 FROM telemetry_devices WHERE id=$1", [deleteDevice.id])).rowCount, 0);
    assert.equal((await pool.query("SELECT 1 FROM telemetry_presence_history WHERE device_id=$1", [deleteDevice.id])).rowCount, 0, "hard account deletion cascades history immediately");
    const deletedCredential = await deviceRequest(runtime.baseUrl, { credential: deleteDevice.credential, body: payload(2) });
    assert.deepEqual([deletedCredential.status, deletedCredential.body.error], [401, "invalid_device_credential"]);
    assert.match(deletedCredential.headers.get("www-authenticate") ?? "", /^Bearer\b/i);
  } finally {
    if (runtime) await stopMissionTestServer(runtime);
    await pool?.end();
    if (schemaName) await dropC8TestSchema(adminPool, schemaName);
    await adminPool?.end();
  }
});
