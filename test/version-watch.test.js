import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDeploymentIdentity, hasDeploymentChanged, getUpdateMessage } from "../public/js/version-watch.js";

test("version identity validation and baseline comparisons", () => {
  assert.equal(normalizeDeploymentIdentity({ version: "1.2.1", build: "unknown" }), null);
  assert.equal(normalizeDeploymentIdentity({ version: "1.2.1", build: " " }), null);
  const a = normalizeDeploymentIdentity({ version: "1.2.1", build: "aaa" });
  assert.equal(hasDeploymentChanged(a, normalizeDeploymentIdentity({ version: "1.2.1", build: "aaa" })), false);
  assert.equal(hasDeploymentChanged(a, normalizeDeploymentIdentity({ version: "1.2.1", build: "bbb" })), true);
  assert.equal(hasDeploymentChanged(normalizeDeploymentIdentity({ version: "dev", build: "aaa" }), normalizeDeploymentIdentity({ version: "dev", build: "bbb" })), true);
});

test("update messages distinguish stable and development builds", () => {
  assert.equal(getUpdateMessage({ version: "1.2.2", build: "bbb" }), "VerseLink 1.2.2 is ready.");
  assert.equal(getUpdateMessage({ version: "dev", build: "bbb" }), "A new VerseLink development build is ready.");
});
