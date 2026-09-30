import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { apiRequest, createSession, startMissionTestServer, stopMissionTestServer } from "./helpers/mission-integration.js";
import { createC6TestPool, createC8TestSchema, dropC8TestSchema, resolveC6TestDatabaseUrl } from "./helpers/c6-test-database.js";

const databaseUrl = resolveC6TestDatabaseUrl(process.env.TEST_DATABASE_URL);
const pepper = "telemetry-c9-e2e-integration-test-pepper";
const presencePath = "/api/telemetry/presence";

const deviceRequest = async (baseUrl, path, { credential, method = "POST", body } = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const text = await response.text();
  let responseBody = null;
  if (text) {
    try { responseBody = JSON.parse(text); } catch { throw new Error("telemetry API returned invalid JSON"); }
  }
  return { status: response.status, body: responseBody, headers: response.headers };
};

const snapshot = (revision, location, observedAt) => ({
  schema: 1,
  revision,
  session_active: true,
  shard: "synthetic-private-shard",
  location: { raw: location, observed_at: observedAt },
  jurisdiction: "Stanton",
  ship: { name: "RSI_Hermes" },
  quantum: null,
  party_count: 2,
  last_event_at: observedAt
});

const assertNotIncluded = (value, forbidden, fieldLabel) => {
  assert.ok(!value.includes(forbidden), `private projection unexpectedly includes ${fieldLabel}`);
};

test("C9 privacy assertion failures identify fields without echoing their values", () => {
  const secret = "synthetic-device-credential-secret";
  assert.throws(
    () => assertNotIncluded(`serialized=${secret}`, secret, "device credential"),
    (error) => error.message.includes("device credential") && !error.message.includes(secret)
  );
});

