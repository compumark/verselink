import assert from "node:assert/strict";
import test from "node:test";
import { createTelemetryPresenceHandler, projectPresence, validatePresencePayload } from "../src/telemetry-presence.js";

const valid = (overrides = {}) => ({
  schema: 1, revision: 1, session_active: true, shard: "pu-test-01",
  location: { raw: "RR_CRU_L1", observed_at: "2026-09-24T12:00:00.123456789Z" },
  jurisdiction: "Stanton", ship: { name: "RSI_Hermes" },
  quantum: { destination: "LOC_CRU_L1", state: "target_selected" }, party_count: 2,
  last_event_at: "2026-09-24T12:00:02.456Z", ...overrides
});

test("C7 validates schema 1 then explicitly projects only persisted fields", () => {
  const body = valid({ player_handle: "NotAllowed", geid: "secret", extra: { unsafe: true } });
  const result = validatePresencePayload(body);
  assert.equal(result.error, undefined);
  assert.equal(result.snapshot.location_observed_at, "2026-09-24T12:00:00.123456789Z");
  assert.equal(Object.hasOwn(result.snapshot, "shard"), false);
  assert.equal(Object.hasOwn(result.snapshot, "party_count"), false);
  assert.deepEqual(Object.keys(projectPresence(body)).sort(), [
    "jurisdiction", "last_event_at", "location_observed_at", "location_raw",
    "quantum_destination", "quantum_state", "schema_version", "session_active", "ship_name"
  ]);
});

test("C7 requires nullable schema-1 keys and validates discarded shard and party count", () => {
  for (const key of ["session_active", "shard", "location", "jurisdiction", "ship", "quantum", "party_count", "last_event_at"]) {
    const body = valid(); delete body[key];
    assert.equal(validatePresencePayload(body).error, "invalid_payload", `${key} omission`);
  }
  for (const value of ["x".repeat(129), 3]) {
    assert.equal(validatePresencePayload(valid({ shard: value })).error, "invalid_payload");
  }
  for (const value of [-1, 101, 1.5, "2"]) {
    assert.equal(validatePresencePayload(valid({ party_count: value })).error, "invalid_payload");
  }
  assert.equal(validatePresencePayload(valid({ shard: null, party_count: null })).error, undefined);
});

test("C7 rejects malformed, impossible, or offset-free timestamps", () => {
  for (const value of ["2026-02-30T12:00:00Z", "2026-09-24T12:00:00", "yesterday", "2026-09-24T25:00:00Z"]) {
    assert.equal(validatePresencePayload(valid({ last_event_at: value })).error, "invalid_payload", value);
  }
  assert.equal(validatePresencePayload(valid({ last_event_at: null, location: null })).error, undefined);
});

test("C7 transactionally accepts newer snapshots, ignores excluded fields, and enforces revision idempotency", async () => {
  let highWater = 0, stored = null, receivedAtWrites = 0;
  const client = { async query(sql, params = []) {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
    if (sql.includes("SELECT d.last_presence_revision")) return { rowCount: 1, rows: [{ last_presence_revision: highWater }] };
    if (sql.includes("SELECT schema_version,session_active")) return { rowCount: stored ? 1 : 0, rows: stored ? [stored] : [] };
    if (sql.startsWith("UPDATE telemetry_devices")) { highWater = Number(params[1]); return { rowCount: 1, rows: [] }; }
    if (sql.startsWith("INSERT INTO telemetry_presence")) {
      stored = Object.fromEntries(["schema_version", "session_active", "location_raw", "location_observed_at", "jurisdiction", "ship_name", "quantum_destination", "quantum_state", "last_event_at"].map((key, index) => [key, params[[1,3,4,5,6,7,8,9,10][index]]]));
      receivedAtWrites++;
      return { rowCount: 1, rows: [{ received_at: "2026-09-24T12:00:00.000000Z" }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }, release() {} };
  const handler = createTelemetryPresenceHandler({
    pool: { connect: async () => client }, pepper: "test-pepper",
    requestRateLimit: { consume: () => ({ allowed: true }) },
    authInFlight: { run: async (_key, callback) => callback() },
    authenticate: async () => ({ context: { deviceId: "device", appUserId: "owner" } }),
    readJson: async (_req, max) => { assert.equal(max, 16 * 1024); return { body: currentBody }; },
    sendJson: (_res, status, body) => { result = { status, body }; },
    sendError: (_res, status, error) => { result = { status, body: { error } }; },
    sendRateLimited: () => {}, logger: { warn() {} }
  });
  let currentBody = valid(), result;
  const invoke = async (body) => { currentBody = body; result = null; await handler({ headers: {}, requestId: "test" }, { setHeader() {}, end() {} }); return result; };
  assert.deepEqual(await invoke(valid()), { status: 200, body: { schema: 1, accepted: true, revision: 1, received_at: "2026-09-24T12:00:00.000000Z" } });
  assert.equal(highWater, 1);
  assert.equal(Object.hasOwn(stored, "shard"), false);
  assert.equal(Object.hasOwn(stored, "party_count"), false);
  assert.equal(receivedAtWrites, 1);
  assert.deepEqual(await invoke(valid({ shard: "different", party_count: 99 })), { status: 200, body: { schema: 1, accepted: false, revision: 1 } });
  assert.equal(receivedAtWrites, 1, "duplicate must not refresh received_at");
  assert.deepEqual(await invoke(valid({ location: { raw: "OTHER", observed_at: "2026-09-24T12:00:00.123456789Z" } })), { status: 409, body: { error: "revision_conflict", current_revision: 1 } });
  assert.deepEqual(await invoke(valid({ revision: 0 })), { status: 400, body: { error: "invalid_payload" } });
});
