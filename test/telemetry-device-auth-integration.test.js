import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { authenticateTelemetryDevice } from "../src/telemetry-device-auth.js";
import { hashDeviceCredential, hashPairingCode, normalizePairingCode } from "../src/telemetry-pairing.js";
import { createSession, createTestPool, startMissionTestServer, stopMissionTestServer } from "./helpers/mission-integration.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const pepper = "telemetry-device-auth-integration-test-pepper";

const httpRequest = async (baseUrl, path, { session, authorization, json } = {}) => {
  const headers = {};
  if (session) headers.cookie = `bp_session=${session}`;
  if (authorization) headers.authorization = authorization;
  let body;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  }
  const response = await fetch(`${baseUrl}${path}`, { method: json === undefined ? "GET" : "POST", headers, body });
  const text = await response.text();
  let responseBody = null;
  try { responseBody = text ? JSON.parse(text) : null; } catch { responseBody = text; }
  return { status: response.status, body: responseBody, headers: response.headers };
};

test("C4 authenticates real C3-issued credentials against live PostgreSQL lifecycle state", { skip: !databaseUrl }, async (t) => {
  let adminPool;
  let pool;
  let runtime;
  let schemaName;
  const schemaLogDirectory = join(tmpdir(), `verselink-c4-auth-${process.pid}-${randomUUID()}`);
  const capturedSecrets = [];
  const ids = { owner: randomUUID(), deleteOwner: randomUUID() };
  try {
    adminPool = await createTestPool(databaseUrl);
    schemaName = `c4_auth_${randomUUID().replaceAll("-", "")}`;
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    const isolatedUrl = new URL(databaseUrl);
    isolatedUrl.searchParams.set("options", `-c search_path=${schemaName},public`);
    const scopedDatabaseUrl = isolatedUrl.toString();

    runtime = await startMissionTestServer({ databaseUrl: scopedDatabaseUrl, pepper, logDirectory: schemaLogDirectory });
    await stopMissionTestServer(runtime);
    runtime = null;

    pool = await createTestPool(scopedDatabaseUrl);
    await pool.query(
      `INSERT INTO app_users (id,email,display_name,account_status) VALUES
       ($1,$2,'C4 Owner','active'), ($3,$4,'C4 Delete Owner','active')`,
      [ids.owner, `c4-${ids.owner}@example.test`, ids.deleteOwner, `c4-${ids.deleteOwner}@example.test`]
    );
    const ownerSession = await createSession(pool, pepper, ids.owner);
    const deleteSession = await createSession(pool, pepper, ids.deleteOwner);
    capturedSecrets.push(ownerSession, deleteSession);
    runtime = await startMissionTestServer({ databaseUrl: scopedDatabaseUrl, pepper, logDirectory: schemaLogDirectory });

    const issueCredential = async (session) => {
      const created = await httpRequest(runtime.baseUrl, "/api/me/telemetry/pairing", { session, json: { schema: 1 } });
      assert.equal(created.status, 201, `pairing creation failed with ${created.status}`);
      const claimed = await httpRequest(runtime.baseUrl, "/api/telemetry/pair", { json: { schema: 1, code: created.body.code } });
      assert.equal(claimed.status, 201, `pairing claim failed with ${claimed.status}`);
      assert.match(claimed.body.device_credential, /^vlt_[A-Za-z0-9_-]{43}$/);
      const credential = claimed.body.device_credential;
      const hash = hashDeviceCredential(pepper, credential);
      capturedSecrets.push(created.body.code, normalizePairingCode(created.body.code), hash, credential, `Bearer ${credential}`);
      return { credential, deviceId: claimed.body.device_id, credentialHash: hash };
    };
    const auth = (credential) => authenticateTelemetryDevice({ request: { headers: { authorization: `Bearer ${credential}` } }, pool, pepper });
    const first = await issueCredential(ownerSession);
    const second = await issueCredential(ownerSession);
    const otherAccount = await issueCredential(deleteSession);

    await t.test("C3-issued credential authenticates the correct minimal owner/device context", async () => {
      const result = await auth(first.credential);
      assert.deepEqual(result, { kind: "authenticated", context: { deviceId: first.deviceId, appUserId: ids.owner } });
      assert.deepEqual(Object.keys(result.context).sort(), ["appUserId", "deviceId"]);
      assert.equal(JSON.stringify(result).includes(first.credential), false);
      assert.equal(JSON.stringify(result).includes(first.credentialHash), false);
    });

    await t.test("unknown/malformed credentials and browser cookies do not authenticate devices", async () => {
      const unknown = `vlt_${randomUUID().replaceAll("-", "").padEnd(43, "x")}`.slice(0, 47);
      const result = await auth(unknown);
      assert.deepEqual(result, { kind: "invalid_device_credential" });
      const malformed = await authenticateTelemetryDevice({ request: { headers: { authorization: "Bearer malformed" } }, pool, pepper });
      assert.deepEqual(malformed, { kind: "invalid_device_credential" });
      const cookieOnly = await authenticateTelemetryDevice({ request: { headers: { cookie: `bp_session=${ownerSession}` } }, pool, pepper });
      assert.deepEqual(cookieOnly, { kind: "invalid_device_credential" });
      capturedSecrets.push(unknown);

      const browserRoute = await httpRequest(runtime.baseUrl, "/api/me", { authorization: `Bearer ${first.credential}` });
      assert.equal(browserRoute.status, 401);
      assert.deepEqual(browserRoute.body, { error: "login required" });
    });

    await t.test("each device observes committed account block/reactivation and revocation independently", async () => {
      await pool.query("UPDATE telemetry_devices SET last_presence_revision=17,last_seen_at=now()-interval '1 hour' WHERE id=$1", [first.deviceId]);
      const beforeBlock = await pool.query("SELECT credential_hash,revoked_at,last_presence_revision,last_seen_at FROM telemetry_devices WHERE id=$1", [first.deviceId]);
      assert.equal((await auth(first.credential)).kind, "authenticated");
      const afterAuth = await pool.query("SELECT credential_hash,revoked_at,last_presence_revision,last_seen_at FROM telemetry_devices WHERE id=$1", [first.deviceId]);
      assert.deepEqual(afterAuth.rows[0], beforeBlock.rows[0]);
      await pool.query("UPDATE app_users SET account_status='blocked' WHERE id=$1", [ids.owner]);
      assert.deepEqual(await auth(first.credential), { kind: "account_inactive" });
      const duringBlock = await pool.query("SELECT credential_hash,revoked_at,last_presence_revision,last_seen_at FROM telemetry_devices WHERE id=$1", [first.deviceId]);
      assert.deepEqual(duringBlock.rows[0], beforeBlock.rows[0]);

      await pool.query("UPDATE app_users SET account_status='active' WHERE id=$1", [ids.owner]);
      assert.equal((await auth(first.credential)).kind, "authenticated");
      assert.equal((await auth(second.credential)).kind, "authenticated");
      await pool.query("UPDATE app_users SET account_status='deleted' WHERE id=$1", [ids.owner]);
      assert.deepEqual(await auth(second.credential), { kind: "account_inactive" });
      await pool.query("UPDATE app_users SET account_status='active' WHERE id=$1", [ids.owner]);

      const secondBefore = await pool.query("SELECT credential_hash,revoked_at,last_presence_revision FROM telemetry_devices WHERE id=$1", [second.deviceId]);
      await pool.query("UPDATE telemetry_devices SET revoked_at=now() WHERE id=$1", [first.deviceId]);
      assert.deepEqual(await auth(first.credential), { kind: "device_revoked" });
      assert.equal((await auth(second.credential)).kind, "authenticated");
      const secondAfter = await pool.query("SELECT credential_hash,revoked_at,last_presence_revision FROM telemetry_devices WHERE id=$1", [second.deviceId]);
      assert.deepEqual(secondAfter.rows[0], secondBefore.rows[0]);

      await pool.query("UPDATE app_users SET account_status='blocked' WHERE id=$1", [ids.owner]);
      assert.deepEqual(await auth(first.credential), { kind: "device_revoked" });
      await pool.query("UPDATE app_users SET account_status='active' WHERE id=$1", [ids.owner]);
      assert.deepEqual(await auth(first.credential), { kind: "device_revoked" });
    });

    await t.test("hard account deletion cascades devices and makes the old credential unknown", async () => {
      assert.equal((await auth(otherAccount.credential)).kind, "authenticated");
      const removedSessions = await pool.query("DELETE FROM dashboard_sessions WHERE app_user_id=$1", [ids.deleteOwner]);
      assert.equal(removedSessions.rowCount, 1);
      await pool.query("DELETE FROM app_users WHERE id=$1", [ids.deleteOwner]);
      const device = await pool.query("SELECT 1 FROM telemetry_devices WHERE id=$1", [otherAccount.deviceId]);
      assert.equal(device.rowCount, 0);
      assert.deepEqual(await auth(otherAccount.credential), { kind: "invalid_device_credential" });
    });

    await delay(100);
    const stdout = runtime.output.join("");
    const logFiles = await readdir(schemaLogDirectory).catch(() => []);
    const logText = (await Promise.all(logFiles.map((file) => readFile(join(schemaLogDirectory, file), "utf8").catch(() => "")))).join("\n");
    for (const secret of capturedSecrets.filter(Boolean)) {
      assert.equal(stdout.includes(secret), false, "credential or session secret appeared in server output");
      assert.equal(logText.includes(secret), false, "credential, hash, or session secret appeared in application logs");
    }
    assert.doesNotMatch(stdout + logText, /credential_hash/i);
    await stopMissionTestServer(runtime);
  } finally {
    await stopMissionTestServer(runtime);
    if (pool) await pool.end();
    if (adminPool) {
      try { if (schemaName) await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`); }
      finally { await adminPool.end(); }
    }
    await rm(schemaLogDirectory, { recursive: true, force: true });
  }
});

test("CI provides the PostgreSQL C4 device-authentication test database", () => {
  if (process.env.CI) assert.ok(databaseUrl, "TEST_DATABASE_URL must be set in CI");
});
