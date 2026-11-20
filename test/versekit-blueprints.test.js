import test from "node:test";
import assert from "node:assert/strict";
import { createBlueprintCursorCodec } from "../src/integrations/versekit/blueprints.js";

const pepper = "versekit-blueprints-cursor-test-pepper-at-least-32-bytes";
const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("blueprint cursors are canonical, authenticated and bound to group, member and scope", () => {
  const codec = createBlueprintCursorCodec(pepper);
  const payload = { v: 1, scope: "blueprints:read", s: "zeta", l: "shared" };
  const cursor = codec.encode(payload, groupId, userId);
  assert.deepEqual(codec.decode(cursor, groupId, userId), payload);
  assert.equal(codec.decode(cursor, "cccccccc-cccc-4ccc-8ccc-cccccccccccc", userId), null);
  assert.equal(codec.decode(cursor, groupId, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"), null);
  assert.equal(codec.decode(`${cursor}x`, groupId, userId), null);
  assert.equal(codec.decode("not-a-cursor", groupId, userId), null);
  assert.throws(() => createBlueprintCursorCodec("short"), /configured secret pepper/);
  assert.equal(Buffer.from(cursor.split(".")[0], "base64url").toString("utf8").includes(groupId), false);
  assert.equal(Buffer.from(cursor.split(".")[0], "base64url").toString("utf8").includes(userId), false);
  assert.throws(() => codec.encode({ ...payload, scope: "blueprints:write" }, groupId, userId), /invalid VerseKit blueprint cursor/);
});
