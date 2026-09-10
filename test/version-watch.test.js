import assert from "node:assert/strict";
import test from "node:test";
import { normalizeDeploymentIdentity, hasDeploymentChanged, getUpdateMessage, updateUrlFor } from "../public/js/version-watch.js";

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

test("version updates use the deployment build as a cache-busting URL parameter", () => {
  assert.equal(updateUrlFor({ build: "c695d8e" }, "https://verselink.compumarksc.xyz/mobiglass#home"), "https://verselink.compumarksc.xyz/mobiglass?build=c695d8e#home");
  assert.equal(updateUrlFor({ build: "next" }, "https://verselink.compumarksc.xyz/mobiglass?theme=pyro#inventory"), "https://verselink.compumarksc.xyz/mobiglass?theme=pyro&build=next#inventory");
});
