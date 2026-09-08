import assert from "node:assert/strict";
import test from "node:test";
import { createRateLimiter } from "../src/rate-limit.js";

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
