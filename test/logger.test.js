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
  const value = redact({ password: "secret", authorization: "Bearer abcdefghijklmnopqrstuvwxyz0123456789", cookie: "session=secret", session_token: "session-secret", recovery_token: "recovery-secret", DATABASE_URL: "postgresql://user:password@host/db", SINK_TOKEN_PEPPER: "pepper", DISCORD_BOT_TOKEN: "bot", DISCORD_WEBHOOK_URL: "webhook", UEX_API_TOKEN: "uex", token: "vl_abcdefghijklmnopqrstuvwxyz012345678901234567", nested: { cookie: "private" } });
  assert.deepEqual(value.password, "[redacted]");
  assert.deepEqual(value.authorization, "[redacted]");
  assert.deepEqual(value.token, "[redacted]");
  assert.equal(value.session_token, "[redacted]");
  assert.equal(value.recovery_token, "[redacted]");
  assert.equal(value.nested.cookie, "[redacted]");
  assert.equal(value.DATABASE_URL, "[redacted]");
});

test("redaction preserves internal correlation IDs and build metadata", () => {
  const value = redact({ request_id: "71a65d6e-9b7a-4c1a-a7bf-1234567890ab", user_id: "8fd2131a-9b7a-4c1a-a7bf-1234567890ab", app_user_id: "8fd2131a-9b7a-4c1a-a7bf-1234567890ab", group_id: "41c73333-9b7a-4c1a-a7bf-1234567890ab", resource_id: "resource-123", order_id: "order-123", material_id: "material-123", location_id: "location-123", app_commit: "abcdef0123456789abcdef0123456789abcdef01" });
  assert.equal(value.request_id, "71a65d6e-9b7a-4c1a-a7bf-1234567890ab");
  assert.equal(value.user_id, "8fd2131a-9b7a-4c1a-a7bf-1234567890ab");
  assert.equal(value.group_id, "41c73333-9b7a-4c1a-a7bf-1234567890ab");
  assert.equal(value.app_commit, "abcdef0123456789abcdef0123456789abcdef01");
});

test("server correlates auth, route-not-found and polling access logs without logging request bodies", async () => {
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(server, /const authLogPaths = new Set\(\["\/auth\/register", "\/auth\/login", "\/auth\/recover", "\/logout"\]\)/);
  assert.match(server, /res\.setHeader\("x-request-id", req\.requestId\)/);
  assert.match(server, /auth\.login\.failed/);
  assert.match(server, /auth\.rate_limited/);
  assert.match(server, /http\.route_not_found/);
  assert.match(server, /pollingPaths\.has\(url\.pathname\) \? "DEBUG" : "INFO"/);
  assert.doesNotMatch(server.match(/const logApiRequest[\s\S]*?const materialHtml/)?.[0] || "", /readBody\(req\)/);
});

test("access logs retain request IDs and retention only removes VerseLink log files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "verselink-logger-"));
  try {
    const now = Date.parse("2026-09-11T12:00:00.000Z");
    await writeFile(join(directory, "2026-07-01_access.log"), "old\n");
    await writeFile(join(directory, "2026-07-01_verselink.log"), "old\n");
    await writeFile(join(directory, "unrelated-2026-07-01.log"), "keep\n");
    const logger = createLogger({ logDirectory: directory, now: () => now, retentionDays: 30 });
    await logger.cleanupRetention();
    await assert.rejects(readFile(join(directory, "2026-07-01_access.log")));
    await assert.rejects(readFile(join(directory, "2026-07-01_verselink.log")));
    assert.equal(await readFile(join(directory, "unrelated-2026-07-01.log"), "utf8"), "keep\n");
    const requestId = "71a65d6e-9b7a-4c1a-a7bf-1234567890ab";
    logger.access({ request_id: requestId, user_id: "8fd2131a-9b7a-4c1a-a7bf-1234567890ab", method: "GET", path: "/api/material-inventory/moves", status: 500, duration_ms: 3 }, "ERROR");
    logger.error("material.move.failed", new Error("destination location not found"), { request_id: requestId, user_id: "8fd2131a-9b7a-4c1a-a7bf-1234567890ab" }, { group_id: "41c73333-9b7a-4c1a-a7bf-1234567890ab" });
    await logger.flush();
    const access = await readFile(join(directory, "2026-09-11_access.log"), "utf8");
    const events = await readFile(join(directory, "2026-09-11_verselink.log"), "utf8");
    assert.match(access, new RegExp(requestId));
    assert.match(events, new RegExp(requestId));
    assert.match(events, /destination location not found/);
    assert.match(events, /41c73333-9b7a-4c1a-a7bf-1234567890ab/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

