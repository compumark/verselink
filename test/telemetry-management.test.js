import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelemetryManagementHandlers,
  insertAcceptedPresenceHistory,
  TELEMETRY_HISTORY_MAX_PAGE_SIZE
} from "../src/telemetry-management.js";

const ownerId = "c1200000-0000-4000-8000-000000000001";
const deviceId = "c1200000-0000-4000-8000-000000000002";
const account = { id: ownerId, account_status: "active" };
const response = () => ({
  status: null,
  headers: {},
  body: null,
  writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
  setHeader(name, value) { this.headers[name] = value; },
  end(body = "") { this.body = body ? JSON.parse(body) : null; }
});
const limiter = () => ({ consume: () => ({ allowed: true }) });
const makeHandlers = ({ pool, getAccount = async () => account, readJson = async () => ({ body: { schema: 1, name: "Test Device" } }) } = {}) => createTelemetryManagementHandlers({
  pool,
  getAccount,
  readJson,
  logger: { warn() {} },
  listRateLimit: limiter(),
  mutationRateLimit: limiter(),
  historyRateLimit: limiter(),
  sendJson: (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); },
  sendError: (res, status, error) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error })); }
});

test("device listing is owner-scoped and projects no credential fields", async () => {
  let query;
  const handlers = makeHandlers({ pool: { query: async (sql, params) => { query = { sql, params }; return { rows: [{ id: deviceId, name: "PC", online: false }] }; } } });
  const res = response();
  await handlers.listDevices({ requestId: "req" }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(query.params, [ownerId]);
  assert.match(query.sql, /WHERE d\.app_user_id=\$1/);
  assert.doesNotMatch(query.sql, /credential_hash|app_user_id\s*,/i);
  assert.deepEqual(res.body.devices, [{ id: deviceId, name: "PC", online: false }]);
});

test("foreign device rename is indistinguishable from missing and invalid names do not query", async () => {
  let calls = 0;
  const handlers = makeHandlers({ pool: { query: async () => { calls += 1; return { rowCount: 0, rows: [] }; } } });
  const missing = response();
  await handlers.renameDevice({ requestId: "req" }, missing, deviceId);
  assert.deepEqual([missing.status, missing.body], [404, { error: "not_found" }]);
  assert.equal(calls, 1);

  const invalid = response();
  const invalidHandlers = makeHandlers({ pool: { query: async () => { calls += 1; return { rowCount: 0, rows: [] }; } }, readJson: async () => ({ body: { schema: 1, name: "   " } }) });
  await invalidHandlers.renameDevice({ requestId: "req" }, invalid, deviceId);
  assert.deepEqual([invalid.status, invalid.body], [400, { error: "invalid_payload" }]);
  assert.equal(calls, 1);
});

test("device revoke serializes the owned tombstone and current-presence deletion", async () => {
  const statements = [];
  const client = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (/SELECT id FROM telemetry_devices/.test(sql)) return { rowCount: 1, rows: [{ id: deviceId }] };
      return { rowCount: 1, rows: [] };
    },
    release() {}
  };
  const handlers = makeHandlers({ pool: { connect: async () => client } });
  const res = response();
  await handlers.revokeDevice({ requestId: "req" }, res, deviceId);
  assert.equal(res.status, 204);
  assert.deepEqual(statements.map(({ sql }) => sql.trim().split(/\s+/)[0]), ["BEGIN", "SELECT", "UPDATE", "DELETE", "COMMIT"]);
  assert.match(statements[1].sql, /id=\$1 AND app_user_id=\$2 FOR UPDATE/);
  assert.match(statements[2].sql, /COALESCE\(revoked_at,clock_timestamp\(\)\)/);
  assert.match(statements[3].sql, /DELETE FROM telemetry_presence WHERE device_id=\$1/);
  assert.doesNotMatch(statements.map(({ sql }) => sql).join(" "), /DELETE FROM telemetry_presence_history/);
});

