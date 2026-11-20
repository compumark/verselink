// Called only by the enabled adapter. All objects are additive and VerseKit-specific.
export const initializeVersekitSchema = async (db, quotaPolicy = {}) => {
  const capacity = quotaPolicy.capacity ?? 24;
  const refillIntervalSeconds = quotaPolicy.refillIntervalSeconds ?? 3600;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10_000
      || !Number.isSafeInteger(refillIntervalSeconds) || refillIntervalSeconds < 1 || refillIntervalSeconds > 31_536_000) {
    throw new Error("Invalid VerseKit grant quota policy");
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS versekit_grant_quota (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      capacity integer NOT NULL DEFAULT 24 CHECK (capacity BETWEEN 1 AND 10000),
      refill_interval_seconds integer NOT NULL DEFAULT 3600 CHECK (refill_interval_seconds BETWEEN 1 AND 31536000),
      tokens numeric NOT NULL CHECK (tokens >= 0 AND tokens <= capacity),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS versekit_authorization_config (
      id boolean PRIMARY KEY DEFAULT true CHECK (id),
      group_id uuid NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE versekit_grant_quota ADD COLUMN IF NOT EXISTS capacity integer NOT NULL DEFAULT 24;
    ALTER TABLE versekit_grant_quota ADD COLUMN IF NOT EXISTS refill_interval_seconds integer NOT NULL DEFAULT 3600;
    INSERT INTO versekit_grant_quota(id,capacity,refill_interval_seconds,tokens,updated_at) VALUES(true,${capacity},${refillIntervalSeconds},${capacity},now()) ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS versekit_device_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      device_code_hash text NOT NULL UNIQUE CHECK (device_code_hash ~ '^[0-9a-f]{64}$'),
      user_code_hash text NOT NULL UNIQUE CHECK (user_code_hash ~ '^[0-9a-f]{64}$'),
      client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 128),
      app_user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
      group_id uuid NOT NULL REFERENCES blueprint_groups(id) ON DELETE CASCADE,
      requested_scopes text[] NOT NULL CHECK (cardinality(requested_scopes) > 0),
      approved_scopes text[] NOT NULL DEFAULT '{}',
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','consumed')),
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      interval_seconds integer NOT NULL DEFAULT 5 CHECK (interval_seconds BETWEEN 5 AND 60),
      last_poll_at timestamptz,
      consented_at timestamptz,
      CHECK (expires_at > created_at),
      CHECK (approved_scopes <@ requested_scopes),
      CHECK ((status IN ('approved','denied','consumed')) = (consented_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS versekit_device_grants_expiry_idx ON versekit_device_grants(expires_at);
    CREATE INDEX IF NOT EXISTS versekit_device_grants_owner_idx ON versekit_device_grants(app_user_id, group_id);

    CREATE TABLE IF NOT EXISTS versekit_consent_challenges (
      challenge_hash text PRIMARY KEY CHECK (challenge_hash ~ '^[0-9a-f]{64}$'),
      grant_id uuid NOT NULL REFERENCES versekit_device_grants(id) ON DELETE CASCADE,
      app_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      session_hash text NOT NULL CHECK (session_hash ~ '^[0-9a-f]{64}$'),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS versekit_consent_challenges_expiry_idx ON versekit_consent_challenges(expires_at);

    CREATE TABLE IF NOT EXISTS versekit_token_families (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      grant_id uuid NOT NULL REFERENCES versekit_device_grants(id) ON DELETE CASCADE,
      client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 128),
      app_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      group_id uuid NOT NULL REFERENCES blueprint_groups(id) ON DELETE CASCADE,
      scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
      revoked_at timestamptz,
      absolute_expires_at timestamptz NOT NULL DEFAULT (now() + interval '180 days'),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE versekit_token_families ADD COLUMN IF NOT EXISTS absolute_expires_at timestamptz NOT NULL DEFAULT (now() + interval '180 days');
    ALTER TABLE versekit_token_families ADD COLUMN IF NOT EXISTS grant_id uuid REFERENCES versekit_device_grants(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS versekit_token_families_grant_idx ON versekit_token_families(grant_id);
    CREATE INDEX IF NOT EXISTS versekit_token_families_owner_idx ON versekit_token_families(app_user_id, group_id);

    CREATE TABLE IF NOT EXISTS versekit_tokens (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id uuid NOT NULL REFERENCES versekit_token_families(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      token_type text NOT NULL CHECK (token_type IN ('access','refresh')),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      replaced_by uuid REFERENCES versekit_tokens(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS versekit_order_delivery_idempotency (
      group_id uuid NOT NULL REFERENCES blueprint_groups(id) ON DELETE CASCADE,
      app_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
      request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
      response_status integer,
      response_body jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(group_id,app_user_id,key_hash),
      CHECK ((response_status IS NULL) = (response_body IS NULL))
    );
    CREATE INDEX IF NOT EXISTS versekit_tokens_family_idx ON versekit_tokens(family_id);
    CREATE INDEX IF NOT EXISTS versekit_tokens_expiry_idx ON versekit_tokens(expires_at);
    CREATE INDEX IF NOT EXISTS versekit_tokens_active_lookup_idx ON versekit_tokens(token_hash, token_type) WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS versekit_token_families_retention_idx ON versekit_token_families(absolute_expires_at, revoked_at);
    CREATE INDEX IF NOT EXISTS versekit_device_grants_retention_idx ON versekit_device_grants(expires_at, status);
    CREATE INDEX IF NOT EXISTS versekit_consent_challenges_retention_idx ON versekit_consent_challenges(expires_at, consumed_at);
  `);
  const policy = await db.query("SELECT capacity,refill_interval_seconds,tokens,updated_at FROM versekit_grant_quota WHERE id=true");
  if (policy.rowCount !== 1 || Number(policy.rows[0].capacity) !== capacity || Number(policy.rows[0].refill_interval_seconds) !== refillIntervalSeconds) {
    throw new Error("VerseKit grant quota policy conflicts with the persisted policy");
  }
};

// Persist the current group binding so switching A → B → A cannot revive A's
// previously issued credentials. The row is an authorization epoch marker, not
// a second configuration source: VERSEKIT_GROUP_ID remains authoritative.
export const activateVersekitAuthorizationGroup = async (db, groupId) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO versekit_authorization_config(id,group_id) VALUES(true,$1) ON CONFLICT (id) DO NOTHING", [groupId]);
    const current = await client.query("SELECT group_id FROM versekit_authorization_config WHERE id=true FOR UPDATE");
    if (current.rowCount !== 1) throw new Error("VerseKit authorization configuration is unavailable");
    if (current.rows[0].group_id !== groupId) {
      const previousGroupId = current.rows[0].group_id;
      // Match group deletion's parent-first order. Lock one parent at a time
      // in deterministic order; a missing previous group means its ON DELETE
      // CASCADE already removed its credentials. The target must still exist.
      let previousGroupExists = false;
      for (const parentId of [...new Set([previousGroupId, groupId])].sort()) {
        const parent = await client.query("SELECT id FROM blueprint_groups WHERE id=$1 FOR KEY SHARE", [parentId]);
        if (parentId === groupId && !parent.rowCount) throw new Error("VerseKit authorization target group was deleted during activation");
        if (parentId === previousGroupId) previousGroupExists = parent.rowCount === 1;
      }
      if (previousGroupExists) {
        // Lock grants before families (their parent FK), then families before
        // tokens. Only the previously configured group can contain live
        // credentials; earlier groups were revoked by their own transition.
        await client.query("SELECT id FROM versekit_device_grants WHERE group_id=$1 ORDER BY id FOR UPDATE", [previousGroupId]);
        await client.query("SELECT id FROM versekit_token_families WHERE group_id=$1 ORDER BY id FOR UPDATE", [previousGroupId]);
        await client.query("SELECT t.id FROM versekit_tokens t JOIN versekit_token_families f ON f.id=t.family_id WHERE f.group_id=$1 ORDER BY t.id FOR UPDATE OF t", [previousGroupId]);
        await client.query("UPDATE versekit_token_families SET revoked_at=COALESCE(revoked_at,now()) WHERE group_id=$1", [previousGroupId]);
        await client.query("UPDATE versekit_tokens t SET revoked_at=COALESCE(t.revoked_at,now()) FROM versekit_token_families f WHERE f.id=t.family_id AND f.group_id=$1", [previousGroupId]);
        await client.query("UPDATE versekit_device_grants SET status='denied',app_user_id=NULL,approved_scopes='{}',consented_at=COALESCE(consented_at,now()) WHERE group_id=$1 AND status IN ('pending','approved')", [previousGroupId]);
      }
      await client.query("UPDATE versekit_authorization_config SET group_id=$1,updated_at=now() WHERE id=true", [groupId]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};
