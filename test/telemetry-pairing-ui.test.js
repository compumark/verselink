import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("MobiGlass profile contains only the one-time telemetry pairing utility", async () => {
  const profile = await readFile(new URL("../public/js/profile-mobiglass.js", import.meta.url), "utf8");
  assert.match(profile, /VERSELINK TELEMETRY/);
  assert.match(profile, /WINDOWS CLIENT/);
  assert.match(profile, /\/api\/me\/telemetry\/pairing/);
  assert.match(profile, /JSON\.stringify\(\{ schema: 1 \}\)/);
  assert.match(profile, /GENERATE PAIRING CODE/);
  assert.match(profile, /PAIRING CODE CREATED/);
  assert.match(profile, /COPY PAIRING CODE/);
  assert.match(profile, /expires_at/);
  assert.match(profile, /invalidates your previous unused code/);
  assert.match(profile, /dialog\.replaceChildren\(\); dialog\.remove\(\)/);
  assert.doesNotMatch(profile, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(profile, /Credential Manager|execFile|powershell|device_credential/);
});
