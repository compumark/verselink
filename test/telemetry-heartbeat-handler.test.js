import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createRequestRateLimiter, clientKey } from "../src/rate-limit.js";
import { createTelemetryAuthInFlightLimiter } from "../src/telemetry-auth-inflight.js";
import { createTelemetryHeartbeatHandler } from "../src/telemetry-heartbeat-handler.js";
import { hashDeviceCredential } from "../src/telemetry-pairing.js";

const credential = `vlt_${"a".repeat(43)}`;
const otherCredential = `vlt_${"b".repeat(43)}`;
const pepper = "heartbeat-handler-test-pepper";
const silentLogger = { warn() {} };

const readJson = async (req) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  try { return { body: JSON.parse(text) }; }
  catch { return { error: "invalid_payload", status: 400 }; }
};

const sendJson = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const sendError = (res, status, code, retryAfter) => {
  if (retryAfter !== undefined) res.setHeader("Retry-After", String(Math.max(0, Math.ceil(retryAfter))));
  return sendJson(res, status, { error: code });
};
const sendRateLimited = (res, req, _route, result) => sendError(res, 429, "rate_limited", result.retryAfter);

const startHandlerServer = async (overrides = {}) => {
  const limiter = overrides.requestRateLimit || createRequestRateLimiter({ limit: 120, windowMs: 60_000 });
  const consumedKeys = [];
  const trackedLimiter = {
    consume(key) {
      consumedKeys.push(key);
      return limiter.consume(key);
    }
  };
  const updates = [];
  const pool = overrides.pool || { async query(_sql, params) {
    updates.push(params);
    return { rowCount: 1, rows: [{ last_seen_at: new Date("2026-09-27T12:00:00Z") }] };
  } };
  const authenticate = overrides.authenticate || (async () => ({ kind: "authenticated", context: { deviceId: "device-1", appUserId: "owner-1" } }));
  const handler = createTelemetryHeartbeatHandler({
    pool,
    pepper,
    requestRateLimit: trackedLimiter,
    authInFlight: overrides.authInFlight || createTelemetryAuthInFlightLimiter(),
    authenticate,
    readJson,
    sendJson,
    sendError,
    sendRateLimited,
    logger: silentLogger
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/api/telemetry/heartbeat`;
  const post = async (token = credential, body = { schema: 1 }) => {
    const headers = { "content-type": "application/json" };
    if (token !== null) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json(), retryAfter: response.headers.get("retry-after") };
  };
  return {
    server, post, updates, consumedKeys,
    async close() { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  };
};

test("HTTP heartbeat counts each request once and rate-limits credentials before C4 auth", async (t) => {
  let authLookups = 0;
  const runtime = await startHandlerServer({ authenticate: async () => {
    authLookups += 1;
    return { kind: "authenticated", context: { deviceId: "device-1", appUserId: "owner-1" } };
  } });
  t.after(() => runtime.close());

  for (let attempt = 1; attempt <= 120; attempt += 1) {
    const response = await runtime.post();
    assert.equal(response.status, 200, `request ${attempt}`);
  }
  const limited = await runtime.post();
  assert.deepEqual([limited.status, limited.body], [429, { error: "rate_limited" }]);
  assert.ok(Number(limited.retryAfter) >= 1);
  assert.equal(authLookups, 120, "request 121 must be rejected before C4's database lookup");
  assert.equal(runtime.updates.length, 120);
  assert.equal(runtime.consumedKeys.length, 121, "each HTTP request consumes exactly one limiter unit");
  assert.ok(runtime.consumedKeys.every((key) => key === `credential:${hashDeviceCredential(pepper, credential)}`));
  assert.notEqual(runtime.consumedKeys[0], `credential:${credential}`, "raw credentials are not limiter keys");

  const nextCredential = await runtime.post(otherCredential);
  assert.equal(nextCredential.status, 200);
  assert.equal(runtime.consumedKeys.at(-1), `credential:${hashDeviceCredential(pepper, otherCredential)}`);
});

test("HTTP heartbeat capacity rejection is counted and happens before C4 auth or update", async (t) => {
  let authLookups = 0;
  const requestRateLimit = createRequestRateLimiter({ limit: 120, windowMs: 60_000, maxEntries: 1 });
  const runtime = await startHandlerServer({
    requestRateLimit,
    authenticate: async () => {
      authLookups += 1;
      return { kind: "authenticated", context: { deviceId: "device-1", appUserId: "owner-1" } };
    }
  });
  t.after(() => runtime.close());

  assert.equal((await runtime.post(credential)).status, 200);
  const denied = await runtime.post(otherCredential);
  assert.equal(denied.status, 429);
  assert.deepEqual(denied.body, { error: "rate_limited" });
  assert.ok(Number(denied.retryAfter) >= 1);
  assert.equal(requestRateLimit.overflowCount(), 1, "capacity-rejected request is counted once");
  assert.equal(authLookups, 1, "capacity rejection must precede C4 authentication");
  assert.equal(runtime.updates.length, 1, "capacity rejection must not update last_seen_at");
  assert.equal(runtime.consumedKeys.length, 2);
});

test("HTTP saturation consumes one request unit, skips extra auth/update, and admits later work", async (t) => {
  let releaseAuth;
  let markAuthStarted;
  const authStarted = new Promise((resolve) => { markAuthStarted = resolve; });
  let authLookups = 0;
  const runtime = await startHandlerServer({
    authInFlight: createTelemetryAuthInFlightLimiter({ perPeerLimit: 1, globalLimit: 1 }),
    authenticate: async () => {
      authLookups += 1;
      if (authLookups === 1) {
        markAuthStarted();
        await new Promise((resolve) => { releaseAuth = resolve; });
      }
      return { kind: "authenticated", context: { deviceId: "device-1", appUserId: "owner-1" } };
    }
  });
  t.after(async () => {
    releaseAuth?.();
    await runtime.close();
  });

  const firstPromise = runtime.post();
  await authStarted;
  const saturated = await runtime.post();
  assert.deepEqual([saturated.status, saturated.body, saturated.retryAfter], [429, { error: "rate_limited" }, "1"]);
  assert.equal(authLookups, 1, "saturated request must not start another C4 auth query");
  assert.equal(runtime.consumedKeys.length, 2, "the saturated request is counted once, not zero or twice");
  assert.equal(runtime.updates.length, 0, "no heartbeat last_seen update occurs while auth is held");

  releaseAuth();
  assert.equal((await firstPromise).status, 200);
  const later = await runtime.post();
  assert.equal(later.status, 200, "released auth capacity admits a later request");
  assert.equal(authLookups, 2);
  assert.equal(runtime.consumedKeys.length, 3);
  assert.equal(runtime.updates.length, 2);
});

test("HTTP heartbeat falls back to direct socket peer for malformed or missing Bearer", async (t) => {
  const runtime = await startHandlerServer({ authenticate: async () => ({ kind: "invalid_device_credential" }) });
  t.after(() => runtime.close());

  const missing = await runtime.post(null);
  assert.equal(missing.status, 401);
  const malformed = await runtime.post("not-a-vlt-credential");
  assert.equal(malformed.status, 401);
  // Both requests use the direct peer address, never a forwarded header or
  // malformed caller-supplied token.
  const peerBucket = `peer:${clientKey({ socket: { remoteAddress: "127.0.0.1" } })}`;
  assert.deepEqual(runtime.consumedKeys, [peerBucket, peerBucket]);
});

test("unknown valid credentials and invalid payloads consume one pre-auth request unit", async (t) => {
  let authLookups = 0;
  const runtime = await startHandlerServer({ authenticate: async () => {
    authLookups += 1;
    return authLookups === 1
      ? { kind: "invalid_device_credential" }
      : { kind: "authenticated", context: { deviceId: "device-1", appUserId: "owner-1" } };
  } });
  t.after(() => runtime.close());

  assert.equal((await runtime.post(otherCredential)).status, 401);
  assert.equal(runtime.consumedKeys[0], `credential:${hashDeviceCredential(pepper, otherCredential)}`);
  assert.equal(authLookups, 1, "an unknown but syntactically valid Bearer still runs fresh C4 authentication");

  const invalidPayload = await runtime.post(otherCredential, { schema: 1, unexpected: true });
  assert.deepEqual([invalidPayload.status, invalidPayload.body], [400, { error: "invalid_payload" }]);
  assert.equal(authLookups, 2, "non-rate-limited invalid payload is still authenticated without caching");
  assert.equal(runtime.consumedKeys.length, 2, "invalid payload is counted once before authentication");
});

test("auth database exceptions consume the selected credential bucket exactly once", async (t) => {
  const runtime = await startHandlerServer({ authenticate: async () => { throw new Error("database unavailable"); } });
  t.after(() => runtime.close());

  const response = await runtime.post();
  assert.deepEqual([response.status, response.body], [503, { error: "server_unavailable" }]);
  assert.deepEqual(runtime.consumedKeys, [`credential:${hashDeviceCredential(pepper, credential)}`]);
  assert.equal(runtime.updates.length, 0);
});
