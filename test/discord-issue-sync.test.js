import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { buildIssueSummary, buildMessage, chooseType, desiredTagNames, issueStatus, mergeAppliedTags, parseThreadMarker, sanitizeDiscordText, synchronizeIssue, truncateTitle } from "../.github/scripts/discord-issue-sync.mjs";

const base = { number: 42, title: "A title", html_url: "https://github.com/compumark/verselink/issues/42", user: { login: "octo" }, labels: [], state: "open", body: "hello" };
test("chooses one primary tag by priority", () => assert.equal(chooseType(["issue", "enhancement", "bug"]), "bug"));
test("computes lifecycle tags", () => { assert.deepEqual(desiredTagNames({ ...base, labels: [{ name: "bug" }, { name: "in progress" }] }), ["bug", "in progress"]); assert.deepEqual(desiredTagNames({ ...base, state: "closed", state_reason: "not_planned" }), ["issue", "not implemented"]); });
test("preserves unmanaged forum tags", () => assert.deepEqual(mergeAppliedTags(["custom", "old-status"], [{ id: "custom", name: "community" }, { id: "old-status", name: "completed" }, { id: "bug", name: "bug" }], ["bug"]), ["custom", "bug"]));
test("computes issue status", () => assert.equal(issueStatus({ ...base, labels: ["status/in progress"] }), "In Progress"));
test("keeps issue number while truncating title", () => assert.ok(truncateTitle(42, "x".repeat(200)).startsWith("[#42] ")));
test("sanitizes Discord mentions", () => assert.equal(sanitizeDiscordText("@everyone <@123> <@&456>"), "@\u200beveryone @123 @456"));
test("parses mapping comments", () => assert.equal(parseThreadMarker("<!-- verselink-discord-thread:123456789012345678 -->"), "123456789012345678"));
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
test("new issues create directly without enumerating forum threads", async () => {
  const discordCalls = [];
  const githubCalls = [];
  const discordRequest = async (path, options = {}) => {
    discordCalls.push({ path, options });
    if (path === "/channels/forum") return { id: "forum", type: 15, available_tags: [{ id: "bug-tag", name: "bug" }] };
    if (path === "/channels/forum/threads") return { id: "thread", guild_id: "guild" };
    throw new Error(`unexpected Discord call: ${path}`);
  };
  const githubRequest = async (path, options = {}) => {
    githubCalls.push({ path, options });
    return options.method === "POST" ? {} : [];
  };
  const result = await synchronizeIssue({ issue: { ...base, labels: ["bug"] }, ownerRepo: "compumark/verselink", forumChannelId: "forum", discordRequest, githubRequest });
  assert.deepEqual(result, { action: "created", threadId: "thread" });
  assert.deepEqual(discordCalls.map(call => call.path), ["/channels/forum", "/channels/forum/threads"]);
  assert.equal(discordCalls.some(call => call.path.includes("/threads/active")), false);
  const payload = JSON.parse(discordCalls[1].options.body);
  assert.deepEqual(payload.applied_tags, ["bug-tag"]);
  assert.deepEqual(payload.message.allowed_mentions, { parse: [] });
  assert.equal(githubCalls.filter(call => call.options.method === "POST").length, 1);
});
test("workflow serializes simultaneous events for the same repository issue", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/discord-issues.yml", import.meta.url), "utf8");
  assert.match(workflow, /concurrency:\s*\n\s*group: discord-issue-\$\{\{ github\.repository \}\}-\$\{\{ github\.event\.issue\.number \}\}\s*\n\s*cancel-in-progress: false/);
});
