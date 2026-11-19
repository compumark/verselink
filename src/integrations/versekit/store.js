import { randomUUID } from "node:crypto";
import { newUserCode, normalizeUserCode } from "./tokens.js";
import { STANDARD_SCOPES } from "./discovery.js";

const ACCESS_TTL = 3600;
const REFRESH_TTL = 90 * 86400;
const FAMILY_TTL = 180 * 86400;
export const VERSEKIT_MAX_RETAINED_GRANTS = 10_000;
const GRANT_ADMISSION_LOCK = 0x564b4701;
const validScopes = (s) => Array.isArray(s) && s.length > 0 && new Set(s).size === s.length
  && s.every((x) => typeof x === "string" && /^[a-z]+:(read|write)$/.test(x));

export class VersekitTokenStore {
  constructor({ db, codec, groupId, operationalScopes = [], clock = () => new Date(), maxRetainedGrants = VERSEKIT_MAX_RETAINED_GRANTS }) {
    if (!db || typeof db.connect !== "function") throw new Error("PostgreSQL pool required");
    if (!codec || typeof codec.hash !== "function" || typeof codec.issue !== "function") throw new Error("Token codec required");
    this.db = db; this.codec = codec; this.groupId = groupId; this.clock = clock;
    if (!Number.isInteger(maxRetainedGrants) || maxRetainedGrants < 1) throw new Error("Invalid VerseKit grant storage limit");
    this.maxRetainedGrants = maxRetainedGrants;
    this.operationalScopes = Object.freeze([...operationalScopes]);
  }
  scopesReady(scopes) {
    return validScopes(scopes) && scopes.every((scope) => this.operationalScopes.includes(scope));
  }
  async configuredGroup(c) {
    const q = await c.query("SELECT group_id FROM versekit_authorization_config WHERE id=true FOR SHARE");
    return q.rowCount === 1 && q.rows[0].group_id === this.groupId;
  }
  async transaction(fn) {
    const c = await this.db.connect();
    try { await c.query("BEGIN"); const value = await fn(c); await c.query("COMMIT"); return value; }
    catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; }
    finally { c.release(); }
  }
  async createDeviceGrant({ clientId, scopes, expiresIn = 600, interval = 5 }) {
    if (typeof clientId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) throw new Error("Invalid client identity");
    if (!this.scopesReady(scopes)) throw new Error("At least one operational scope is required");
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 600) throw new Error("Invalid device grant expiry");
    if (!Number.isInteger(interval) || interval < 5 || interval > 60) throw new Error("Invalid polling interval");
    for (let i = 0; i < 3; i++) {
      const deviceCode = this.codec.issue("vkd");
      const userCode = newUserCode();
      try {
        const q = await this.transaction(async (c) => {
          const configured = await c.query("SELECT ac.group_id=$1 AS active,EXISTS(SELECT 1 FROM blueprint_groups WHERE id=$1) AS group_exists FROM versekit_authorization_config ac WHERE ac.id=true FOR SHARE OF ac", [this.groupId]);
          if (!configured.rowCount) throw new Error("VerseKit authorization configuration is unavailable");
          if (!configured.rows[0].active && configured.rows[0].group_exists) {
            throw new Error("VerseKit adapter configuration is no longer active");
          }
          await c.query("SELECT pg_advisory_xact_lock($1)", [GRANT_ADMISSION_LOCK]);
          const quota = await c.query(`UPDATE versekit_grant_quota SET tokens=LEAST(capacity, tokens + EXTRACT(EPOCH FROM (clock_timestamp()-updated_at))/refill_interval_seconds), updated_at=clock_timestamp() WHERE id=true RETURNING tokens,refill_interval_seconds`);
          if (!quota.rowCount) throw new Error("VerseKit grant quota is unavailable");
          if (Number(quota.rows[0].tokens) < 1) {
            const retryAfter = Math.max(1, Math.ceil((1-Number(quota.rows[0].tokens))*Number(quota.rows[0].refill_interval_seconds)));
            const error = new Error("VerseKit grant issuance rate reached"); error.code = "VERSEKIT_GRANT_CAPACITY"; error.retryAfter = retryAfter; throw error;
          }
          await c.query("UPDATE versekit_grant_quota SET tokens=tokens-1 WHERE id=true");
          const count = await c.query("SELECT count(*)::int AS count FROM versekit_device_grants");
          if (count.rows[0].count >= this.maxRetainedGrants) {
            const error = new Error("VerseKit grant storage capacity reached");
            error.code = "VERSEKIT_GRANT_CAPACITY";
            throw error;
          }
          return c.query(
            "INSERT INTO versekit_device_grants(device_code_hash,user_code_hash,client_id,group_id,requested_scopes,expires_at,interval_seconds) VALUES($1,$2,$3,$4,$5,now()+($6 * interval '1 second'),$7) RETURNING id,expires_at",
            [this.codec.hash("device_code", deviceCode), this.codec.hash("user_code", userCode), clientId, this.groupId, scopes, expiresIn, interval]
          );
        });
        return { id: q.rows[0].id, deviceCode, userCode, expiresAt: q.rows[0].expires_at, expiresIn, interval };
      } catch (e) { if (e.code !== "23505" || i === 2) throw e; }
    }
    throw new Error("Could not allocate device grant");
  }
  async findGrantByUserCode(value) {
    const code = normalizeUserCode(value); if (!code) return null;
    const q = await this.db.query(
      "SELECT id,client_id,group_id,requested_scopes,expires_at,status FROM versekit_device_grants WHERE user_code_hash=$1 AND expires_at>now()",
      [this.codec.hash("user_code", code)]
    );
    return q.rows[0] || null;
  }
  async createConsentChallenge({ userCode, userId, sessionHash }) {
    const code = normalizeUserCode(userCode);
    if (!code || !/^[0-9a-f]{64}$/.test(sessionHash || "")) return null;
    return this.transaction(async (c) => {
      if (!(await this.configuredGroup(c))) return null;
      const q = await c.query(
        "SELECT id,client_id,group_id,requested_scopes,status,expires_at FROM versekit_device_grants WHERE user_code_hash=$1 FOR UPDATE",
        [this.codec.hash("user_code", code)]
      );
      const grant = q.rows[0];
      if (!grant || grant.client_id !== "versekit" || grant.group_id !== this.groupId || grant.status !== "pending"
        || new Date(grant.expires_at) <= this.clock() || !(await this.eligibleForConsent(c, userId, grant.group_id))) return null;
      const scopes = grant.requested_scopes.filter((scope) => this.operationalScopes.includes(scope));
      if (!scopes.length) return null;
      const challenge = this.codec.issue("vkc");
      const inserted = await c.query(
        "INSERT INTO versekit_consent_challenges(challenge_hash,grant_id,app_user_id,session_hash,expires_at) VALUES($1,$2,$3,$4,LEAST($5::timestamptz,now()+interval '5 minutes')) RETURNING expires_at",
        [this.codec.hash("consent_challenge", challenge), grant.id, userId, sessionHash, grant.expires_at]
      );
      return { challenge, grantId: grant.id, scopes, expiresAt: inserted.rows[0].expires_at };
    });
  }
  async decideConsent({ challenge, userId, sessionHash, scopes, approve }) {
    if (typeof challenge !== "string" || !/^[a-z0-9]+_[A-Za-z0-9_-]{43}$/.test(challenge)
      || !/^[0-9a-f]{64}$/.test(sessionHash || "") || !Array.isArray(scopes)
      || new Set(scopes).size !== scopes.length || typeof approve !== "boolean") return false;
    return this.transaction(async (c) => {
      if (!(await this.configuredGroup(c))) return false;
      const cq = await c.query(
        "SELECT challenge_hash,grant_id,app_user_id,session_hash,expires_at,consumed_at FROM versekit_consent_challenges WHERE challenge_hash=$1 FOR UPDATE",
        [this.codec.hash("consent_challenge", challenge)]
      );
      const context = cq.rows[0];
      if (!context || context.consumed_at || new Date(context.expires_at) <= this.clock()
        || context.app_user_id !== userId || context.session_hash !== sessionHash) return false;
      const q = await c.query("SELECT id,client_id,group_id,requested_scopes,status,expires_at FROM versekit_device_grants WHERE id=$1 FOR UPDATE", [context.grant_id]);
      const grant = q.rows[0];
      if (!grant || grant.status !== "pending" || new Date(grant.expires_at) <= this.clock()
        || grant.client_id !== "versekit" || grant.group_id !== this.groupId
        || !(await this.eligibleForConsent(c, userId, grant.group_id))) return false;
      const offered = grant.requested_scopes.filter((scope) => this.operationalScopes.includes(scope));
      if (!scopes.every((scope) => offered.includes(scope)) || (approve && (!scopes.length || !this.scopesReady(scopes)))) return false;
      const updated = await c.query(
        "UPDATE versekit_device_grants SET status=$2,app_user_id=$3,approved_scopes=$4,consented_at=now() WHERE id=$1 AND status='pending' RETURNING id",
        [grant.id, approve ? "approved" : "denied", approve ? userId : null, approve ? scopes : []]
      );
      if (updated.rowCount !== 1) return false;
      await c.query("UPDATE versekit_consent_challenges SET consumed_at=now() WHERE challenge_hash=$1", [context.challenge_hash]);
      return true;
    });
  }
  async eligible(c, userId, groupId) {
    if (groupId !== this.groupId) return false;
    const q = await c.query(
      "SELECT 1 FROM app_users u JOIN group_members gm ON gm.app_user_id=u.id JOIN blueprint_groups g ON g.id=gm.group_id JOIN versekit_authorization_config ac ON ac.id=true AND ac.group_id=$2 WHERE u.id=$1 AND gm.group_id=$2 AND u.account_status='active'",
      [userId, this.groupId]
    );
    return q.rowCount === 1;
  }
  async eligibleForConsent(c, userId, groupId) {
    if (groupId !== this.groupId) return false;
    const q = await c.query(
      "SELECT 1 FROM app_users u JOIN group_members gm ON gm.app_user_id=u.id JOIN blueprint_groups g ON g.id=gm.group_id JOIN versekit_authorization_config ac ON ac.id=true AND ac.group_id=$2 WHERE u.id=$1 AND gm.group_id=$2 AND u.account_status='active' FOR SHARE OF u,gm,g",
      [userId, this.groupId]
    );
    return q.rowCount === 1;
  }
  async consent({ grantId, userId, scopes, approve }) {
    if (!Array.isArray(scopes) || new Set(scopes).size !== scopes.length) return false;
    return this.transaction(async (c) => {
      if (!(await this.configuredGroup(c))) return false;
      const q = await c.query("SELECT id,group_id,requested_scopes,status FROM versekit_device_grants WHERE id=$1 AND expires_at>now() FOR UPDATE", [grantId]);
      const g = q.rows[0];
      if (!g || g.status !== "pending" || !scopes.every((s) => g.requested_scopes.includes(s))) return false;
      if (approve && (!this.scopesReady(scopes) || g.group_id !== this.groupId || !(await this.eligibleForConsent(c, userId, g.group_id)))) return false;
      const u = await c.query(
        "UPDATE versekit_device_grants SET status=$2,app_user_id=$3,approved_scopes=$4,consented_at=now() WHERE id=$1 AND status='pending' RETURNING id",
        [grantId, approve ? "approved" : "denied", approve ? userId : null, approve ? scopes : []]
      );
      return u.rowCount === 1;
    });
  }
  async issuePair(c, { grantId, clientId, userId, groupId, scopes }) {
    if (!this.scopesReady(scopes) || !(await this.eligible(c, userId, groupId))) return null;
    const family = randomUUID();
    await c.query("INSERT INTO versekit_token_families(id,grant_id,client_id,app_user_id,group_id,scopes,absolute_expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+($7 * interval '1 second'))", [family, grantId, clientId, userId, groupId, scopes, FAMILY_TTL]);
    const access = this.codec.issue("vka"), refresh = this.codec.issue("vkr");
    await c.query("INSERT INTO versekit_tokens(family_id,token_hash,token_type,expires_at) VALUES($1,$2,'access',LEAST(now()+($3 * interval '1 second'),now()+($4 * interval '1 second')))", [family, this.codec.hash("access", access), ACCESS_TTL, FAMILY_TTL]);
    await c.query("INSERT INTO versekit_tokens(family_id,token_hash,token_type,expires_at) VALUES($1,$2,'refresh',now()+($3 * interval '1 second'))", [family, this.codec.hash("refresh", refresh), Math.min(REFRESH_TTL,FAMILY_TTL)]);
    return { access_token: access, token_type: "Bearer", refresh_token: refresh, expires_in: ACCESS_TTL, scope: scopes.join(" ") };
  }
  async exchangeDeviceCode({ deviceCode, clientId }) {
    return this.transaction(async (c) => {
      if (!(await this.configuredGroup(c))) return { error: "invalid_grant" };
      const q = await c.query("SELECT * FROM versekit_device_grants WHERE device_code_hash=$1 FOR UPDATE", [this.codec.hash("device_code", deviceCode || "")]);
      const g = q.rows[0];
      if (!g || g.client_id !== clientId) return { error: "invalid_grant" };
      if (new Date(g.expires_at) <= this.clock()) return { error: "expired_token" };
      if (g.status === "denied") return { error: "access_denied" };
      if (g.status === "consumed") return { error: "invalid_grant" };
      if (g.last_poll_at && this.clock() - new Date(g.last_poll_at) < g.interval_seconds * 1000) {
        const interval = Math.min(60, g.interval_seconds + 5);
        await c.query("UPDATE versekit_device_grants SET interval_seconds=$2,last_poll_at=now() WHERE id=$1", [g.id, interval]);
        return { error: "slow_down", interval };
      }
      await c.query("UPDATE versekit_device_grants SET last_poll_at=now() WHERE id=$1", [g.id]);
      if (g.status === "pending") return { error: "authorization_pending", interval: g.interval_seconds };
      if (g.status !== "approved" || !g.app_user_id || !(await this.eligibleForConsent(c, g.app_user_id, g.group_id))) return { error: "invalid_grant" };
      const tokens = await this.issuePair(c, { grantId: g.id, clientId, userId: g.app_user_id, groupId: g.group_id, scopes: g.approved_scopes });
      if (!tokens) return { error: "invalid_grant" };
      await c.query("UPDATE versekit_device_grants SET status='consumed' WHERE id=$1", [g.id]);
      return { tokens };
    });
  }
  async refresh({ refreshToken, clientId }) {
    return this.transaction(async (c) => {
      if (!(await this.configuredGroup(c))) return { error: "invalid_grant" };
      const lookup = await c.query("SELECT family_id FROM versekit_tokens WHERE token_hash=$1 AND token_type='refresh'", [this.codec.hash("refresh", refreshToken || "")]);
      if (!lookup.rowCount) return { error: "invalid_grant" };
      await c.query("SELECT id FROM versekit_token_families WHERE id=$1 FOR UPDATE", [lookup.rows[0].family_id]);
      const q = await c.query(
        "SELECT t.id,t.family_id,t.expires_at,t.revoked_at,t.replaced_by,f.grant_id,f.absolute_expires_at,f.client_id,f.app_user_id,f.group_id,f.scopes,f.revoked_at AS family_revoked,d.status AS grant_status,d.app_user_id AS grant_user_id,d.group_id AS grant_group_id,d.approved_scopes AS grant_scopes FROM versekit_tokens t JOIN versekit_token_families f ON f.id=t.family_id JOIN versekit_device_grants d ON d.id=f.grant_id WHERE t.token_hash=$1 AND t.token_type='refresh' FOR UPDATE OF t,d",
        [this.codec.hash("refresh", refreshToken || "")]
      );
      const r = q.rows[0];
      if (!r || r.client_id !== clientId) return { error: "invalid_grant" };
      if (r.revoked_at || r.replaced_by) {
        await c.query("UPDATE versekit_token_families SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1", [r.family_id]);
        await c.query("UPDATE versekit_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE family_id=$1", [r.family_id]);
        return { error: "invalid_grant" };
      }
      if (r.family_revoked || new Date(r.expires_at) <= this.clock() || new Date(r.absolute_expires_at) <= this.clock()) return { error: "invalid_grant" };
      const grantValid = r.grant_status === "consumed" && r.grant_user_id === r.app_user_id && r.grant_group_id === r.group_id
        && Array.isArray(r.grant_scopes) && r.grant_scopes.length === r.scopes.length && r.grant_scopes.every((scope) => r.scopes.includes(scope));
      const memberValid = grantValid && await this.eligibleForConsent(c, r.app_user_id, r.group_id);
      if (!memberValid) {
        await c.query("UPDATE versekit_token_families SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1", [r.family_id]);
        await c.query("UPDATE versekit_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE family_id=$1", [r.family_id]);
        return { error: "invalid_grant" };
      }
      const access = this.codec.issue("vka"), refresh = this.codec.issue("vkr");
      const accessRow = await c.query("INSERT INTO versekit_tokens(family_id,token_hash,token_type,expires_at) SELECT $1,$2,'access',LEAST(now()+($3 * interval '1 second'),absolute_expires_at) FROM versekit_token_families WHERE id=$1 RETURNING GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (expires_at-clock_timestamp()))))::int AS expires_in", [r.family_id, this.codec.hash("access", access), ACCESS_TTL]);
      if (accessRow.rowCount !== 1 || accessRow.rows[0].expires_in < 1) throw new Error("Refreshed VerseKit access token would already be expired");
      const next = await c.query("INSERT INTO versekit_tokens(family_id,token_hash,token_type,expires_at) SELECT $1,$2,'refresh',LEAST(now()+($3 * interval '1 second'),absolute_expires_at) FROM versekit_token_families WHERE id=$1 RETURNING id", [r.family_id, this.codec.hash("refresh", refresh), REFRESH_TTL]);
      await c.query("UPDATE versekit_tokens SET revoked_at=now(),replaced_by=$2 WHERE id=$1", [r.id, next.rows[0].id]);
      return { tokens: { access_token: access, token_type: "Bearer", refresh_token: refresh, expires_in: accessRow.rows[0].expires_in, scope: r.scopes.join(" ") } };
    });
  }
  async revoke(token) {
    if (typeof token !== "string" || token.length > 512) return;
    const a = this.codec.hash("access", token), r = this.codec.hash("refresh", token);
    await this.transaction(async (c) => {
      const rows = await c.query("SELECT DISTINCT family_id FROM versekit_tokens WHERE token_hash=$1 OR token_hash=$2", [a, r]);
      if (!rows.rowCount) return;
      const ids = [...new Set(rows.rows.map((row) => row.family_id))];
      await c.query("SELECT id FROM versekit_token_families WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [ids]);
      await c.query("SELECT id FROM versekit_tokens WHERE family_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [ids]);
      await c.query("UPDATE versekit_token_families SET revoked_at=COALESCE(revoked_at,now()) WHERE id=ANY($1::uuid[])", [ids]);
      await c.query("UPDATE versekit_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE family_id=ANY($1::uuid[])", [ids]);
    });
  }
  async cleanupCredentials({ batchSize = 200 } = {}) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error("Invalid cleanup batch size");
    return this.transaction(async (c) => {
      const challenges = await c.query(`WITH doomed AS (SELECT challenge_hash FROM versekit_consent_challenges WHERE (consumed_at IS NOT NULL AND consumed_at < now()-interval '1 day') OR expires_at < now()-interval '1 day' ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM versekit_consent_challenges x USING doomed d WHERE x.challenge_hash=d.challenge_hash`, [batchSize]);
      const access = await c.query(`WITH doomed AS (SELECT id FROM versekit_tokens WHERE token_type='access' AND expires_at < now() ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM versekit_tokens x USING doomed d WHERE x.id=d.id`, [batchSize]);
      const families = await c.query(`WITH doomed AS (SELECT id FROM versekit_token_families WHERE absolute_expires_at < now()-interval '7 days' ORDER BY absolute_expires_at LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM versekit_token_families f USING doomed d WHERE f.id=d.id`, [batchSize]);
      const grants = await c.query(`WITH doomed AS (SELECT id FROM versekit_device_grants g WHERE expires_at < now()-interval '30 days' AND status IN ('pending','approved','denied','consumed') AND NOT EXISTS (SELECT 1 FROM versekit_token_families f WHERE f.grant_id=g.id) ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED) DELETE FROM versekit_device_grants g USING doomed d WHERE g.id=d.id`, [batchSize]);
      return { challenges: challenges.rowCount, accessTokens: access.rowCount, families: families.rowCount, grants: grants.rowCount };
    });
  }
  async authenticateAccess(token) {
    const result = await this.authorizeAccess(token, { operation: "me" });
    return result.allowed ? result.member : null;
  }
  // Call without `client` for a short, self-contained authorization transaction.
  // Write handlers must pass their already-BEGIN'ed client so the authorization
  // row locks remain held through their protected database operation.
  async authorizeAccess(token, { operation, client = null } = {}) {
    const scope = operation === "me" ? null : (STANDARD_SCOPES.includes(operation) ? operation : undefined);
    if (scope === undefined || (scope !== null && !this.operationalScopes.includes(scope))) {
      return { allowed: false, reason: "unsupported_operation" };
    }
    if (!client) return this.transaction((c) => this.authorizeAccess(token, { operation, client: c }));
    if (typeof token !== "string" || token.length > 512) return { allowed: false, reason: "invalid_token" };
    if (!(await this.configuredGroup(client))) return { allowed: false, reason: "invalid_token" };
    const tokenHash = this.codec.hash("access", token);
    const familyLookup = await client.query(
      "SELECT family_id FROM versekit_tokens WHERE token_hash=$1 AND token_type='access'",
      [tokenHash]
    );
    if (!familyLookup.rowCount) return { allowed: false, reason: "invalid_token" };
    // Acquire the family before any token row locks, matching refresh, revoke,
    // and configuration invalidation. This also holds through caller-owned work.
    await client.query("SELECT id FROM versekit_token_families WHERE id=$1 FOR SHARE", [familyLookup.rows[0].family_id]);
    const q = await client.query(
      "SELECT f.app_user_id,f.group_id,f.scopes,u.display_name,u.verselink_name,g.name AS group_name FROM versekit_tokens t JOIN versekit_token_families f ON f.id=t.family_id JOIN versekit_device_grants d ON d.id=f.grant_id AND d.status='consumed' AND d.app_user_id=f.app_user_id AND d.group_id=f.group_id AND d.approved_scopes=f.scopes JOIN app_users u ON u.id=f.app_user_id AND u.account_status='active' JOIN blueprint_groups g ON g.id=f.group_id JOIN group_members gm ON gm.group_id=f.group_id AND gm.app_user_id=f.app_user_id JOIN versekit_authorization_config ac ON ac.id=true AND ac.group_id=$2 WHERE t.token_hash=$1 AND t.token_type='access' AND t.revoked_at IS NULL AND t.expires_at>now() AND f.revoked_at IS NULL AND f.absolute_expires_at>now() AND f.client_id='versekit' AND f.group_id=$2 AND f.scopes <@ $3::text[] FOR SHARE OF t,f,d,u,g,gm",
      [tokenHash, this.groupId, this.operationalScopes]
    );
    const member = q.rows[0];
    if (!member || !this.scopesReady(member.scopes)) return { allowed: false, reason: "invalid_token" };
    if (scope && !member.scopes.includes(scope)) return { allowed: false, reason: "scope_missing" };
    return { allowed: true, member };
  }
}
