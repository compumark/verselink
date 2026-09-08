import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
test("authentication UI receives only server-issued credentials", async () => {
  const [login, entry] = await Promise.all([
    readFile(new URL("../public/login.html", import.meta.url), "utf8"),
    readFile(new URL("../public/js/mobiglass-auth-entry.js", import.meta.url), "utf8")
  ]);
  assert.doesNotMatch(login, /SCMDB Sink Token|\/session/);
  assert.doesNotMatch(entry, /SCMDB SINK TOKEN|\/session|createSinkToken|sinkUrlFor/);
});

test("registration displays server-issued VerseLink credentials without persistence", async () => {
  const login = await readFile(new URL("../public/login.html", import.meta.url), "utf8");
  assert.match(login, /JSON\.stringify\(\{ display_name:/);
  assert.match(login, /data\.token/);
  assert.match(login, /data\.recovery_key/);
  assert.match(login, /copyId/);
  assert.match(login, /copyRecovery/);
  assert.match(login, /id="continue"/);
  assert.doesNotMatch(login, /createVerseLinkToken/);
  assert.doesNotMatch(login, /localStorage|sessionStorage|indexedDB/);
});

test("Mobiglass profile exposes only recovery status and rotates through the session API", async () => {
  const [profileScript, server] = await Promise.all([
    readFile(new URL("../public/js/profile-mobiglass.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server.js", import.meta.url), "utf8")
  ]);
  assert.match(profileScript, /has_recovery_key/);
  assert.match(profileScript, /\/api\/me\/recovery-key/);
  assert.match(profileScript, /COPY RECOVERY KEY/);
  assert.match(profileScript, /SAVE THIS KEY NOW/);
  assert.doesNotMatch(profileScript, /localStorage|sessionStorage|indexedDB/);
  assert.match(server, /has_recovery_key/);
  assert.match(server, /has_recovery_key FROM app_users WHERE id=\$1/);
});

test("Mobiglass auth entry exposes only VerseLink login, recovery and registration", async () => {
  const [entry, server] = await Promise.all([
    readFile(new URL("../public/js/mobiglass-auth-entry.js", import.meta.url), "utf8"),
    readFile(new URL("../src/server.js", import.meta.url), "utf8")
  ]);
  assert.match(entry, /\/auth\/login/);
  assert.match(entry, /window\.location\.reload\(\)/);
  assert.doesNotMatch(entry, /window\.location\.assign\('\/mobiglass#home'\)/);
  assert.match(entry, /\/auth\/register/);
  assert.match(entry, /LOGIN WITH VERSELINK ID/);
  assert.match(entry, /CREATE NEW VERSELINK ID/);
  assert.match(entry, /ACCOUNT RECOVERY/);
  assert.doesNotMatch(entry, /LEGACY SCMDB LOGIN|SCMDB SINK TOKEN|\/session/);
  assert.doesNotMatch(entry, /createSinkToken|sinkUrlFor/);
  assert.match(entry, /data\.recovery_key|body\.recovery_key/);
  assert.match(server, /mobiglass-auth-entry\.js/);
});
