import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { generateRecoveryToken, hashRecoveryToken, isRecoveryToken } from "../src/auth-primitives.js";

const server = await readFile(new URL("../src/server.js", import.meta.url), "utf8");

test("generates recovery keys in the vlr_ format", () => {
  const token = generateRecoveryToken();
  assert.match(token, /^vlr_[A-Za-z0-9_-]{43,64}$/);
  assert.equal(isRecoveryToken(token), true);
});

test("generates distinct recovery keys", () => {
  assert.notEqual(generateRecoveryToken(), generateRecoveryToken());
});

test("accepts only valid recovery key formats", () => {
  assert.equal(isRecoveryToken("vlr_" + "A".repeat(43)), true);
  assert.equal(isRecoveryToken("vl_" + "A".repeat(43)), false);
  assert.equal(isRecoveryToken("wrong_" + "A".repeat(43)), false);
  assert.equal(isRecoveryToken("vlr_" + "A".repeat(42)), false);
  assert.equal(isRecoveryToken("vlr_" + "A".repeat(42) + "!"), false);
});

test("uses a deterministic, domain-separated recovery hash", () => {
  const token = generateRecoveryToken();
  const pepper = "test-pepper";
  assert.equal(hashRecoveryToken(token, pepper), hashRecoveryToken(token, pepper));
  assert.notEqual(hashRecoveryToken(token, pepper), hashRecoveryToken(token.replace(/^vlr_/, "vl_"), pepper));
  assert.match(hashRecoveryToken(token, pepper), /^[a-f0-9]{64}$/);
});

test("stores recovery hashes only and keeps login primitives unchanged", () => {
  const schema = server.match(/CREATE TABLE IF NOT EXISTS auth_recovery_tokens[\s\S]*?CREATE TABLE IF NOT EXISTS blueprint_groups/)?.[0] || "";
  assert.match(schema, /CREATE TABLE IF NOT EXISTS auth_recovery_tokens/);
  assert.match(schema, /token_hash text UNIQUE NOT NULL/);
  assert.match(schema, /auth_recovery_tokens_active_user_idx/);
  assert.doesNotMatch(schema, /raw_token|recovery_key|plain_token/i);
  assert.match(server, /verselink-auth:/);
  assert.doesNotMatch(server, /auth\/login[\s\S]{0,1800}generateRecoveryToken/);
});

