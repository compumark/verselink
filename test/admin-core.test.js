import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const classic = await readFile(new URL("../public/js/groups-classic.js", import.meta.url), "utf8");
const mobiglass = await readFile(new URL("../public/js/admin-mobiglass.js", import.meta.url), "utf8");
const aliasMobiglass = await readFile(new URL("../public/js/alias-mobiglass.js", import.meta.url), "utf8");
const profileMobiglass = await readFile(new URL("../public/js/profile-mobiglass.js", import.meta.url), "utf8");
const inventoryMobiglass = await readFile(new URL("../public/js/inventory-mobiglass.js", import.meta.url), "utf8");

test("admin permissions use immutable APP_ADMIN_USER_IDS and stay server-side", () => {
  assert.match(server, /process\.env\.APP_ADMIN_USER_IDS/);
  assert.match(server, /const uuidPattern =/);
  assert.match(server, /entries\.filter\(\(value\) => uuidPattern\.test\(value\)\)/);
  assert.match(server, /id::text = ANY\(\$1::text\[\]\)/);
  assert.match(server, /account_status = 'active'/);
  assert.match(server, /ignored invalid APP_ADMIN_USER_IDS entries/);
  assert.match(server, /if \(!current\?\.is_admin\) return json\(res, 403/);
  assert.doesNotMatch(server, new RegExp(["APP_ADMIN", "HANDLES"].join("_") + "|adminHandles"));
  assert.doesNotMatch(mobiglass, /APP_ADMIN_USER_IDS|configuredAdminUserIds/);
});

test("Mobiglass admin uses the existing state, status, delete and group endpoints", () => {
  for (const source of [classic, mobiglass]) {
    assert.match(source, /loadAdminState/);
    assert.match(source, /setUserStatus/);
    assert.match(source, /deleteUser/);
  }
  assert.match(mobiglass, /adminTransferOwner/);
  assert.match(mobiglass, /removeMember/);
  assert.match(server, /url\.pathname === "\/api\/admin\/state"/);
  assert.match(server, /url\.pathname === "\/api\/admin\/users\/status"/);
  assert.match(server, /url\.pathname === "\/api\/admin\/users\/delete"/);
  assert.match(server, /assets\/apps\/admin_center\.png/);
  assert.match(mobiglass, /admin_center\.png/);
  assert.match(mobiglass, /admin-user-search/);
  assert.match(mobiglass, /adminUserSearch/);
  assert.match(mobiglass, /admin-count/);
  assert.match(mobiglass, /state\.users\.length/);
});

test("existing admin endpoints keep self-protection", () => {
  assert.match(server, /account_status=\$1 WHERE id=\$2 AND id<>\$3/);
  assert.match(server, /userId === current\.id/);
  assert.match(classic, /u\.is_admin\?'':/);
  assert.match(mobiglass, /Protected administrator account/);
});

test("admin token management only cleans incomplete tokens and revokes deleted-user tokens", () => {
  assert.match(server, /CREATE TABLE IF NOT EXISTS revoked_sink_tokens/);
  assert.match(server, /url\.pathname === "\/api\/admin\/tokens\/cleanup"/);
  assert.match(server, /app_user_id IS NULL AND scmdb_user_id IS NULL AND last_seen_at < now\(\) - interval '24 hours'/);
  assert.match(server, /INSERT INTO revoked_sink_tokens \(token_hash, reason\) SELECT token_hash, 'user deleted'/);
  assert.match(server, /SELECT 1 FROM revoked_sink_tokens WHERE token_hash = \$1/);
  assert.match(mobiglass, /SINK TOKEN MANAGEMENT/);
  assert.match(mobiglass, /REMOVE UNCONFIGURED TOKENS/);
});

test("VerseLink aliases stay separate from SCMDB identity and are exposed through a self-service endpoint", () => {
  assert.match(server, /ALTER TABLE app_users ADD COLUMN IF NOT EXISTS verselink_name text/);
  assert.match(server, /COALESCE\(u\.verselink_name, u\.display_name\) AS display_name/);
  assert.match(server, /url\.pathname === "\/api\/profile\/verselink-name"/);
  assert.match(server, /UPDATE app_users SET verselink_name=\$1 WHERE id=\$2/);
  assert.match(server, /COALESCE\(cu\.verselink_name,cu\.display_name\) AS creator_name/);
  assert.match(server, /\/js\/alias-mobiglass\.js/);
  assert.match(aliasMobiglass, /location\.hash = '#profile'/);
  assert.match(aliasMobiglass, /HALLO, \$\{user\.display_name\}/);
});

test("SCMDB and editable profile fields cannot grant admin access", () => {
  const syncProfile = server.match(/const syncProfileToAppUser[\s\S]*?^};/m)?.[0] || "";
  assert.doesNotMatch(syncProfile, /is_admin|user_handle/);
  assert.match(server, /UPDATE app_users SET verselink_name=\$1 WHERE id=\$2/);
  assert.match(server, /UPDATE app_users SET rsi_avatar_url=\$1,rsi_handle=\$2/);
});

test("profile details are self-managed and public only with explicit opt-in", () => {
  assert.match(server, /profile_public boolean NOT NULL DEFAULT false/);
  assert.match(server, /url\.pathname === "\/api\/profile"/);
  assert.match(server, /profile_public=true AND account_status='active'/);
  assert.match(server, /const publicProfileMatch = url\.pathname\.match/);
  assert.match(server, /robertsspaceindustries\\\.com/);
  assert.match(aliasMobiglass, /EDIT PROFILE/);
  assert.match(profileMobiglass, /MAKE THIS PROFILE PUBLIC/);
  assert.match(profileMobiglass, /RSI PROFILE URL/);
  assert.match(server, /url\.pathname === "\/api\/profile\/rsi-sync"/);
  assert.match(server, /redirect: "error"/);
  assert.match(server, /AbortSignal\.timeout\(8000\)/);
  assert.match(server, /rsi_avatar_url text/);
  assert.match(server, /rsi_profile_url IS DISTINCT FROM \$2 THEN NULL/);
  assert.match(profileMobiglass, /SYNC RSI PUBLIC DATA/);
  assert.match(server, /class="profile-brand"/);
  assert.match(server, /src="\/assets\/verselink\.png"/);
  assert.match(server, /RSI CITIZEN DOSSIER/);
});

test("blueprint ownership exposes a profile link only for public profiles", () => {
  assert.match(server, /owner_user\.profile_public THEN '\/profile\/' \|\| owner_user\.id::text/);
  assert.match(server, /jsonb_agg\(DISTINCT jsonb_build_object\('name'/);
  assert.match(inventoryMobiglass, /mi-owner-link/);
});
