import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const publicRouteStart = source.indexOf('url.pathname.startsWith("/api/public/groups/")');
const publicRoute = source.slice(publicRouteStart, source.indexOf('url.pathname === "/api/invites"', publicRouteStart));
const publicQuery = source.slice(source.indexOf("const publicBlueprintQuery"), source.indexOf("const htmlEscape"));

test("public API has a separate route and does not reuse authenticated query", () => {
  assert.match(source, /url\.pathname\.startsWith\("\/api\/public\/groups\/"\)/);
  assert.match(source, /const publicBlueprintQuery =/);
  assert.doesNotMatch(publicRoute, /accessibleBlueprintQuery/);
});

test("public query is owner-free and uses active group members", () => {
  assert.match(publicQuery, /account_status = 'active'/);
  assert.match(publicQuery, /GROUP BY m\.tag/);
  assert.doesNotMatch(publicQuery, /owner_name|owner_count|user_handle/);
});

test("public response is explicitly whitelisted", () => {
  assert.match(publicRoute, /map\(\(\{ tag, name, category, subcategory, manufacturer, image_url \}\)/);
  for (const forbidden of ["owner_name", "owner_count", "app_user_id", "scmdb_user_id", "user_handle", "session_hash"]) {
    assert.doesNotMatch(publicRoute, new RegExp(forbidden));
  }
});

test("public token lifecycle and limits are present", () => {
  assert.match(source, /CREATE TABLE IF NOT EXISTS public_group_links/);
  assert.match(source, /randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(source, /hashPublicToken/);
  assert.match(source, /enabled AND \(l\.expires_at IS NULL OR l\.expires_at > now\(\)\)/);
  assert.match(source, /pageSize > 50/);
  assert.match(source, /too many requests/);
});

test("public query uses parameterized filters", () => {
  assert.match(publicQuery, /ILIKE \$4 ESCAPE/);
  assert.match(source, /pool\.query\(publicBlueprintQuery, \[link\.rows\[0\]\.group_id/);
  assert.match(publicRoute, /parsed\.q, parsed\.category, parsed\.subcategory, parsed\.manufacturer/);
});

test("Hector public preview reuses the existing public API and token validation", async () => {
  const [classic, preview] = await Promise.all([
    readFile(new URL("../public/public-search.html", import.meta.url), "utf8"),
    readFile(new URL("../public/public-preview.html", import.meta.url), "utf8")
  ]);
  assert.match(source, /\["\/public\/", "\/public-preview\/"\]/);
  assert.match(source, /preview \? "public-preview\.html" : "public-search\.html"/);
  assert.match(source, /if \(!publicTokenPattern\.test\(token\)\)/);
  assert.match(preview, /\/api\/public\/groups\/.*\/blueprints/);
  assert.doesNotMatch(preview, /\/api\/blueprints/);
  assert.match(classic, /url\('\/hector-header\.png\?v=20260816-3'\) center\/cover no-repeat/);
  assert.match(preview, /url\('\/hector-header\.png\?v=20260816-3'\) center\/cover no-repeat/);
  assert.match(preview, /aspect-ratio:2172\/724!important;[\s\S]*background-size:100% 100%!important;background-position:center!important/);
  assert.doesNotMatch(preview, /hector-workshop-public\.png|PUBLIC DATA LINK|DATA SOURCE|PERMISSIONS/);
});
