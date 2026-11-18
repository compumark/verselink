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
