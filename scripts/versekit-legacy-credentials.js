import { pathToFileURL } from "node:url";

const TABLES = [
  "versekit_authorization_config",
  "versekit_device_grants",
  "versekit_consent_challenges",
  "versekit_token_families",
  "versekit_tokens"
];

const schemaState = async (client) => {
  const result = await client.query(
    "SELECT name, to_regclass(name) IS NOT NULL AS present FROM unnest($1::text[]) AS name",
    [TABLES]
  );
  const present = result.rows.filter((row) => row.present).map((row) => row.name);
  if (!present.length) return false;
  if (present.length !== TABLES.length) throw new Error("VerseKit credential schema is incomplete; no rows were changed");
  return true;
};

const counts = async (client) => {
  const result = await client.query(`
    SELECT
      (SELECT count(*)::int FROM versekit_token_families WHERE revoked_at IS NULL) AS active_families,
      (SELECT count(*)::int FROM versekit_tokens WHERE revoked_at IS NULL) AS active_tokens,
      (SELECT count(*)::int FROM versekit_device_grants WHERE status IN ('pending','approved')) AS undecided_grants,
      (SELECT count(*)::int FROM versekit_consent_challenges WHERE consumed_at IS NULL AND expires_at > now()) AS live_challenges
  `);
  return result.rows[0];
};

export const assessLegacyVersekitCredentials = async (db) => {
  const client = await db.connect();
  try {
    await client.query("BEGIN READ ONLY");
    if (!(await schemaState(client))) {
      await client.query("COMMIT");
      return { schemaPresent: false, active_families: 0, active_tokens: 0, undecided_grants: 0, live_challenges: 0 };
    }
    const result = await counts(client);
    await client.query("COMMIT");
    return { schemaPresent: true, ...result };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

export const assertLegacyCleanupQuiesced = ({ versekitEnabled, allInstancesQuiesced } = {}) => {
  if (versekitEnabled !== "false") {
    throw new Error("Set VERSEKIT_ENABLED=false before applying legacy cleanup");
  }
  if (allInstancesQuiesced !== true) {
    throw new Error("Confirm every VerseLink instance is stopped or restarted with VerseKit disabled before applying legacy cleanup");
  }
};

export const revokeLegacyVersekitCredentials = async (db, preconditions = {
  versekitEnabled: process.env.VERSEKIT_ENABLED,
  allInstancesQuiesced: process.env.VERSEKIT_CLEANUP_ALL_INSTANCES_QUIESCED === "true"
}) => {
  assertLegacyCleanupQuiesced(preconditions);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    if (!(await schemaState(client))) {
      await client.query("COMMIT");
      return { schemaPresent: false, revoked_families: 0, revoked_tokens: 0, denied_grants: 0, expired_challenges: 0 };
    }

    // Preserve VK-04's configuration and parent-group-first locking. This
    // tool is only safe after every VerseKit adapter is disabled/stopped:
    // the enabled adapter's scheduled cleanup uses a different child order.
    await client.query("SELECT group_id FROM versekit_authorization_config WHERE id=true FOR UPDATE");
    await client.query(`
      SELECT id FROM blueprint_groups
      WHERE id IN (
        SELECT group_id FROM versekit_device_grants
        UNION
        SELECT group_id FROM versekit_token_families
      )
      ORDER BY id FOR KEY SHARE
    `);
    await client.query("SELECT id FROM versekit_device_grants ORDER BY id FOR UPDATE");
    await client.query("SELECT challenge_hash FROM versekit_consent_challenges ORDER BY challenge_hash FOR UPDATE");
    await client.query("SELECT id FROM versekit_token_families ORDER BY id FOR UPDATE");
    await client.query(`
      SELECT t.id FROM versekit_tokens t
      JOIN versekit_token_families f ON f.id=t.family_id
      ORDER BY f.group_id,t.id FOR UPDATE OF t
    `);

    const families = await client.query("UPDATE versekit_token_families SET revoked_at=COALESCE(revoked_at,now()) WHERE revoked_at IS NULL");
    const tokens = await client.query("UPDATE versekit_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE revoked_at IS NULL");
    const grants = await client.query(`
      UPDATE versekit_device_grants
      SET status='denied',app_user_id=NULL,approved_scopes='{}',consented_at=COALESCE(consented_at,now())
      WHERE status IN ('pending','approved')
    `);
    const challenges = await client.query(`
      UPDATE versekit_consent_challenges SET expires_at=LEAST(expires_at,now())
      WHERE consumed_at IS NULL AND expires_at>now()
    `);
    await client.query("COMMIT");
    return {
      schemaPresent: true,
      revoked_families: families.rowCount,
      revoked_tokens: tokens.rowCount,
      denied_grants: grants.rowCount,
      expired_challenges: challenges.rowCount
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

const main = async () => {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  if ([...args].some((arg) => !["--apply", "--dry-run", "--confirm-versekit-only-revocation", "--confirm-all-versekit-instances-quiesced"].includes(arg))) {
    throw new Error("Usage: node scripts/versekit-legacy-credentials.js [--dry-run | --apply --confirm-versekit-only-revocation --confirm-all-versekit-instances-quiesced]");
  }
  if (apply && (!args.has("--confirm-versekit-only-revocation")
    || !args.has("--confirm-all-versekit-instances-quiesced") || args.has("--dry-run"))) {
    throw new Error("Applying cleanup requires --apply, both confirmation flags, and no --dry-run");
  }
  if (apply) {
    assertLegacyCleanupQuiesced({
      versekitEnabled: process.env.VERSEKIT_ENABLED,
      allInstancesQuiesced: args.has("--confirm-all-versekit-instances-quiesced")
    });
  }
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const { Pool } = await import("pg");
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    const result = apply
      ? await revokeLegacyVersekitCredentials(db, {
        versekitEnabled: process.env.VERSEKIT_ENABLED,
        allInstancesQuiesced: args.has("--confirm-all-versekit-instances-quiesced")
      })
      : await assessLegacyVersekitCredentials(db);
    console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", ...result }));
  } finally {
    await db.end();
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
