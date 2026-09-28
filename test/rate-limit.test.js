import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter, createRequestRateLimiter } from "../src/rate-limit.js";

test("rate limiter allows failures up to the limit and blocks afterward", () => {
  let now = 0;
  const limiter = createRateLimiter({ limit: 2, windowMs: 100, now: () => now });
  assert.equal(limiter.allow("client"), true);
  limiter.recordFailure("client");
  assert.equal(limiter.allow("client"), true);
  limiter.recordFailure("client");
  assert.equal(limiter.allow("client"), false);
  now = 101;
  assert.equal(limiter.allow("client"), true);
});

test("rate limiter cleans expired entries and bounds memory", () => {
  let now = 0;
  const limiter = createRateLimiter({ limit: 1, windowMs: 100, maxEntries: 2, now: () => now });
  limiter.recordFailure("a");
  limiter.recordFailure("b");
  limiter.recordFailure("c");
  assert.equal(limiter.size(), 2);
  now = 101;
  limiter.cleanup();
  assert.equal(limiter.size(), 0);
});

test("rate limiter state stores only non-secret client keys", () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 100 });
  limiter.recordFailure("socket:127.0.0.1");
  assert.equal(limiter.size(), 1);
});

test("request limiter counts allowed requests and provides deterministic reset metadata", () => {
  let now = 1_000;
  const limiter = createRequestRateLimiter({ limit: 2, windowMs: 2_500, now: () => now });
  assert.deepEqual(limiter.consume("user"), { allowed: true, remaining: 1, resetAt: 3_500, retryAfter: 3 });
  assert.deepEqual(limiter.consume("user"), { allowed: true, remaining: 0, resetAt: 3_500, retryAfter: 3 });
  assert.deepEqual(limiter.consume("user"), { allowed: false, remaining: 0, resetAt: 3_500, retryAfter: 3 });
  now = 3_500;
  assert.deepEqual(limiter.consume("user"), { allowed: true, remaining: 1, resetAt: 6_000, retryAfter: 3 });
});

test("request limiter can preflight a bucket without consuming it", () => {
  let now = 1_000;
  const limiter = createRequestRateLimiter({ limit: 2, windowMs: 2_500, now: () => now });
  assert.equal(limiter.allow("peer"), true);
  assert.equal(limiter.size(), 0);
  assert.equal(limiter.consume("peer").allowed, true);
  assert.equal(limiter.allow("peer"), true);
  assert.equal(limiter.consume("peer").allowed, true);
  assert.equal(limiter.allow("peer"), false);
  assert.equal(limiter.consume("peer").allowed, false);
  now = 3_500;
  assert.equal(limiter.allow("peer"), true);
});

test("request limiter rejects new keys at capacity without evicting active budgets", () => {
  let now = 0;
  const limiter = createRequestRateLimiter({ limit: 2, windowMs: 100, maxEntries: 2, now: () => now });
  assert.equal(limiter.consume("a").allowed, true);
  assert.equal(limiter.consume("b").allowed, true);
  assert.equal(limiter.consume("a").allowed, true);
  assert.equal(limiter.consume("c").allowed, false);
  assert.equal(limiter.overflowCount(), 1);
  assert.equal(limiter.consume("a").allowed, false, "full-map key keeps its original request count");
  assert.equal(limiter.consume("d").allowed, false);
  assert.equal(limiter.overflowCount(), 2, "each capacity-rejected attempt is recorded once");
  assert.equal(limiter.size(), 2);

  now = 100;
  const admitted = limiter.consume("c");
  assert.equal(admitted.allowed, true, "an expired bucket is removed before new-key admission");
  assert.equal(admitted.retryAfter, 1);
  assert.equal(limiter.overflowCount(), 0);
  assert.equal(limiter.size(), 1);
});

test("request limiter keeps active credential-hash buckets through high-cardinality churn", () => {
  let now = 10;
  const limiter = createRequestRateLimiter({ limit: 120, windowMs: 60_000, maxEntries: 2, now: () => now });
  const active = "credential:hash-a";
  assert.equal(limiter.consume(active).allowed, true);
  assert.equal(limiter.consume("credential:hash-reserved").allowed, true);
  for (let i = 0; i < 100; i += 1) {
    const rejected = limiter.consume(`credential:hash-${i + 1}`);
    assert.equal(rejected.allowed, false);
    assert.equal(rejected.retryAfter, 60);
  }
  assert.equal(limiter.size(), 2);
  assert.equal(limiter.overflowCount(), 100);
  for (let i = 1; i < 120; i += 1) assert.equal(limiter.consume(active).allowed, true);
  assert.equal(limiter.consume(active).allowed, false, "churn must not reset the 120/min device budget");
  assert.equal(limiter.size(), 2);
});

test("request limiter preserves existing buckets when full and expires overflow at earliest window", () => {
  let now = 0;
  const limiter = createRequestRateLimiter({ limit: 3, windowMs: 100, maxEntries: 2, now: () => now });
  limiter.consume("first");
  now = 25;
  limiter.consume("second");
  const denied = limiter.consume("new");
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfter, 1);
  assert.equal(denied.capacityLimited, true);

  now = 100;
  assert.equal(limiter.consume("new").allowed, true);
  assert.equal(limiter.size(), 2);
  assert.equal(limiter.overflowCount(), 0);
  assert.equal(limiter.consume("second").allowed, true, "existing key can use its original window at full capacity");
});

test("existing failure limiter remains failure-counted and clears only explicitly", () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 100 });
  assert.equal(limiter.allow("client"), true);
  assert.equal(limiter.allow("client"), true);
  limiter.recordFailure("client");
  assert.equal(limiter.allow("client"), false);
  limiter.clear("client");
  assert.equal(limiter.allow("client"), true);
});
