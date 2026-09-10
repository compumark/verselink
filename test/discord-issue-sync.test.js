import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { buildIssueSummary, buildMessage, chooseType, desiredTagNames, issueStatus, mergeAppliedTags, sanitizeDiscordText, synchronizeIssue, truncateTitle } from "../.github/scripts/discord-issue-sync.mjs";

const base = { number: 42, title: "A title", html_url: "https://github.com/compumark/verselink/issues/42", user: { login: "octo" }, labels: [], state: "open", body: "hello" };
test("chooses one primary tag by priority", () => assert.equal(chooseType(["issue", "enhancement", "bug"]), "bug"));
test("computes lifecycle tags", () => { assert.deepEqual(desiredTagNames({ ...base, labels: [{ name: "bug" }, { name: "in progress" }] }), ["bug", "in progress"]); assert.deepEqual(desiredTagNames({ ...base, state: "closed", state_reason: "not_planned" }), ["issue", "not implemented"]); });
test("preserves unmanaged forum tags", () => assert.deepEqual(mergeAppliedTags(["custom", "old-status"], [{ id: "custom", name: "community" }, { id: "old-status", name: "completed" }, { id: "bug", name: "bug" }], ["bug"]), ["custom", "bug"]));
test("computes issue status", () => assert.equal(issueStatus({ ...base, labels: ["status/in progress"] }), "In Progress"));
test("keeps issue number while truncating title", () => assert.ok(truncateTitle(42, "x".repeat(200)).startsWith("[#42] ")));
test("sanitizes Discord mentions", () => assert.equal(sanitizeDiscordText("@everyone <@123> <@&456>"), "@\u200beveryone @123 @456"));
test("message retains URL and disables nothing in content", () => assert.match(buildMessage(base), /GitHub Issue/));
test("issue form messages include only description and compact real logs", () => {
  const form = `### Description\n${"A".repeat(650)}\n\n### Steps to reproduce\nsecret steps\n\n### Expected behavior\nexpected detail\n\n### Actual behavior\nactual detail\n\n### Logs / error messages\n${"E".repeat(260)}\n\n### Additional context\nprivate detail`;
  const message = buildMessage({ ...base, body: form });
  assert.match(message, /^.*A{599}…/s);
  assert.match(message, /\*\*Error\*\*\nE{200}… Full logs on GitHub\./);
  for (const excluded of ["secret steps", "expected detail", "actual detail", "private detail"]) assert.doesNotMatch(message, new RegExp(excluded));
});
test("empty issue-form logs are omitted", () => {
  for (const emptyLog of ["No response", "N/A", "None", "-\n-"]) assert.equal(buildIssueSummary(`### Description\nBrief\n\n### Logs / error messages\n${emptyLog}`).error, "");
});
test("new issues create a forum post without a GitHub request", async () => {
  const discordCalls = [];
  const discordRequest = async (path, options = {}) => {
    discordCalls.push({ path, options });
    if (path === "/channels/forum") return { id: "forum", guild_id: "guild", type: 15, available_tags: [{ id: "bug-tag", name: "bug" }] };
    if (path === "/guilds/guild/threads/active") return { threads: [{ id: "other-thread", parent_id: "other-forum", name: "[#42] Unrelated post", applied_tags: [] }] };
    if (path === "/channels/forum/threads/archived/public?limit=100") return { threads: [], has_more: false };
    if (path === "/channels/forum/threads") return { id: "thread", guild_id: "guild" };
    throw new Error(`unexpected Discord call: ${path}`);
  };
  const result = await synchronizeIssue({ issue: { ...base, labels: ["bug"] }, forumChannelId: "forum", discordRequest });
  assert.deepEqual(result, { action: "created", threadId: "thread" });
  assert.deepEqual(discordCalls.map(call => call.path), ["/channels/forum", "/guilds/guild/threads/active", "/channels/forum/threads/archived/public?limit=100", "/channels/forum/threads"]);
  const payload = JSON.parse(discordCalls[3].options.body);
  assert.deepEqual(payload.applied_tags, ["bug-tag"]);
  assert.deepEqual(payload.message.allowed_mentions, { parse: [] });
});
test("existing forum posts update by issue-number prefix without a GitHub request", async () => {
  const discordCalls = [];
  const discordRequest = async (path, options = {}) => {
    discordCalls.push({ path, options });
    if (path === "/channels/forum") return { id: "forum", guild_id: "guild", type: 15, available_tags: [{ id: "bug-tag", name: "bug" }] };
    if (path === "/guilds/guild/threads/active") return { threads: [{ id: "thread", parent_id: "forum", name: "[#42] Old title", applied_tags: [] }] };
    if (path === "/channels/thread") return {};
    if (path === "/channels/thread/messages/thread") return {};
    throw new Error(`unexpected Discord call: ${path}`);
  };
  const result = await synchronizeIssue({ issue: { ...base, labels: ["bug"] }, forumChannelId: "forum", discordRequest });
  assert.deepEqual(result, { action: "updated", threadId: "thread" });
  assert.deepEqual(discordCalls.map(call => call.path), ["/channels/forum", "/guilds/guild/threads/active", "/channels/thread", "/channels/thread/messages/thread"]);
  assert.equal(discordCalls.some(call => call.path === "/channels/forum/threads"), false);
});
test("archived forum posts update by issue-number prefix without a GitHub request", async () => {
  const discordCalls = [];
  const discordRequest = async (path, options = {}) => {
    discordCalls.push({ path, options });
    if (path === "/channels/forum") return { id: "forum", guild_id: "guild", type: 15, available_tags: [{ id: "bug-tag", name: "bug" }] };
    if (path === "/guilds/guild/threads/active") return { threads: [] };
    if (path === "/channels/forum/threads/archived/public?limit=100") return { threads: [{ id: "thread", name: "[#42] Archived title", applied_tags: [] }], has_more: false };
    if (path === "/channels/thread") return {};
    if (path === "/channels/thread/messages/thread") return {};
    throw new Error(`unexpected Discord call: ${path}`);
  };
  const result = await synchronizeIssue({ issue: { ...base, labels: ["bug"] }, forumChannelId: "forum", discordRequest });
  assert.deepEqual(result, { action: "updated", threadId: "thread" });
  assert.equal(discordCalls.some(call => call.path === "/channels/forum/threads"), false);
});
test("workflow serializes simultaneous events for the same repository issue", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/discord-issues.yml", import.meta.url), "utf8");
  assert.match(workflow, /concurrency:\s*\n\s*group: discord-issue-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.issue\.number \}\}\s*\n\s*cancel-in-progress: false/);
});
