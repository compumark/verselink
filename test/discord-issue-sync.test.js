import test from "node:test";
import assert from "node:assert/strict";
import { buildMessage, chooseType, desiredTagNames, issueStatus, mergeAppliedTags, parseThreadMarker, sanitizeDiscordText, truncateTitle } from "../.github/scripts/discord-issue-sync.mjs";

const base = { number: 42, title: "A title", html_url: "https://github.com/compumark/verselink/issues/42", user: { login: "octo" }, labels: [], state: "open", body: "hello" };
test("chooses one primary tag by priority", () => assert.equal(chooseType(["issue", "enhancement", "bug"]), "bug"));
test("computes lifecycle tags", () => { assert.deepEqual(desiredTagNames({ ...base, labels: [{ name: "bug" }, { name: "in progress" }] }), ["bug", "in progress"]); assert.deepEqual(desiredTagNames({ ...base, state: "closed", state_reason: "not_planned" }), ["issue", "not implemented"]); });
test("preserves unmanaged forum tags", () => assert.deepEqual(mergeAppliedTags(["custom", "old-status"], [{ id: "custom", name: "community" }, { id: "old-status", name: "completed" }, { id: "bug", name: "bug" }], ["bug"]), ["custom", "bug"]));
test("computes issue status", () => assert.equal(issueStatus({ ...base, labels: ["status/in progress"] }), "In Progress"));
test("keeps issue number while truncating title", () => assert.ok(truncateTitle(42, "x".repeat(200)).startsWith("[#42] ")));
test("sanitizes Discord mentions", () => assert.equal(sanitizeDiscordText("@everyone <@123> <@&456>"), "@\u200beveryone @123 @456"));
test("parses mapping comments", () => assert.equal(parseThreadMarker("<!-- verselink-discord-thread:123456789012345678 -->"), "123456789012345678"));
test("message retains URL and disables nothing in content", () => assert.match(buildMessage(base), /GitHub Issue/));
