import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  cleanupExpiredTelemetryHistory,
  createTelemetryHistoryCleanupRunner,
  TELEMETRY_HISTORY_CLEANUP_BATCH_SIZE
} from "../src/telemetry-history-cleanup.js";

test("history cleanup uses a bounded, ordered, parameterized expiry batch", async () => {
  let captured;
  const removed = await cleanupExpiredTelemetryHistory({
    query: async (sql, params) => { captured = { sql, params }; return { rowCount: 3 }; }
  }, 3);
  assert.equal(removed, 3);
  assert.match(captured.sql, /received_at < clock_timestamp\(\) - interval '90 days'/);
  assert.match(captured.sql, /ORDER BY received_at,id/);
  assert.match(captured.sql, /LIMIT \$1\s+FOR UPDATE SKIP LOCKED/);
  assert.match(captured.sql, /RETURNING history\.id/);
  assert.deepEqual(captured.params, [3]);
  assert.equal(TELEMETRY_HISTORY_CLEANUP_BATCH_SIZE, 500);
  await assert.rejects(() => cleanupExpiredTelemetryHistory({ query() {} }, 501), RangeError);
});

test("repeated cleanup runs advance through a backlog without touching fresh rows", async () => {
  const rows = [...Array.from({ length: 1201 }, (_, index) => ({ id: `expired-${index}`, ageDays: 91 + (index % 2) })),
    ...Array.from({ length: 17 }, (_, index) => ({ id: `fresh-${index}`, ageDays: 89 }))];
  const calls = [];
  const db = { async query(sql, params) {
    assert.match(sql, /received_at < clock_timestamp\(\) - interval '90 days'/);
    const expired = rows.filter((row) => row.ageDays > 90).slice(0, params[0]);
    const count = expired.length;
    for (const row of expired) rows.splice(rows.indexOf(row), 1);
    calls.push(count);
    return { rowCount: count };
  } };
  assert.deepEqual([
    await cleanupExpiredTelemetryHistory(db),
    await cleanupExpiredTelemetryHistory(db),
    await cleanupExpiredTelemetryHistory(db)
  ], [500, 500, 201]);
  assert.deepEqual(calls, [500, 500, 201]);
  assert.equal(rows.filter((row) => row.ageDays > 90).length, 0);
  assert.equal(rows.length, 17);
  assert.ok(rows.every((row) => row.ageDays <= 90), "all rows still inside retention remain untouched");
});

test("cleanup errors are contained and the next run can retry", async () => {
  let calls = 0;
  const warnings = [];
  const runner = createTelemetryHistoryCleanupRunner({
    db: { async query() { calls += 1; if (calls === 1) throw new Error("private database detail"); return { rowCount: 2 }; } },
    logger: { info() {}, warn(...args) { warnings.push(args); } }
  });
  assert.deepEqual(await runner(), { status: "failed", removed: 0 });
  assert.deepEqual(await runner(), { status: "complete", removed: 2 });
  assert.equal(calls, 2);
  assert.deepEqual(warnings, [["telemetry.history.cleanup.failed", { reason: "database_unavailable" }]]);
});

test("overlapping cleanup requests are coalesced and a later request is allowed", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runner = createTelemetryHistoryCleanupRunner({
    db: { async query() { calls += 1; if (calls === 1) await gate; return { rowCount: 0 }; } },
    logger: { info() {}, warn() {} }
  });
  const first = runner();
  await Promise.resolve();
  assert.deepEqual(await runner(), { status: "already_running", removed: 0 });
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await first, { status: "complete", removed: 0 });
  assert.deepEqual(await runner(), { status: "complete", removed: 0 });
  assert.equal(calls, 2);
});

test("server startup listens before launching cleanup and does not await it", async () => {
  const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  assert.match(source, /ensureSchema\(\)\.then\(\(\) => isTestRuntime \? undefined : syncReferenceData\(\)\)\.then\(\(\) => \{\s*server\.listen/);
  assert.match(source, /void telemetryHistoryCleanup\(\);\s*scheduleInviteCleanup\(\);/);
  assert.doesNotMatch(source, /ensureSchema\(\)\.then\(async\s*\(\)\s*=>\s*\{[^}]*telemetryHistoryCleanup/s);
});
