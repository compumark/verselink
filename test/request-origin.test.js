import assert from "node:assert/strict";
import test from "node:test";
import { createOriginChecker } from "../src/request-origin.js";

test("legacy origin check keeps its previous optional-origin behavior", () => {
  const check = createOriginChecker("https://app.example.test/path");
  assert.equal(check({ headers: {} }), true);
  assert.equal(check({ headers: { origin: "https://app.example.test" } }), true);
  assert.equal(check({ headers: { origin: "https://attacker.example" } }), false);
});

test("strict C8 origin check requires an exact configured origin and ignores proxy headers", () => {
  const check = createOriginChecker("https://app.example.test/profile", { requireOrigin: true, exactOrigin: true });
  assert.equal(check({ headers: { origin: "https://app.example.test" } }), true);
  assert.equal(check({ headers: {} }), false);
  assert.equal(check({ headers: { origin: "https://attacker.example" } }), false);
  assert.equal(check({ headers: { origin: "https://app.example.test/extra" } }), false);
  assert.equal(check({ headers: { origin: "null" } }), false);
  assert.equal(check({ headers: { origin: "https://attacker.example", "x-forwarded-host": "app.example.test", "x-forwarded-proto": "https" } }), false);
  assert.equal(check({ headers: { origin: "https://app.example.test" } }), true, "valid Origin is not replaced by an untrusted forwarded header");
});
