import assert from "node:assert/strict";
import test from "node:test";
import {
  createTelemetryAuthInFlightLimiter,
  TELEMETRY_AUTH_IN_FLIGHT_GLOBAL,
  TELEMETRY_AUTH_IN_FLIGHT_MAX_PEERS,
  TELEMETRY_AUTH_IN_FLIGHT_PER_PEER
} from "../src/telemetry-auth-inflight.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("heartbeat auth slot is reserved synchronously before the auth lookup starts", async () => {
  const limiter = createTelemetryAuthInFlightLimiter({ perPeerLimit: 1, globalLimit: 1 });
  let authStarted = false;
  const result = await limiter.run("peer-a", async () => {
    authStarted = true;
    assert.deepEqual(limiter.snapshot(), { activeTotal: 1, peerCount: 1 });
    return "authenticated";
  }, () => "saturated");

  assert.equal(authStarted, true);
  assert.equal(result, "authenticated");
  assert.deepEqual(limiter.snapshot(), { activeTotal: 0, peerCount: 0 });
});

test("parallel requests from one peer cannot exceed its limit and saturation is immediate", async () => {
  const limiter = createTelemetryAuthInFlightLimiter({ perPeerLimit: 2, globalLimit: 8 });
  const firstGate = deferred();
  const secondGate = deferred();
  let authLookups = 0;
  const runLookup = (gate) => limiter.run("same-peer", async () => {
    authLookups += 1;
    await gate.promise;
    return "done";
  }, () => ({ status: 429, body: { error: "rate_limited" }, retryAfter: 1 }));

  const first = runLookup(firstGate);
  const second = runLookup(secondGate);
  const rejected = await runLookup(deferred());
  assert.deepEqual(rejected, { status: 429, body: { error: "rate_limited" }, retryAfter: 1 });
  assert.equal(authLookups, 2);
  assert.deepEqual(limiter.snapshot(), { activeTotal: 2, peerCount: 1 });

  firstGate.resolve();
  secondGate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ["done", "done"]);
  assert.deepEqual(limiter.snapshot(), { activeTotal: 0, peerCount: 0 });
});

test("different peers share the global cap without bypassing per-peer caps", async () => {
  const limiter = createTelemetryAuthInFlightLimiter({ perPeerLimit: 3, globalLimit: 3 });
  const gates = [deferred(), deferred(), deferred()];
  let authLookups = 0;
  const launch = (peer, gate) => limiter.run(peer, async () => {
    authLookups += 1;
    await gate.promise;
  }, () => "saturated");

  const active = [launch("peer-a", gates[0]), launch("peer-a", gates[1]), launch("peer-b", gates[2])];
  assert.equal(await launch("peer-c", deferred()), "saturated");
  assert.equal(authLookups, 3);
  assert.deepEqual(limiter.snapshot(), { activeTotal: 3, peerCount: 2 });

  gates.forEach((gate) => gate.resolve());
  await Promise.all(active);
  assert.deepEqual(limiter.snapshot(), { activeTotal: 0, peerCount: 0 });
});

test("slots release after auth outcomes, exceptions, and rate-limit responses", async () => {
  for (const outcome of ["success", "unauthorized", "forbidden", "rate-limited"]) {
    const limiter = createTelemetryAuthInFlightLimiter({ perPeerLimit: 1, globalLimit: 1 });
    assert.equal(await limiter.run("peer", async () => outcome, () => "saturated"), outcome);
    assert.deepEqual(limiter.snapshot(), { activeTotal: 0, peerCount: 0 }, outcome);
  }

  const limiter = createTelemetryAuthInFlightLimiter({ perPeerLimit: 1, globalLimit: 1 });
  await assert.rejects(limiter.run("peer", async () => { throw new Error("auth database failed"); }, () => "saturated"), /auth database failed/);
  assert.deepEqual(limiter.snapshot(), { activeTotal: 0, peerCount: 0 });
  assert.equal(await limiter.run("peer", async () => "next request admitted", () => "saturated"), "next request admitted");
});

test("peer-map capacity rejects a new peer without evicting active slots", async () => {
  const limiter = createTelemetryAuthInFlightLimiter({ perPeerLimit: 2, globalLimit: 4, maxPeers: 2 });
  const gateA = deferred();
  const gateB = deferred();
  const first = limiter.run("peer-a", () => gateA.promise, () => "saturated");
  const second = limiter.run("peer-b", () => gateB.promise, () => "saturated");

  assert.equal(await limiter.run("peer-c", async () => "lookup", () => "saturated"), "saturated");
  assert.deepEqual(limiter.snapshot(), { activeTotal: 2, peerCount: 2 });
  gateA.resolve();
  await first;
  assert.deepEqual(limiter.snapshot(), { activeTotal: 1, peerCount: 1 });
  assert.equal(await limiter.run("peer-c", async () => "admitted", () => "saturated"), "admitted");
  assert.deepEqual(limiter.snapshot(), { activeTotal: 1, peerCount: 1 });
  gateB.resolve();
  await second;
  assert.deepEqual(limiter.snapshot(), { activeTotal: 0, peerCount: 0 });
});

test("production limits are small, fixed, and the peer map is bounded", () => {
  assert.equal(TELEMETRY_AUTH_IN_FLIGHT_PER_PEER, 4);
  assert.equal(TELEMETRY_AUTH_IN_FLIGHT_GLOBAL, 8);
  assert.equal(TELEMETRY_AUTH_IN_FLIGHT_MAX_PEERS, 2048);
});
