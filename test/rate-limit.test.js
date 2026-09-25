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

test("request limiter expires windows and bounds its memory", () => {
  let now = 0;
  const limiter = createRequestRateLimiter({ limit: 1, windowMs: 100, maxEntries: 2, now: () => now });
  assert.equal(limiter.consume("a").allowed, true);
  assert.equal(limiter.consume("b").allowed, true);
  assert.equal(limiter.consume("c").allowed, true);
  assert.equal(limiter.size(), 2);
  now = 101;
  assert.equal(limiter.consume("b").allowed, true);
  assert.equal(limiter.size(), 1);
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