test("C9 end-to-end pairing, heartbeat, presence history, privacy, and revocation use isolated PostgreSQL", { skip: !databaseUrl }, async (t) => {
  let adminPool, pool, runtime, schemaName;
  const ownerId = randomUUID();
  const otherId = randomUUID();
  const secrets = [];
  const logDirectory = join(tmpdir(), `telemetry-c9-${process.pid}-${randomUUID()}`);
  try {
    adminPool = await createC6TestPool(databaseUrl);
    schemaName = `c9_e2e_${randomUUID().replaceAll("-", "")}`;
    await createC8TestSchema(adminPool, schemaName);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-c search_path=${schemaName},public`);

    // Initialize the repository schema in this test-owned namespace before fixtures are inserted.
    runtime = await startMissionTestServer({ databaseUrl: scoped.toString(), pepper, logDirectory });
    await stopMissionTestServer(runtime);
    runtime = null;
    pool = await createC6TestPool(scoped.toString());
    await pool.query(
      `INSERT INTO app_users (id,email,display_name,account_status) VALUES
       ($1,$2,'C9 E2E Owner','active'),($3,$4,'C9 E2E Other','active')`,
      [ownerId, `c9-${ownerId}@example.test`, otherId, `c9-${otherId}@example.test`]
    );
    const ownerSession = await createSession(pool, pepper, ownerId);
    const otherSession = await createSession(pool, pepper, otherId);
    secrets.push(ownerSession, otherSession);
    runtime = await startMissionTestServer({
      databaseUrl: scoped.toString(),
      pepper,
      logDirectory,
      extraEnv: { VERSELINK_APP_URL: "http://localhost:3000" }
    });

    const pair = async (session, name) => {
      const created = await apiRequest(runtime.baseUrl, "/api/me/telemetry/pairing", {
        method: "POST", session, json: { schema: 1 }
      });
      assert.equal(created.status, 201);
      secrets.push(created.body.code);
      const claimed = await apiRequest(runtime.baseUrl, "/api/telemetry/pair", {
        method: "POST", json: { schema: 1, code: created.body.code, device_name: name }
      });
      assert.equal(claimed.status, 201);
      secrets.push(claimed.body.device_credential);
      return { id: claimed.body.device_id, credential: claimed.body.device_credential };
    };

    const device = await pair(ownerSession, "C9 primary");
    const sibling = await pair(ownerSession, "C9 sibling");
    const foreign = await pair(otherSession, "C9 foreign");

    await t.test("C3-issued credential authenticates heartbeat without changing gameplay state", async () => {
      const receivedAt = new Date("2020-01-01T00:00:00Z");
      await pool.query("UPDATE telemetry_devices SET last_seen_at=$1 WHERE id=ANY($2::uuid[])", [receivedAt, [device.id, sibling.id]]);
      const response = await deviceRequest(runtime.baseUrl, "/api/telemetry/heartbeat", {
        credential: device.credential, body: { schema: 1 }
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.schema, 1);
      assert.equal(response.body.ok, true);
      const row = (await pool.query(
        "SELECT last_seen_at,last_presence_revision FROM telemetry_devices WHERE id=$1", [device.id]
      )).rows[0];
      assert.ok(row.last_seen_at.toISOString() === response.body?.received_at, "heartbeat receipt must match persisted last_seen_at");
      assert.equal(row.last_presence_revision, "0");
      assert.equal((await pool.query("SELECT 1 FROM telemetry_presence WHERE device_id=$1", [device.id])).rowCount, 0);
    });

    await t.test("changed client snapshots persist current state and private accepted history", async () => {
      for (const [revision, location, observedAt] of [
        [1, "RR_CRU_L1", "2026-09-30T10:00:00.123456789Z"],
        [2, "RR_MIC_L1", "2026-09-30T10:01:00.123456789Z"]
      ]) {
        const response = await deviceRequest(runtime.baseUrl, presencePath, {
          credential: device.credential,
          method: "PUT",
          body: snapshot(revision, location, observedAt)
        });
        assert.ok(
          response.status === 200 && response.body?.accepted === true && response.body?.revision === revision,
          "accepted presence response must confirm the expected revision"
        );
      }
      const current = (await pool.query(
        "SELECT revision,location_raw,location_observed_at,received_at FROM telemetry_presence WHERE device_id=$1", [device.id]
      )).rows[0];
      assert.deepEqual([Number(current.revision), current.location_raw, current.location_observed_at], [2, "RR_MIC_L1", "2026-09-30T10:01:00.123456789Z"]);
      const history = await pool.query(
        "SELECT revision,location_raw,location_observed_at FROM telemetry_presence_history WHERE device_id=$1 ORDER BY revision", [device.id]
      );
      assert.deepEqual(history.rows, [
        { revision: "1", location_raw: "RR_CRU_L1", location_observed_at: "2026-09-30T10:00:00.123456789Z" },
        { revision: "2", location_raw: "RR_MIC_L1", location_observed_at: "2026-09-30T10:01:00.123456789Z" }
      ]);
      assert.equal((await pool.query("SELECT 1 FROM telemetry_presence_history WHERE device_id=$1", [foreign.id])).rowCount, 0);
      const serialized = JSON.stringify({ current: current, history: history.rows });
      for (const [forbidden, fieldLabel] of [
        ["synthetic-private-shard", "shard"],
        ["party_count", "party_count"],
        ["credential", "credential field"],
        [device.credential, "device credential"]
      ]) {
        assertNotIncluded(serialized, forbidden, fieldLabel);
      }
      const ownerHistory = await apiRequest(runtime.baseUrl, "/api/me/telemetry/history", { session: ownerSession });
      const foreignHistory = await apiRequest(runtime.baseUrl, "/api/me/telemetry/history", { session: otherSession });
      assert.equal(ownerHistory.status, 200);
      assert.deepEqual(ownerHistory.body.entries.map((entry) => entry.device_id).filter((id) => id === device.id).length, 2);
      assert.equal(foreignHistory.body.entries.length, 0, "foreign account history must be empty");
    });

    await t.test("revocation blocks both device APIs, retains existing private history, and isolates sibling device", async () => {
      const beforeHistory = Number((await pool.query(
        "SELECT count(*)::int AS count FROM telemetry_presence_history WHERE device_id=$1", [device.id]
      )).rows[0].count);
      const revoke = await apiRequest(runtime.baseUrl, `/api/me/telemetry/devices/${device.id}`, { method: "DELETE", session: ownerSession });
      assert.equal(revoke.status, 204);
      assert.equal((await pool.query("SELECT 1 FROM telemetry_presence WHERE device_id=$1", [device.id])).rowCount, 0);
      assert.equal(Number((await pool.query(
        "SELECT count(*)::int AS count FROM telemetry_presence_history WHERE device_id=$1", [device.id]
      )).rows[0].count), beforeHistory);

      for (const [path, method, body] of [
        ["/api/telemetry/heartbeat", "POST", { schema: 1 }],
        [presencePath, "PUT", snapshot(3, "RR_AREA18", "2026-09-30T10:02:00Z")]
      ]) {
        const lastSeenBefore = method === "POST"
          ? (await pool.query("SELECT last_seen_at FROM telemetry_devices WHERE id=$1", [device.id])).rows[0].last_seen_at.toISOString()
          : null;
        const denied = await deviceRequest(runtime.baseUrl, path, { credential: device.credential, method, body });
        assert.ok(denied.status === 401, "revoked device request must return HTTP 401");
        assert.ok(denied.body?.error === "device_revoked", "revoked device request must report device_revoked");
        assert.ok(denied.headers.get("www-authenticate") === "Bearer", "revoked device response must include a Bearer challenge");
        if (method === "POST") {
          const lastSeenAfter = (await pool.query("SELECT last_seen_at FROM telemetry_devices WHERE id=$1", [device.id])).rows[0].last_seen_at.toISOString();
          assert.equal(lastSeenAfter, lastSeenBefore, "rejected revoked heartbeat must not update last_seen_at");
        }
      }
      assert.equal(Number((await pool.query(
        "SELECT count(*)::int AS count FROM telemetry_presence_history WHERE device_id=$1", [device.id]
      )).rows[0].count), beforeHistory, "rejected revoked requests do not append history");

      const siblingHeartbeat = await deviceRequest(runtime.baseUrl, "/api/telemetry/heartbeat", {
        credential: sibling.credential, body: { schema: 1 }
      });
      assert.equal(siblingHeartbeat.status, 200, "revoking one device leaves its sibling authenticated");
      const siblingPresence = await deviceRequest(runtime.baseUrl, presencePath, {
        credential: sibling.credential, method: "PUT", body: snapshot(1, "RR_CRU_L2", "2026-09-30T10:03:00Z")
      });
      assert.ok(siblingPresence.status === 200 && siblingPresence.body?.accepted === true, "sibling device presence must remain accepted");
    });

    const output = runtime.output.join("");
    const files = await readdir(logDirectory).catch(() => []);
    const logs = (await Promise.all(files.map((file) => readFile(join(logDirectory, file), "utf8").catch(() => "")))).join("\n");
    for (const secret of secrets.filter(Boolean)) {
      assert.equal(output.includes(secret), false, "pairing, session, or device credential appeared in server output");
      assert.equal(logs.includes(secret), false, "pairing, session, or device credential appeared in application logs");
    }
    assert.ok(!/credential_hash/i.test(output + logs), "server output must not expose credential hashes");
  } finally {
    try { await stopMissionTestServer(runtime); } finally {
      try { if (pool) await pool.end(); } finally {
        if (adminPool) {
          try { if (schemaName) await dropC8TestSchema(adminPool, schemaName); }
          finally { await adminPool.end(); }
        }
      }
    }
  }
});

test("CI provides the PostgreSQL C9 end-to-end test database", () => {
  if (process.env.CI) assert.ok(databaseUrl, "TEST_DATABASE_URL must be set in CI");
});