test("registration creates and returns a recovery key in the same flow", () => {
  const registration = server.match(/url\.pathname === "\/auth\/register"[\s\S]*?\n    if \(req\.method === "POST" && url\.pathname === "\/auth\/login"\)/)?.[0] || "";
  assert.match(registration, /const token = generateVerseLinkToken\(\)/);
  assert.doesNotMatch(registration, /const token = String\(payload\.token/);
  assert.match(registration, /const recoveryKey = generateRecoveryToken\(\)/);
  assert.match(registration, /const recoveryHash = hashRecoveryToken\(recoveryKey, pepper\)/);
  assert.match(registration, /INSERT INTO auth_recovery_tokens \(app_user_id, token_hash\)/);
  assert.match(registration, /JSON\.stringify\(\{ ok: true, token, recovery_key: recoveryKey \}\)/);
  assert.match(registration, /await client\.query\("BEGIN"\)/);
  assert.match(registration, /await client\.query\("COMMIT"\)/);
  assert.match(registration, /await client\.query\("ROLLBACK"/);
  assert.doesNotMatch(registration, /scmdb_connections/);
});

test("registration ignores a client-supplied token and uses the server token", () => {
  const registration = server.match(/url\.pathname === "\/auth\/register"[\s\S]*?\n    if \(req\.method === "POST" && url\.pathname === "\/auth\/login"\)/)?.[0] || "";
  assert.match(registration, /const token = generateVerseLinkToken\(\)/);
  assert.doesNotMatch(registration, /payload\.token/);
  assert.match(registration, /INSERT INTO auth_tokens \(app_user_id, token_hash\)/);
  assert.match(registration, /JSON\.stringify\(\{ ok: true, token, recovery_key: recoveryKey \}\)/);
});

test("recovery endpoint rotates credentials atomically without creating a session", () => {
  const recovery = server.match(/url\.pathname === "\/auth\/recover"[\s\S]*?\n    if \(req\.method === "POST" && url\.pathname === "\/auth\/login"\)/)?.[0] || "";
  assert.match(recovery, /isRecoveryToken\(recoveryKey\)/);
  assert.match(recovery, /hashRecoveryToken\(recoveryKey, pepper\)/);
  assert.match(recovery, /FOR UPDATE/);
  assert.match(recovery, /account_status !== "active"/);
  assert.match(recovery, /UPDATE auth_tokens SET revoked_at=now\(\)/);
  assert.match(recovery, /generateVerseLinkToken\(\)/);
  assert.match(recovery, /INSERT INTO auth_tokens \(app_user_id, token_hash\)/);
  assert.match(recovery, /UPDATE auth_recovery_tokens SET revoked_at=now\(\), last_used_at=now\(\)/);
  assert.match(recovery, /INSERT INTO auth_recovery_tokens \(app_user_id, token_hash\)/);
  assert.match(recovery, /DELETE FROM dashboard_sessions WHERE app_user_id=\$1/);
  assert.match(recovery, /JSON\.stringify|return json\(res, 200, \{ token: newToken, recovery_key: newRecoveryKey \}\)/);
  assert.doesNotMatch(recovery, /createDashboardSession/);
  assert.doesNotMatch(recovery, /scmdb_connections/);
  assert.match(recovery, /invalid or expired recovery key/);
});

test("auth endpoints use rate limiting without storing raw credentials", () => {
  assert.match(server, /const loginRateLimit = createRateLimiter\(\{ limit: 10, windowMs: 10 \* 60_000 \}\)/);
  assert.match(server, /const registrationRateLimit = createRateLimiter\(\{ limit: 5, windowMs: 15 \* 60_000 \}\)/);
  assert.match(server, /const recoveryRateLimit = createRateLimiter\(\{ limit: 5, windowMs: 15 \* 60_000 \}\)/);
  assert.match(server, /const recoveryRotationRateLimit = createRateLimiter\(\{ limit: 5, windowMs: 15 \* 60_000 \}\)/);
  assert.match(server, /too many requests/);
  assert.match(server, /clientKey\(req\)/);
  assert.doesNotMatch(server, /recordFailure\(.*token\)/);
});

test("legacy SCMDB login endpoint is removed", () => {
  assert.doesNotMatch(server, /url\.pathname === "\/session"/);
  assert.doesNotMatch(server, /getSessionTokenHash|ensureAppUser/);
});

test("SCMDB connected-service lifecycle schema is additive and token-hash based", () => {
  const connections = server.match(/CREATE TABLE IF NOT EXISTS scmdb_connections[\s\S]*?CREATE TABLE IF NOT EXISTS scmdb_profiles/)?.[0] || "";
  assert.match(connections, /connection_status text NOT NULL DEFAULT 'connected'/);
  assert.match(connections, /connected_at timestamptz/);
  assert.match(connections, /disconnected_at timestamptz/);
  assert.match(connections, /revoked_at timestamptz/);
  assert.match(connections, /connection_status IN \('pending', 'connected', 'disconnected', 'revoked'\)/);
  assert.match(connections, /scmdb_connections_app_user_idx/);
  assert.match(connections, /UPDATE scmdb_connections SET connected_at/);
  assert.match(connections, /token_hash text PRIMARY KEY/);
  assert.doesNotMatch(connections, /UNIQUE\s*\(app_user_id\)/i);
  assert.doesNotMatch(connections, /raw_token|sink_token text|recovery_key/i);
});

test("SCMDB setup fails closed when no valid deployment sink URL is configured", () => {
  const connectRoute = server.match(/url\.pathname === "\/api\/profile\/scmdb\/connect"[\s\S]*?\n    if \(req\.method === "POST" && url\.pathname === "\/api\/profile\/scmdb\/disconnect"\)/)?.[0] || "";
  assert.match(server, /normalizeScmdbSinkBaseUrl\(process\.env\.SCMDB_SINK_BASE_URL\)/);
  assert.match(connectRoute, /if \(!scmdbSinkBaseUrl\) return json\(res, 503/);
  assert.match(connectRoute, /SCMDB synchronization is not configured on this VerseLink instance\./);
  assert.match(connectRoute, /scmdbSinkUrl\(scmdbSinkBaseUrl, rawToken\)/);
});

test("SCMDB child tables remain token-hash based", () => {
  const profiles = server.match(/CREATE TABLE IF NOT EXISTS scmdb_profiles[\s\S]*?CREATE TABLE IF NOT EXISTS scmdb_events/)?.[0] || "";
  const events = server.match(/CREATE TABLE IF NOT EXISTS scmdb_events[\s\S]*?CREATE TABLE IF NOT EXISTS member_blueprints/)?.[0] || "";
  const blueprints = server.match(/CREATE TABLE IF NOT EXISTS member_blueprints[\s\S]*?CREATE INDEX IF NOT EXISTS member_blueprints_tag_idx/)?.[0] || "";
  assert.match(profiles, /token_hash text PRIMARY KEY REFERENCES scmdb_connections/);
  assert.match(events, /token_hash text NOT NULL REFERENCES scmdb_connections/);
  assert.match(blueprints, /token_hash text NOT NULL REFERENCES scmdb_connections/);
});

test("existing-user recovery rotation is app-user based and transactional", () => {
  assert.match(server, /url\.pathname === "\/api\/me\/recovery-key"/);
  assert.match(server, /const context = await getSessionContext\(req\)/);
  assert.match(server, /hashtext\(\$1\).*recovery-key:/s);
  assert.match(server, /SELECT account_status FROM app_users WHERE id=\$1 FOR UPDATE/);
  assert.match(server, /UPDATE auth_recovery_tokens SET revoked_at=now\(\), last_used_at=now\(\)/);
  assert.match(server, /INSERT INTO auth_recovery_tokens \(app_user_id, token_hash\)/);
  assert.match(server, /hashRecoveryToken\(recoveryKey, pepper\)/);
  assert.match(server, /return json\(res, 200, \{ recovery_key: recoveryKey \}\)/);
  assert.doesNotMatch(server, /recovery-key[\s\S]{0,3500}getSessionTokenHash/);
  assert.doesNotMatch(server, /recovery-key[\s\S]{0,3500}scmdb_connections/);
  assert.doesNotMatch(server, /recovery-key[\s\S]{0,3500}DELETE FROM dashboard_sessions/);
});

test("migration-only credential upgrade endpoint is removed", () => {
  assert.doesNotMatch(server, /\/api\/me\/verselink-upgrade|verselinkUpgradeRateLimit|has_verselink_login/);
});

test("profile status exposes recovery state without migration-only login fields", () => {
  const profile = server.match(/url\.pathname === "\/api\/profile"[\s\S]*?url\.pathname === "\/api\/profile\/rsi-sync"/)?.[0] || "";
  assert.match(profile, /has_recovery_key/);
  assert.doesNotMatch(profile, /has_verselink_login/);
  assert.doesNotMatch(profile, /token_hash/);
});