test("history page has bounded owner-only keyset pagination and unknown-safe fields", async () => {
  let query;
  const rows = Array.from({ length: 3 }, (_, i) => ({
    id: `c1200000-0000-4000-8000-00000000000${i + 3}`,
    device_id: deviceId,
    device_name: "PC",
    location_raw: i === 1 ? null : "RR_CRU_L1",
    jurisdiction: null,
    ship_name: null,
    location_observed_at: null,
    received_at: `2026-09-29T12:00:0${i}.000000Z`
  }));
  const handlers = makeHandlers({ pool: { query: async (sql, params) => { query = { sql, params }; return { rows }; } } });
  const res = response();
  await handlers.listHistory({ requestId: "req" }, res, new URL("http://localhost/api/me/telemetry/history?limit=2"));
  assert.equal(res.status, 200);
  assert.match(query.sql, /d\.app_user_id=\$1/);
  assert.deepEqual(query.params, [ownerId, null, null, 3]);
  assert.equal(res.body.entries.length, 2);
  assert.equal(res.body.entries[0].time_source, "received");
  assert.equal(res.body.entries[0].observed_at, null);
  assert.equal(res.body.entries[0].location_raw, "RR_CRU_L1");
  assert.equal(res.body.entries[0].ship_name, null);
  assert.equal(res.body.entries[1].location_raw, null, "unknown location is preserved rather than inferred");
  assert.equal(typeof res.body.next_cursor, "string");
  const cursorResponse = response();
  await handlers.listHistory({ requestId: "req" }, cursorResponse, new URL(`http://localhost/api/me/telemetry/history?limit=2&cursor=${encodeURIComponent(res.body.next_cursor)}`));
  assert.ok(query.params[1]);
  assert.ok(query.params[2]);
  assert.equal(TELEMETRY_HISTORY_MAX_PAGE_SIZE, 100);
});

test("history rejects impossible cursor timestamps before querying PostgreSQL", async () => {
  let queried = false;
  const handlers = makeHandlers({ pool: { query: async () => { queried = true; return { rows: [] }; } } });
  const cursor = Buffer.from(JSON.stringify({ received_at: "2026-99-99T12:00:00.000000Z", id: deviceId })).toString("base64url");
  const res = response();
  await handlers.listHistory({ requestId: "req" }, res, new URL(`http://localhost/api/me/telemetry/history?cursor=${cursor}`));
  assert.deepEqual([res.status, res.body], [400, { error: "invalid_payload" }]);
  assert.equal(queried, false);
});

test("history deletion is owner-scoped and does not delete devices or snapshots", async () => {
  const statements = [];
  const client = { async query(sql, params) { statements.push({ sql, params }); return { rowCount: 2, rows: [] }; }, release() {} };
  const handlers = makeHandlers({ pool: { connect: async () => client } });
  const res = response();
  await handlers.deleteHistory({ requestId: "req" }, res);
  assert.equal(res.status, 200);
  assert.match(statements[1].sql, /app_user_id=\$1 ORDER BY id FOR UPDATE/);
  assert.match(statements[2].sql, /DELETE FROM telemetry_presence_history h USING telemetry_devices d/);
  assert.match(statements[2].sql, /d\.app_user_id=\$1/);
  assert.doesNotMatch(statements.map(({ sql }) => sql).join(" "), /DELETE FROM telemetry_devices|DELETE FROM telemetry_presence /);
});

test("accepted history writes only the C7 allowlist with same-projection deduplication", async () => {
  let call;
  await insertAcceptedPresenceHistory({ query: async (sql, params) => { call = { sql, params }; return { rowCount: 1 }; } }, {
    deviceId,
    revision: 8,
    snapshot: { location_raw: "RR_CRU_L1", location_observed_at: "2026-09-29T12:00:00Z", jurisdiction: "Stanton", ship_name: "RSI_Hermes", party_count: 99, shard: "private" },
    receivedAt: "2026-09-29T12:00:01.000000Z"
  });
  assert.match(call.sql, /telemetry_presence_history/);
  assert.match(call.sql, /ORDER BY previous\.revision DESC/);
  assert.match(call.sql, /ON CONFLICT \(device_id,revision\) DO NOTHING/);
  assert.deepEqual(call.params, [deviceId, 8, "RR_CRU_L1", "2026-09-29T12:00:00Z", "Stanton", "RSI_Hermes", "2026-09-29T12:00:01.000000Z"]);
  assert.doesNotMatch(call.sql, /party_count|shard|quantum|last_event_at|credential/);
});
