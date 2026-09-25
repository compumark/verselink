import assert from "node:assert/strict";
import test from "node:test";
import { authenticateTelemetryDevice, deviceAuthHttpMetadata, parseDeviceAuthorization } from "../src/telemetry-device-auth.js";

const credential = `vlt_${"a".repeat(43)}`;
const bearer = (value = credential) => `Bearer ${value}`;

test("device Authorization parser accepts one exact Bearer credential unchanged", () => {
  assert.equal(parseDeviceAuthorization({ headers: { authorization: bearer() } }), credential);
});

test("device Authorization parser rejects missing and malformed credentials", () => {
  const invalid = [
    {}, { headers: {} }, { headers: { authorization: "" } },
    { headers: { authorization: "Bearer" } }, { headers: { authorization: "Bearer " } },
    { headers: { authorization: `bearer ${credential}` } },
    { headers: { authorization: `BEARER ${credential}` } },
    { headers: { authorization: `Bearer vl_${"a".repeat(43)}` } },
    { headers: { authorization: `Bearer vlr_${"a".repeat(43)}` } },
    { headers: { authorization: `Bearer vlt_${"a".repeat(42)}` } },
    { headers: { authorization: `Bearer vlt_${"a".repeat(42)}.` } },
    { headers: { authorization: ` Bearer ${credential}` } },
    { headers: { authorization: bearer() + " " } },
    { headers: { authorization: `${bearer()} extra` } },
    { headers: { authorization: `${bearer()}, ${bearer()}` } },
    { headers: { authorization: [bearer(), bearer()] } },
    { headers: {}, url: `/?device_credential=${credential}`, body: JSON.stringify({ device_credential: credential }) }
  ];
  for (const request of invalid) assert.equal(parseDeviceAuthorization(request), null);
});

test("device Authorization parser rejects duplicate raw and distinct headers", () => {
  assert.equal(parseDeviceAuthorization({
    rawHeaders: ["Authorization", bearer(), "authorization", bearer()],
    headers: { authorization: `${bearer()}, ${bearer()}` }
  }), null);
  assert.equal(parseDeviceAuthorization({ headersDistinct: { authorization: [bearer(), bearer()] }, headers: { authorization: bearer() } }), null);
  assert.equal(parseDeviceAuthorization({ rawHeaders: ["Authorization", bearer()], headers: { authorization: bearer() } }), credential);
});

test("device authentication maps failures and success to safe results", async () => {
  const hash = "a".repeat(64);
  const calls = [];
  const pool = { query: async (sql, values) => {
    calls.push({ sql, values });
    return { rowCount: 1, rows: [{ device_id: "device-id", app_user_id: "owner-id", revoked_at: null, account_status: "active" }] };
  } };
  const success = await authenticateTelemetryDevice({ request: { headers: { authorization: bearer() } }, pool, pepper: "test-pepper" });
  assert.deepEqual(success, { kind: "authenticated", context: { deviceId: "device-id", appUserId: "owner-id" } });
  assert.deepEqual(Object.keys(success.context).sort(), ["appUserId", "deviceId"]);
  assert.match(calls[0].sql, /WHERE d\.credential_hash = \$1/);
  assert.doesNotMatch(calls[0].sql, /revoked_at\s+IS\s+NULL|account_status\s*=\s*'active'/i);
  assert.equal(calls[0].values.length, 1);
  assert.match(calls[0].values[0], /^[0-9a-f]{64}$/);
  assert.notEqual(calls[0].values[0], hash);

  const missing = await authenticateTelemetryDevice({ request: { headers: { cookie: "bp_session=some-browser-session" } }, pool, pepper: "test-pepper" });
  assert.deepEqual(missing, { kind: "invalid_device_credential" });
  assert.equal(calls.length, 1, "missing bearer must be rejected before database lookup");
  assert.deepEqual(deviceAuthHttpMetadata(missing), { status: 401, body: { error: "invalid_device_credential" }, headers: { "WWW-Authenticate": "Bearer" } });

  const noMatch = await authenticateTelemetryDevice({ request: { headers: { authorization: bearer() } }, pool: { query: async () => ({ rowCount: 0, rows: [] }) }, pepper: "test-pepper" });
  assert.deepEqual(noMatch, { kind: "invalid_device_credential" });

  for (const [row, expected, metadata] of [
    [{ device_id: "secret-device", app_user_id: "secret-owner", revoked_at: new Date(), account_status: "blocked" }, "device_revoked", { status: 401, body: { error: "device_revoked" }, headers: { "WWW-Authenticate": "Bearer" } }],
    [{ device_id: "secret-device", app_user_id: "secret-owner", revoked_at: null, account_status: "deleted" }, "account_inactive", { status: 403, body: { error: "account_inactive" }, headers: {} }]
  ]) {
    const result = await authenticateTelemetryDevice({ request: { headers: { authorization: bearer() } }, pool: { query: async () => ({ rowCount: 1, rows: [row] }) }, pepper: "test-pepper" });
    assert.deepEqual(result, { kind: expected });
    assert.deepEqual(deviceAuthHttpMetadata(result), metadata);
    assert.equal(JSON.stringify(result).includes("secret-owner"), false);
    assert.equal(JSON.stringify(result).includes("secret-device"), false);
  }
});

test("database errors remain distinguishable from invalid credentials", async () => {
  const databaseError = new Error("database unavailable");
  await assert.rejects(authenticateTelemetryDevice({
    request: { headers: { authorization: bearer() } }, pool: { query: async () => { throw databaseError; } }, pepper: "test-pepper"
  }), (error) => error === databaseError);
});
