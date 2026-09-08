import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

test("dashboard sessions are app-user-only at runtime and legacy rows are cleaned at startup", () => {
  const session = server.match(/const getSessionContext[\s\S]*?const getCurrentAppUser/)?.[0] || "";
  const createSession = server.match(/const createDashboardSession[\s\S]*?const accessibleBlueprintQuery/)?.[0] || "";
  assert.match(server, /DELETE FROM dashboard_sessions WHERE token_hash IS NOT NULL/);
  assert.match(session, /SELECT ds\.app_user_id/);
  assert.doesNotMatch(session, /token_hash|scmdb_connections/);
  assert.match(createSession, /INSERT INTO dashboard_sessions \(session_hash, app_user_id, expires_at\)/);
  assert.doesNotMatch(createSession, /token_hash/);
});

test("only registered active SCMDB connected services may ingest", () => {
  const sink = server.match(/url\.pathname\.startsWith\("\/v1\/scmdb\/"\)[\s\S]*?if \(req\.method === "GET" && \["\/", "\/index\.html"\]/)?.[0] || "";
  assert.match(sink, /app_user_id IS NOT NULL/);
  assert.match(sink, /connection_status IN \('pending', 'connected'\)/);
  assert.match(sink, /error: "sink not registered"/);
  assert.doesNotMatch(sink, /INSERT INTO scmdb_connections/);
});

test("the compatibility shell has no SCMDB login or sink-token creation fallback", async () => {
  const preview = await readFile(new URL("../public/ui-preview.html", import.meta.url), "utf8");
  assert.doesNotMatch(preview, /SINK TOKEN AUTHENTICATION|CREATE SINK TOKEN|fetch\('\/session'/);
});
