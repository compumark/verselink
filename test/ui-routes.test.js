import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const serverSource = await readFile(new URL("../src/server.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"));
const aboutSource = await readFile(new URL("../public/js/about-mobiglass.js", import.meta.url), "utf8");
const materialInventorySource = await readFile(new URL("../public/js/material-inventory-mobiglass.js", import.meta.url), "utf8");
const changelogSource = await readFile(new URL("../public/changelog.html", import.meta.url), "utf8");
const changelogMobiglassSource = await readFile(new URL("../public/js/changelog-mobiglass.js", import.meta.url), "utf8");
const uiPreviewSource = await readFile(new URL("../public/ui-preview.html", import.meta.url), "utf8");
const aliasMobiglassSource = await readFile(new URL("../public/js/alias-mobiglass.js", import.meta.url), "utf8");

test("Mobiglass is the productive default UI", () => {
  assert.match(serverSource, /location: "\/mobiglass"/);
  assert.match(serverSource, /url\.pathname === "\/mobiglass"/);
  assert.equal(manifest.start_url, "/mobiglass");
  assert.equal(manifest.icons[0].src, "/assets/verselink.png");
  assert.match(serverSource, /rel=\"icon\" type=\"image\/png\" href=\"\/favicon\.png\?v=verselink\"/);
  assert.match(serverSource, /\["\/assets\/verselink\.png", "\/favicon\.png", "\/favicon\.ico"\]/);
});

test("ui-preview and Mobiglass share the productive shell", () => {
  assert.match(serverSource, /url\.pathname === "\/mobiglass" \|\| url\.pathname === "\/ui-preview"/);
  assert.doesNotMatch(serverSource, /url\.pathname === "\/classic(?:\/|\")/);
});

test("Pyro keeps readable text and does not fall back to browser link colors", () => {
  assert.match(uiPreviewSource, /html\[data-theme=pyro\]\{--accent:#ff8a78;--bright:#fff5f0;--muted:#f3beb5;--border:#a84e45;--text:#fffaf7/);
  assert.match(uiPreviewSource, /a,a:visited\{color:var\(--accent\)\}/);
});

test("Mobiglass exposes the internal VerseLink About view", () => {
  assert.match(serverSource, /data-view=\"about\" title=\"About VerseLink\"/);
  assert.match(serverSource, /'changelog','about'/);
  assert.match(serverSource, /'material','changelog','miningpool','about','admin','profile'/);
  assert.match(serverSource, /renderVerseLinkAbout\(content,user\)/);
  assert.match(serverSource, /\/js\/about-mobiglass\.js/);
  assert.match(aboutSource, /window\.renderVerseLinkAbout/);
  assert.match(aboutSource, /AVAILABLE MODULES/i);
  assert.match(aboutSource, /class=\"about-logo\" src=\"\/assets\/verselink\.png\"/);
  assert.match(aboutSource, /Material Inventory/);
  assert.match(aboutSource, /Material Inventory[^\n]+\/assets\/icons\/material-crate\.svg[^\n]+view: "material"/);
  assert.match(aboutSource, /data-about-view="\$\{module\.view\}"/);
  assert.match(aboutSource, /SCMDB Connection/);
  assert.match(aboutSource, /Deployed commit/);
  assert.match(aboutSource, /USER ID/);
  assert.match(aboutSource, /user\?\.id/);
  assert.match(aboutSource, /\{\{APP_COMMIT\}\}/);
  assert.match(serverSource, /APP_COMMIT/);
  assert.match(aboutSource, /not affiliated with or endorsed by Cloud Imperium Games/);
  assert.doesNotMatch(aboutSource, /fetch\s*\(/);
});

test("Mobiglass admin navigation and view are server-gated", async () => {
  const adminSource = await readFile(new URL("../public/js/admin-mobiglass.js", import.meta.url), "utf8");
  assert.match(serverSource, /APP_ADMIN_USER_IDS/);
  assert.match(serverSource, /is_admin/);
  assert.match(serverSource, /admin-nav/);
  assert.match(serverSource, /admin-nav/);
  assert.match(serverSource, /api\/admin\/state/);
  assert.match(serverSource, /api\/admin\/users\/status/);
  assert.match(serverSource, /api\/admin\/users\/delete/);
  assert.match(adminSource, /loadAdminState/);
  assert.match(adminSource, /LOCK USER/);
  assert.match(adminSource, /UNLOCK USER/);
  assert.match(adminSource, /DELETE USER/);
  assert.match(adminSource, /await refresh\(\)/);
  assert.doesNotMatch(adminSource, /APP_ADMIN_USER_IDS/);
});

test("material stock changes are restricted to the contribution owner", () => {
  assert.match(serverSource, /only the contribution owner can withdraw this stock/);
  assert.match(serverSource, /only the contribution owner can move this stock/);
  assert.match(serverSource, /viewer_user_id:member\.rows\[0\]\.app_user_id/);
  assert.match(materialInventorySource, /row.user_id === body.viewer_user_id/);
  assert.match(materialInventorySource, /OWNER ONLY/);
});

test("inventory navigation exposes blueprint and material shortcuts", () => {
  assert.match(uiPreviewSource, /nav-inventory-menu/);
  assert.match(uiPreviewSource, /Open Blueprint Inventory/);
  assert.match(uiPreviewSource, /Open Material Inventory/);
  assert.match(uiPreviewSource, /\[data-app="material"\]\.locked \.app-icon\{filter:grayscale\(1\) brightness\(\.55\)\}/);
});

test("notification actions use the Mobiglass button styling", () => {
  assert.match(uiPreviewSource, /\.notification-view-all,\.notification-mark-all,\.notification-desktop-toggle/);
  assert.match(uiPreviewSource, /text-transform:uppercase/);
  assert.match(serverSource, /\/js\/notifications-mobiglass\.js/);
  assert.match(serverSource, /"cache-control": "no-cache"/);
});

test("Mobiglass separates releases from pre-release history and shows GitHub release notes", () => {
  assert.match(changelogSource, /data-release-kind="stable" data-version="1\.1\.0"/);
  assert.match(changelogSource, /data-release-kind="stable" data-version="1\.0\.0"/);
  assert.match(changelogSource, /data-release-kind="pre-release"/);
  assert.match(serverSource, /data-release-kind="stable"\\s\+data-version/);
  assert.match(serverSource, /\/js\/changelog-mobiglass\.js/);
  assert.match(changelogMobiglassSource, /VIEW PRE-RELEASE HISTORY/);
  assert.match(changelogMobiglassSource, /GITHUB RELEASE NOTES/);
  assert.match(changelogMobiglassSource, /api\.github\.com\/repos/);
  assert.match(changelogMobiglassSource, /hasEmbeddedReleaseNotes/);
  assert.match(changelogMobiglassSource, /!hasEmbeddedReleaseNotes\(entry, release\)/);
});

test("material inventory navigation is blocked before session verification", () => {
  assert.match(serverSource, /\[data-app="material"\],\[aria-label="Open Material Inventory"\]/);
  assert.match(serverSource, /dataset\.sessionAuthenticated/);
  assert.match(serverSource, /sessionAuthenticated!=="true"/);
  assert.match(serverSource, /stopImmediatePropagation\(\)/);
});

test("material loading overlay clears after the material view is ready", () => {
  assert.match(uiPreviewSource, /!materialReady&&!loadingMaterial/);
  assert.match(uiPreviewSource, /materialReady=true/);
  assert.match(uiPreviewSource, /body\.classList\.remove\('session-pending'\)/);
});

test("Mobiglass logout clears the shared authenticated header state", () => {
  assert.match(aliasMobiglassSource, /const updateAuthenticatedUserState = user =>/);
  assert.match(aliasMobiglassSource, /updateAuthenticatedUserState\(response\.ok \? body\.user : null\)/);
  assert.match(aliasMobiglassSource, /event\.target\.closest\('#logout'\).*updateAuthenticatedUserState\(null\)/);
  assert.match(aliasMobiglassSource, /#notificationCenter, #notificationButton/);
  assert.match(aliasMobiglassSource, /NOT AUTHENTICATED/);
});

test("material inventory renders SCU values with two decimals before display", () => {
  assert.match(materialInventorySource, /total_scu \|\| 0\)\.toFixed\(2\)/);
  assert.match(materialInventorySource, /available_scu \?\? row\.quantity_scu\)\.toFixed\(2\)/);
  assert.doesNotMatch(materialInventorySource, /toFixed\(1\)/);
});
