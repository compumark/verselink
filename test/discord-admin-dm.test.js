import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { buildRegistrationDm, createDiscordAdminNotifier, formatRegistrationTimestamp } from "../src/discord-admin-dm.js";

const registration = { displayName: "New Pilot", userId: "3c4c12bf-7d3b-42b5-bd3f-72ebed1f2da1", registeredAt: "2026-09-10T12:34:56.000Z" };
const response = body => ({ ok: true, json: async () => body });
test("new registrations open one DM and send one safe notification", async () => {
  const calls = [];
  const notify = createDiscordAdminNotifier({ botToken: "bot-token", adminUserId: "123", environment: "Production", logger: { log() {}, warn() {} }, fetchImpl: async (url, options) => { calls.push({ url, options }); return response(calls.length === 1 ? { id: "dm-channel" } : { id: "message" }); } });
  assert.equal(await notify(registration), true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/users\/@me\/channels$/);
  assert.deepEqual(JSON.parse(calls[0].options.body), { recipient_id: "123" });
  assert.match(calls[1].url, /\/channels\/dm-channel\/messages$/);
  const payload = JSON.parse(calls[1].options.body);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.content, /New Pilot/);
  assert.match(payload.content, /3c4c12bf-7d3b-42b5-bd3f-72ebed1f2da1/);
  for (const secret of ["bot-token", "vl_", "vlr_", "bp_session", "127.0.0.1"]) assert.doesNotMatch(payload.content, new RegExp(secret));
});
test("missing bot token or recipient disables notification without network calls", async () => {
  for (const config of [{ botToken: "", adminUserId: "123" }, { botToken: "token", adminUserId: "" }]) {
    let calls = 0;
    const notify = createDiscordAdminNotifier({ ...config, logger: { log() {}, warn() {} }, fetchImpl: async () => { calls += 1; } });
    assert.equal(await notify(registration), false);
    assert.equal(calls, 0);
  }
});
test("Discord failures are contained without retrying", async () => {
  let calls = 0;
  const warnings = [];
  const notify = createDiscordAdminNotifier({ botToken: "token", adminUserId: "123", logger: { log() {}, warn(message) { warnings.push(message); } }, fetchImpl: async () => { calls += 1; throw new Error("network rejected"); } });
  assert.equal(await notify(registration), false);
  assert.equal(calls, 1);
  assert.deepEqual(warnings, ["[discord] registration DM failed"]);
});
test("Discord HTTP failures and malformed DM responses are contained", async () => {
  for (const firstResponse of [{ ok: false, status: 401, json: async () => ({}) }, { ok: false, status: 403, json: async () => ({}) }, { ok: false, status: 429, json: async () => ({}) }, { ok: false, status: 500, json: async () => ({}) }, response({})]) {
    let calls = 0;
    const notify = createDiscordAdminNotifier({ botToken: "token", adminUserId: "123", logger: { log() {}, warn() {} }, fetchImpl: async () => { calls += 1; return firstResponse; } });
    assert.equal(await notify(registration), false);
    assert.equal(calls, 1);
  }
});
test("only the committed registration route starts the notifier", async () => {
  const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
  const route = server.match(/url\.pathname === "\/auth\/register"[\s\S]*?\n    if \(req\.method === "POST" && url\.pathname === "\/auth\/recover"/)?.[0] || "";
  assert.match(route, /await client\.query\("COMMIT"\)[\s\S]*?res\.end[\s\S]*?void notifyNewUserRegistration/);
  assert.equal((server.match(/notifyNewUserRegistration\(/g) || []).length, 1);
  assert.doesNotMatch(server.match(/url\.pathname === "\/auth\/login"[\s\S]*/)?.[0] || "", /void notifyNewUserRegistration/);
});
test("DM content contains only registration metadata", () => {
  const content = buildRegistrationDm({ ...registration, environment: "DEV" });
  assert.match(content, /Environment: DEV/);
  assert.doesNotMatch(content, /token|cookie|password|ip address/i);
});
test("formats registration timestamps in fixed UTC English form", () => {
  assert.equal(formatRegistrationTimestamp("2026-09-10T09:01:30.820Z"), "10.Sep.2026, 09:01 UTC");
  assert.equal(formatRegistrationTimestamp("2026-01-05T07:04:00.000Z"), "05.Jan.2026, 07:04 UTC");
  assert.equal(formatRegistrationTimestamp("2026-12-24T18:30:00.000Z"), "24.Dec.2026, 18:30 UTC");
});
test("DM displays a UTC timestamp instead of the raw ISO string", () => {
  const rawTimestamp = "2026-09-10T09:01:30.820Z";
  const message = buildRegistrationDm({ ...registration, registeredAt: rawTimestamp });
  assert.match(message, /Registered: 10\.Sep\.2026, 09:01 UTC/);
  assert.doesNotMatch(message, new RegExp(rawTimestamp));
  assert.doesNotMatch(message, /\b(?:CET|CEST)\b/);
});
