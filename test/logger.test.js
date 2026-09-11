import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, normalizeLogLevel, redact } from "../src/logger.js";

test("LOG_LEVEL defaults invalid values to INFO and filters levels", () => {
  const logger = createLogger({ defaultLevel: "not-a-level", logDirectory: join(tmpdir(), "verselink-logger-unit") });
  assert.equal(normalizeLogLevel("DEBUG"), "DEBUG");
  assert.equal(logger.getState().default_level, "INFO");
  assert.equal(logger.isEnabled("ERROR"), true);
  assert.equal(logger.isEnabled("INFO"), true);
  assert.equal(logger.isEnabled("DEBUG"), false);
});

test("runtime logging override resets safely and is never persistent state", () => {
  let callback;
  const logger = createLogger({ defaultLevel: "WARN", logDirectory: join(tmpdir(), "verselink-logger-unit"), setTimer: (fn) => { callback = fn; return 1; }, clearTimer: () => {} });
  logger.setRuntimeOverride("DEBUG", 60, { user_id: "admin-id" });
  assert.equal(logger.getState().effective_level, "DEBUG");
  assert.equal(logger.getState().runtime_override, true);
  logger.resetRuntimeOverride({ user_id: "admin-id" });
  assert.equal(logger.getState().effective_level, "WARN");
  logger.setRuntimeOverride("ERROR", 5);
  callback();
  assert.equal(logger.getState().runtime_override, false);
  assert.equal(logger.getState().effective_level, "WARN");
});

test("redaction protects tokens, credentials and authorization values", () => {
  const value = redact({ password: "secret", authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123456789", token: "vl_abcdefghijklmnopqrstuvwxyz012345678901234567", url: "postgresql://user:password@host/db" });
  assert.deepEqual(value.password, "[redacted]");
  assert.deepEqual(value.authorization, "[redacted]");
  assert.deepEqual(value.token, "[redacted]");
  assert.doesNotMatch(value.url, /password|postgresql:\/\//i);
});

test("access logs retain request IDs and retention only removes VerseLink log files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verselink-logger-"));
  try {
    const now = Date.parse("2026-09-11T12:00:00.000Z");
    await writeFile(join(directory, "access-2026-07-01.log"), "old\n");
    await writeFile(join(directory, "verselink-2026-07-01.log"), "old\n");
    await writeFile(join(directory, "unrelated-2026-07-01.log"), "keep\n");
    const logger = createLogger({ logDirectory: directory, now: () => now, retentionDays: 30 });
    await logger.cleanupRetention();
    await assert.rejects(readFile(join(directory, "access-2026-07-01.log")));
    await assert.rejects(readFile(join(directory, "verselink-2026-07-01.log")));
    assert.equal(await readFile(join(directory, "unrelated-2026-07-01.log"), "utf8"), "keep\n");
    logger.access({ request_id: "request-123", method: "GET", path: "/api/me", status: 200, duration_ms: 3 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const access = await readFile(join(directory, "access-2026-09-11.log"), "utf8");
    assert.match(access, /request-123/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

