import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { selectWikiCandidate, selectWikiImageFile, shouldRefreshReference, wikiSourceMatchesProduct } from "./reference-resolver.js";
import { hashRecoveryToken, isRecoveryToken, generateRecoveryToken } from "./auth-primitives.js";
import { clientKey, createRateLimiter } from "./rate-limit.js";
import { normalizeScmdbSinkBaseUrl, scmdbSinkUrl } from "./scmdb-sink-config.js";
import { createDiscordAdminNotifier } from "./discord-admin-dm.js";
import { createLogger } from "./logger.js";

const { Pool } = pg;
const root = fileURLToPath(new URL("..", import.meta.url));
const publicDir = join(root, "public");
const logDirectory = process.env.LOG_DIR || "/app/logs";
const logger = createLogger({ logDirectory });
const port = Number(process.env.APP_PORT || 3000);
const inviteExpiryDate = (days = 14, now = new Date()) => {
  const expiry = new Date(now);
  expiry.setDate(expiry.getDate() + days);
  expiry.setHours(0, 0, 0, 0);
  expiry.setDate(expiry.getDate() + 1);
  return expiry;
};
const cleanupExpiredInvites = async () => {
  const result = await pool.query("DELETE FROM group_invites WHERE expires_at <= now() RETURNING id");
  logger.info("invites.cleanup", { removed: result.rowCount });
};
const scheduleInviteCleanup = () => {
  const now = new Date();
  const next = new Date(now);
  next.setHours(0, 10, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(async () => {
    try { await cleanupExpiredInvites(); } catch (error) { logger.warn("invites.cleanup.failed", { error: error.message }); }
    scheduleInviteCleanup();
  }, Math.max(1000, next.getTime() - now.getTime()));
};
const pepper = process.env.SINK_TOKEN_PEPPER;
const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL;
const discordOrdersWebhooks = (() => {
  try {
    const entries = Object.entries(JSON.parse(process.env.DISCORD_ORDERS_WEBHOOKS || "{}"));
    return new Map(entries.map(([group, webhook]) => [group.trim().toLowerCase(), String(webhook).trim()]).filter(([, webhook]) => webhook));
  } catch { logger.warn("discord.order_webhooks.invalid_configuration"); return new Map(); }
})();
logger.info("discord.order_webhooks.configured", { groups: discordOrdersWebhooks.size });
const verseLinkAppUrl = process.env.VERSELINK_APP_URL || "http://localhost:3000";
const uexApiToken = process.env.UEX_API_TOKEN;
const UEX_CACHE_TTL_MS = 1800000;
const TRADING_DATA_MAX_AGE_SECONDS = 6 * 60 * 60;
const tradingShips = Object.fromEntries([
  ["hull_e", ["Hull E", 12288]], ["hull_d", ["Hull D", 6912]], ["hull_c", ["Hull C", 4608]], ["merchantman", ["Merchantman", 2880]],
  ["ironclad", ["Ironclad", 2200]], ["ironclad_assault", ["Ironclad Assault", 1440]], ["pioneer", ["Pioneer", 1000]], ["c2_hercules", ["C2 Hercules Starlifter", 696]],
  ["railen", ["Railen", 640]], ["caterpillar", ["Caterpillar", 576]], ["m2_hercules", ["M2 Hercules Starlifter", 522]], ["hull_b", ["Hull B", 512]],
  ["a2_hercules", ["A2 Hercules Starlifter", 216]], ["raft", ["RAFT", 192]], ["constellation_taurus", ["Constellation Taurus", 174]], ["freelancer_max", ["Freelancer MAX", 120]],
  ["mercury_star_runner", ["Mercury Star Runner", 114]], ["constellation_andromeda", ["Constellation Andromeda", 96]], ["freelancer", ["Freelancer", 66]], ["c1_spirit", ["C1 Spirit", 64]], ["hull_a", ["Hull A", 64]],
  ["cutlass_black", ["Cutlass Black", 46]], ["nomad", ["Nomad", 24]], ["315p", ["315p", 12]], ["aurora_cl", ["Aurora CL", 6]], ["135c", ["135c", 6]], ["reliant_kore", ["Reliant Kore", 6]], ["cutter", ["Cutter", 4]], ["mustang_alpha", ["Mustang Alpha", 4]], ["mpuv_cargo", ["MPUV Cargo", 2]]
].map(([id, [name, cargo]]) => [id, { name, cargo }]));
const tradingShipOptions = Object.entries(tradingShips).sort(([, a], [, b]) => b.cargo - a.cargo);
const tradingSystems = { stanton: "Stanton", pyro: "Pyro", nyx: "Nyx" };
const materialOrderCodes = new Map([
  ["agricium", "AGRI"], ["aluminum", "ALUM"], ["aphorite", "APHO"], ["aslarite", "ASLA"], ["beryl", "BERY"], ["bexalite", "BEXA"], ["boron", "BORO"], ["borase", "BORA"], ["copper", "COPP"], ["corundum", "CORU"], ["diamond", "DIAM"], ["dolivine", "DOLI"], ["gold", "GOLD"], ["hadanite", "HADA"], ["hephaestanite", "HEPH"], ["iron", "IRON"], ["janalite", "JANA"], ["laranite", "LARA"], ["ouratite", "OURA"], ["quantainium", "QUAN"], ["savrilium", "SAVR"], ["stileron", "STIL"], ["taranite", "TARA"], ["titanium", "TITA"], ["tungsten", "TUNG"]
]);
const materialOrderCode = (material) => materialOrderCodes.get(String(material || "").trim().toLowerCase()) || "ITEM";
let uexPriceCache = { expiresAt: 0, rows: null, updatedAt: null };
let uexLocationCache = { expiresAt: 0, rows: [] };
const databaseUrl = process.env.DATABASE_URL;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const configuredAdminUserIds = (() => {
  const entries = String(process.env.APP_ADMIN_USER_IDS || "").split(",").map((value) => value.trim()).filter(Boolean);
  const validIds = entries.filter((value) => uuidPattern.test(value));
  if (validIds.length !== entries.length) logger.warn("admin.configuration.invalid_user_ids", { message: "ignored invalid APP_ADMIN_USER_IDS entries", count: entries.length - validIds.length });
  return new Set(validIds.map((value) => value.toLowerCase()));
})();
const changelogSource = readFileSync(join(publicDir, "changelog.html"), "utf8");
const appCommit = String(process.env.APP_COMMIT || process.env.GIT_COMMIT || "unknown").trim() || "unknown";
const appEnvironment = String(process.env.APP_ENVIRONMENT || "Production UI").trim() || "Production UI";
const notifyNewUserRegistration = createDiscordAdminNotifier({ botToken: process.env.DISCORD_BOT_TOKEN, adminUserId: process.env.DISCORD_ADMIN_USER_ID, environment: appEnvironment });
const appVersion = String(process.env.APP_VERSION || changelogSource.match(/data-release-kind="stable"\s+data-version="([^"]+)"/)?.[1]?.trim() || "unknown").trim() || "unknown";
// Mobiglass view compatibility marker: 'changelog','about'
const applyVerseLinkBranding = (html) => html
  .replaceAll("SCMDB Blueprint Inventory", "VerseLink – Star Citizen Companion")
  .replaceAll("SC Blueprint Inventory", "VerseLink")
  .replaceAll("Blueprint Inventory", "VerseLink")
  .replaceAll("blueprint inventory", "VerseLink")
  .replaceAll("Blueprint inventory", "VerseLink")
  .replaceAll("SC BLUEPRINT INVENTORY", "VERSELINK")
  .replaceAll("BLUEPRINT MANAGEMENT SYSTEM", "STAR CITIZEN COMPANION")
  .replaceAll("/assets/themes/mobiglass/mobiglass-blue-logo.png", "/assets/verselink.png")
  .replaceAll("/assets/apps/inventory.png' alt=\"Blueprint Inventory", "/assets/verselink.png' alt=\"VerseLink");
if (!pepper) throw new Error("SINK_TOKEN_PEPPER is required");

const pool = new Pool(databaseUrl ? { connectionString: databaseUrl, max: 10 } : {
  host: process.env.PGHOST || "db",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "blueprints",
  user: process.env.PGUSER || "blueprints",
  password: process.env.PGPASSWORD,
  max: 10
});

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  "access-control-allow-headers": "Content-Type"
};

const scmdbSinkBaseUrl = normalizeScmdbSinkBaseUrl(process.env.SCMDB_SINK_BASE_URL);
if (String(process.env.SCMDB_SINK_BASE_URL || "").trim() && !scmdbSinkBaseUrl) logger.warn("scmdb.configuration.invalid_sink_url");

const publicTokenKey = createHash("sha256").update(pepper).update("public-link-token-storage").digest();
const encryptPublicToken = (token) => { const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", publicTokenKey, iv); const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]); return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`; };
const decryptPublicToken = (value) => { try { const [iv, tag, encrypted] = String(value || "").split("."); const decipher = createDecipheriv("aes-256-gcm", publicTokenKey, Buffer.from(iv, "base64url")); decipher.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8"); } catch { return null; } };

const schemaSql = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS scmdb_connections (
  token_hash text PRIMARY KEY,
  scmdb_user_id text,
  user_handle text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS revoked_sink_tokens (
  token_hash text PRIMARY KEY,
  revoked_at timestamptz NOT NULL DEFAULT now(),
  reason text
);
CREATE INDEX IF NOT EXISTS revoked_sink_tokens_revoked_at_idx ON revoked_sink_tokens(revoked_at DESC);
CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  display_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_admin boolean NOT NULL DEFAULT false,
  account_status text NOT NULL DEFAULT 'active' CHECK (account_status IN ('active','blocked','deleted'))
);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS accent_color varchar(7);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_users_accent_color_check') THEN
    ALTER TABLE app_users ADD CONSTRAINT app_users_accent_color_check CHECK (accent_color IS NULL OR accent_color ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS auth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS auth_recovery_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_recovery_tokens_active_user_idx
  ON auth_recovery_tokens(app_user_id)
  WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS blueprint_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id uuid REFERENCES blueprint_groups(id) ON DELETE CASCADE,
  app_user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, app_user_id)
);
CREATE TABLE IF NOT EXISTS group_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES blueprint_groups(id) ON DELETE CASCADE,
  email text,
  invite_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE IF NOT EXISTS material_order_number_seq;
CREATE TABLE IF NOT EXISTS material_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number text UNIQUE NOT NULL,
  group_id uuid NOT NULL REFERENCES blueprint_groups(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  assigned_to uuid REFERENCES app_users(id) ON DELETE SET NULL,
  blueprint_tag text,
  material_name text NOT NULL,
  required_quantity numeric NOT NULL CHECK (required_quantity > 0),
  quantity_unit text NOT NULL DEFAULT 'SCU',
  required_quality text,
  delivered_quantity numeric,
  delivered_quality text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','reported','completed','cancelled')),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
ALTER TABLE material_orders ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
CREATE INDEX IF NOT EXISTS material_orders_group_idx ON material_orders(group_id, status, created_at DESC);
CREATE TABLE IF NOT EXISTS material_order_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES material_orders(id) ON DELETE CASCADE,
  delivered_by uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  delivered_quantity numeric NOT NULL CHECK (delivered_quantity > 0),
  delivered_quality text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE material_orders ADD COLUMN IF NOT EXISTS order_number text;
UPDATE material_orders SET order_number='ITEM-' || to_char(created_at, 'YYYY') || '-' || lpad(legacy.row_number::text, 4, '0') FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS row_number FROM material_orders WHERE order_number IS NULL) legacy WHERE material_orders.id=legacy.id;
UPDATE material_orders SET order_number=(CASE lower(material_name) WHEN 'agricium' THEN 'AGRI' WHEN 'aluminum' THEN 'ALUM' WHEN 'aslarite' THEN 'ASLA' WHEN 'beryl' THEN 'BERY' WHEN 'bexalite' THEN 'BEXA' WHEN 'boron' THEN 'BORA' WHEN 'copper' THEN 'COPP' WHEN 'corundum' THEN 'CORU' WHEN 'dolivine' THEN 'DOLI' WHEN 'gold' THEN 'GOLD' WHEN 'hadanite' THEN 'HADA' WHEN 'hephaestanite' THEN 'HEPH' WHEN 'iron' THEN 'IRON' WHEN 'laranite' THEN 'LARA' WHEN 'ouratite' THEN 'OURA' WHEN 'quantainium' THEN 'QUAN' WHEN 'savrilium' THEN 'SAVR' WHEN 'stileron' THEN 'STIL' WHEN 'taranite' THEN 'TARA' WHEN 'titanium' THEN 'TITA' WHEN 'tungsten' THEN 'TUNG' ELSE 'ITEM' END) || '-' || to_char(created_at, 'YYYY') || '-' || regexp_replace(order_number, '^ORD-[0-9]{4}-', '') WHERE order_number ~ '^ORD-[0-9]{4}-[0-9]+$';
SELECT setval('material_order_number_seq', GREATEST(COALESCE((SELECT MAX(regexp_replace(order_number, '^.*-', '')::bigint) FROM material_orders WHERE order_number ~ '^[A-Z]+-[0-9]{4}-[0-9]+$'), 0), 1), true);
ALTER TABLE material_orders ALTER COLUMN order_number DROP DEFAULT;
ALTER TABLE material_orders ALTER COLUMN order_number SET NOT NULL;
CREATE INDEX IF NOT EXISTS material_order_deliveries_order_idx ON material_order_deliveries(order_id, created_at);
CREATE TABLE IF NOT EXISTS mining_pools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id uuid NOT NULL REFERENCES blueprint_groups(id) ON DELETE CASCADE,
  name text NOT NULL, description text, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz
);
CREATE TABLE IF NOT EXISTS mining_pool_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pool_id uuid NOT NULL REFERENCES mining_pools(id) ON DELETE CASCADE,
  material_name text NOT NULL, quality_band integer NOT NULL CHECK (quality_band BETWEEN 1 AND 8), target_scu numeric CHECK (target_scu IS NULL OR target_scu >= 0), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(pool_id, material_name, quality_band)
);
CREATE TABLE IF NOT EXISTS mining_pool_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), pool_resource_id uuid NOT NULL REFERENCES mining_pool_resources(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, quantity_scu numeric NOT NULL CHECK (quantity_scu > 0), quality_value integer NOT NULL CHECK (quality_value BETWEEN 1 AND 1000), status text NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','deposited')),
  source_location text, note text, created_at timestamptz NOT NULL DEFAULT now(), deposited_at timestamptz
);
ALTER TABLE mining_pool_contributions ADD COLUMN IF NOT EXISTS in_refinery boolean NOT NULL DEFAULT false;
ALTER TABLE mining_pool_contributions ADD COLUMN IF NOT EXISTS refinery_station text;
CREATE INDEX IF NOT EXISTS mining_pool_group_idx ON mining_pools(group_id, created_at DESC);
CREATE TABLE IF NOT EXISTS material_inventory_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES blueprint_groups(id) ON DELETE CASCADE,
  material_name text NOT NULL,
  quality_band integer NOT NULL CHECK (quality_band BETWEEN 1 AND 8),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  quantity_scu numeric NOT NULL CHECK (quantity_scu > 0),
  quality_value integer NOT NULL CHECK (quality_value BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'reported' CHECK (status IN ('reported','deposited')),
  source_location text, note text, in_refinery boolean NOT NULL DEFAULT false,
  refinery_station text, created_at timestamptz NOT NULL DEFAULT now(), deposited_at timestamptz
);
CREATE INDEX IF NOT EXISTS material_inventory_group_idx ON material_inventory_contributions(group_id, created_at DESC);
CREATE TABLE IF NOT EXISTS material_inventory_withdrawals (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), group_id uuid NOT NULL REFERENCES blueprint_groups(id) ON DELETE CASCADE, material_name text NOT NULL, quality_band integer NOT NULL, user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE, warehouse text, quantity_scu numeric NOT NULL CHECK (quantity_scu > 0), note text, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE material_inventory_withdrawals ADD COLUMN IF NOT EXISTS quality_value integer;
ALTER TABLE material_inventory_withdrawals ADD COLUMN IF NOT EXISTS contributor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS material_inventory_withdrawal_idx ON material_inventory_withdrawals(group_id, created_at DESC);
CREATE TABLE IF NOT EXISTS uex_refinery_locations (
  terminal_name text PRIMARY KEY, system_name text, planet_name text, station_name text,
  is_available_live boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS uex_sync_state (id boolean PRIMARY KEY DEFAULT true, last_sync_at timestamptz);
CREATE TABLE IF NOT EXISTS app_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  order_id uuid REFERENCES material_orders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX IF NOT EXISTS app_notifications_user_idx ON app_notifications(app_user_id, read_at, created_at DESC);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS account_status text NOT NULL DEFAULT 'active';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS verselink_name text;
CREATE UNIQUE INDEX IF NOT EXISTS app_users_verselink_name_idx ON app_users(lower(verselink_name)) WHERE verselink_name IS NOT NULL;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS rsi_profile_url text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS discord_name text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS profile_public boolean NOT NULL DEFAULT false;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS rsi_avatar_url text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS rsi_handle text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS rsi_citizen_record text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS rsi_organization text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS rsi_enlisted text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS rsi_fluency text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS rsi_profile_synced_at timestamptz;
ALTER TABLE group_invites ADD COLUMN IF NOT EXISTS invite_code text;
ALTER TABLE group_invites ADD COLUMN IF NOT EXISTS max_uses integer DEFAULT 1;
ALTER TABLE group_invites ADD COLUMN IF NOT EXISTS use_count integer NOT NULL DEFAULT 0;
ALTER TABLE scmdb_connections ADD COLUMN IF NOT EXISTS app_user_id uuid REFERENCES app_users(id);
ALTER TABLE scmdb_connections ADD COLUMN IF NOT EXISTS connection_status text NOT NULL DEFAULT 'connected';
ALTER TABLE scmdb_connections ADD COLUMN IF NOT EXISTS connected_at timestamptz;
ALTER TABLE scmdb_connections ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;
ALTER TABLE scmdb_connections ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
UPDATE scmdb_connections SET connected_at = COALESCE(last_seen_at, first_seen_at, now()) WHERE connected_at IS NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'scmdb_connections'::regclass
      AND conname = 'scmdb_connections_connection_status_check'
  ) THEN
    ALTER TABLE scmdb_connections
      ADD CONSTRAINT scmdb_connections_connection_status_check
      CHECK (connection_status IN ('pending', 'connected', 'disconnected', 'revoked'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS scmdb_connections_app_user_idx ON scmdb_connections(app_user_id);
CREATE TABLE IF NOT EXISTS scmdb_profiles (
  token_hash text PRIMARY KEY REFERENCES scmdb_connections(token_hash) ON DELETE CASCADE,
  scmdb_user_id text NOT NULL,
  display_name text,
  rsi_handle text,
  organizations jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS scmdb_events (
  event_id text PRIMARY KEY,
  token_hash text NOT NULL REFERENCES scmdb_connections(token_hash) ON DELETE CASCADE,
  event_name text NOT NULL,
  event_ts bigint NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS member_blueprints (
  token_hash text NOT NULL REFERENCES scmdb_connections(token_hash) ON DELETE CASCADE,
  tag text NOT NULL,
  product_name text,
  owned_at bigint NOT NULL,
  first_seen_at bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (token_hash, tag)
);
CREATE INDEX IF NOT EXISTS member_blueprints_tag_idx ON member_blueprints(tag);
ALTER TABLE member_blueprints ADD COLUMN IF NOT EXISTS first_seen_at bigint NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS reference_blueprints (
  tag text PRIMARY KEY,
  product_name text,
  category text,
  subcategory text,
  manufacturer text,
  source_version text,
  image_url text,
  source_url text,
  image_checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE reference_blueprints ADD COLUMN IF NOT EXISTS image_url text;
ALTER TABLE reference_blueprints ADD COLUMN IF NOT EXISTS source_url text;
ALTER TABLE reference_blueprints ADD COLUMN IF NOT EXISTS image_checked_at timestamptz;
ALTER TABLE reference_blueprints ADD COLUMN IF NOT EXISTS materials_json jsonb;
CREATE TABLE IF NOT EXISTS dashboard_sessions (
  session_hash text PRIMARY KEY,
  token_hash text REFERENCES scmdb_connections(token_hash) ON DELETE CASCADE,
  app_user_id uuid REFERENCES app_users(id),
  expires_at timestamptz NOT NULL
);
ALTER TABLE dashboard_sessions ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE dashboard_sessions ADD COLUMN IF NOT EXISTS app_user_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'dashboard_sessions'::regclass
      AND conname = 'dashboard_sessions_app_user_id_fkey'
  ) THEN
    ALTER TABLE dashboard_sessions
      ADD CONSTRAINT dashboard_sessions_app_user_id_fkey
      FOREIGN KEY (app_user_id) REFERENCES app_users(id);
  END IF;
END $$;
UPDATE dashboard_sessions ds
SET app_user_id = c.app_user_id
FROM scmdb_connections c
WHERE ds.token_hash = c.token_hash
  AND ds.app_user_id IS NULL
  AND c.app_user_id IS NOT NULL;
DELETE FROM dashboard_sessions WHERE token_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS public_group_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES blueprint_groups(id) ON DELETE CASCADE,
  token_hash text UNIQUE NOT NULL,
  label text,
  enabled boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  created_by uuid REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
ALTER TABLE public_group_links ADD COLUMN IF NOT EXISTS token_ciphertext text;
CREATE INDEX IF NOT EXISTS public_group_links_group_idx ON public_group_links(group_id);
CREATE TABLE IF NOT EXISTS item_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text UNIQUE, name text NOT NULL,
  category text NOT NULL DEFAULT 'Other', subcategory text, manufacturer text, description text,
  image_url text, source text, active boolean NOT NULL DEFAULT true, introduced_version text,
  last_seen_version text, source_updated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS item_catalog_name_idx ON item_catalog (lower(name));
CREATE INDEX IF NOT EXISTS item_catalog_active_idx ON item_catalog (active);
CREATE TABLE IF NOT EXISTS inventory_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), external_id text UNIQUE, name text NOT NULL UNIQUE,
  type text NOT NULL DEFAULT 'home', star_system text, is_home_location boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS user_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES item_catalog(id) ON DELETE RESTRICT, quantity integer NOT NULL CHECK (quantity >= 1),
  location_id uuid NOT NULL REFERENCES inventory_locations(id) ON DELETE RESTRICT, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, item_id, location_id)
);
CREATE INDEX IF NOT EXISTS user_inventory_user_idx ON user_inventory(user_id);
CREATE INDEX IF NOT EXISTS user_inventory_item_idx ON user_inventory(item_id);
CREATE INDEX IF NOT EXISTS user_inventory_location_idx ON user_inventory(location_id);
ALTER TABLE user_inventory ADD COLUMN IF NOT EXISTS trade_status text NOT NULL DEFAULT 'NOT_FOR_TRADE' CHECK (trade_status IN ('NOT_FOR_TRADE','MAY_TRADE','FOR_TRADE'));
ALTER TABLE user_inventory ADD COLUMN IF NOT EXISTS trade_quantity integer NOT NULL DEFAULT 0 CHECK (trade_quantity >= 0);
ALTER TABLE user_inventory ADD COLUMN IF NOT EXISTS owner_note text CHECK (owner_note IS NULL OR char_length(owner_note) <= 500);
ALTER TABLE user_inventory ADD COLUMN IF NOT EXISTS share_note boolean NOT NULL DEFAULT false;
ALTER TABLE user_inventory ADD COLUMN IF NOT EXISTS favorite boolean NOT NULL DEFAULT false;
ALTER TABLE user_inventory ADD COLUMN IF NOT EXISTS target_quantity integer CHECK (target_quantity IS NULL OR target_quantity >= 0);
UPDATE user_inventory SET trade_quantity=LEAST(trade_quantity,quantity), trade_status='NOT_FOR_TRADE' WHERE trade_quantity > quantity OR trade_quantity IS NULL;
CREATE INDEX IF NOT EXISTS user_inventory_trade_idx ON user_inventory(item_id, trade_status);
CREATE TABLE IF NOT EXISTS personal_inventory_settings (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  visibility text NOT NULL DEFAULT 'PRIVATE' CHECK (visibility IN ('PRIVATE','GROUPS','PUBLIC')),
  location_visibility text NOT NULL DEFAULT 'PRIVATE' CHECK (location_visibility IN ('PRIVATE','GROUPS','PUBLIC')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS personal_inventory_settings_visibility_idx ON personal_inventory_settings(visibility, location_visibility);
CREATE TABLE IF NOT EXISTS inventory_wanted (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES item_catalog(id) ON DELETE RESTRICT, wanted_quantity integer NOT NULL CHECK (wanted_quantity >= 1),
  note text, priority text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,item_id)
);
ALTER TABLE inventory_wanted ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW','NORMAL','HIGH'));
CREATE INDEX IF NOT EXISTS inventory_wanted_user_idx ON inventory_wanted(user_id);
CREATE INDEX IF NOT EXISTS inventory_wanted_item_idx ON inventory_wanted(item_id);
CREATE TABLE IF NOT EXISTS inventory_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('PATCH_RESET','FULL_WIPE')),
  game_version text, target_location_id uuid REFERENCES inventory_locations(id) ON DELETE SET NULL,
  unique_items integer NOT NULL CHECK (unique_items >= 0), total_items integer NOT NULL CHECK (total_items >= 0),
  location_count integer NOT NULL CHECK (location_count >= 0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inventory_events_user_created_idx ON inventory_events(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS inventory_sync_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  item_external_id text NOT NULL, item_name text, category text NOT NULL DEFAULT 'Other', location_external_id text NOT NULL,
  location_name text NOT NULL, storage_type text NOT NULL, quantity integer NOT NULL CHECK (quantity >= 0), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id, item_external_id, location_external_id, storage_type)
);
CREATE TABLE IF NOT EXISTS inventory_transactions (
  event_id text PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  item_external_id text NOT NULL, direction text NOT NULL, quantity integer NOT NULL CHECK (quantity > 0),
  location_external_id text NOT NULL, location_name text NOT NULL, game_channel text, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO inventory_locations (external_id,name,type,star_system,is_home_location) VALUES
 ('lorville','Lorville','home','Stanton',true),('area18','Area18','home','Stanton',true),('new-babbage','New Babbage','home','Stanton',true),('orison','Orison','home','Stanton',true)
 ON CONFLICT (name) DO NOTHING;
INSERT INTO item_catalog (external_id,name,category,subcategory,manufacturer,source) VALUES
 ('phase1-p4-ar','P4-AR Rifle','Weapons','Assault Rifle','Behring','phase1-seed'),
 ('phase1-fs9','FS-9 LMG','Weapons','Light Machine Gun','Behring','phase1-seed'),
 ('phase1-mk2-helmet','Arclight II Helmet','Armor','Helmet','Calderon','phase1-seed'),
 ('phase1-medpen','MedPen','Consumables','Medical','-','phase1-seed')
 ON CONFLICT (external_id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, subcategory=EXCLUDED.subcategory, manufacturer=EXCLUDED.manufacturer, active=true, updated_at=now();
`;

const json = (res, status, body) => {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders
  });
  res.end(JSON.stringify(body));
};

const accepted = (res) => {
  res.writeHead(204, corsHeaders);
  res.end();
};

const readBody = async (req) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("payload too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const hashToken = (token) => createHmac("sha256", pepper).update(token).digest("hex");
const generateScmdbSinkToken = () => randomBytes(32).toString("hex");
const hashAuthToken = (token) => createHmac("sha256", pepper).update(`verselink-auth:${token}`).digest("hex");
const verseLinkTokenPattern = /^vl_[A-Za-z0-9_-]{43,64}$/;
const generateVerseLinkToken = () => `vl_${randomBytes(32).toString("base64url")}`;
const hashSession = (session) => createHmac("sha256", pepper).update(`session:${session}`).digest("hex");
const hashPublicToken = (token) => createHmac("sha256", pepper).update(`public-link:${token}`).digest("hex");
const loginRateLimit = createRateLimiter({ limit: 10, windowMs: 10 * 60_000 });
const registrationRateLimit = createRateLimiter({ limit: 5, windowMs: 15 * 60_000 });
const recoveryRateLimit = createRateLimiter({ limit: 5, windowMs: 15 * 60_000 });
const recoveryRotationRateLimit = createRateLimiter({ limit: 5, windowMs: 15 * 60_000 });
const tooManyRequests = (res) => json(res, 429, { error: "too many requests" });
const sameVerseLinkOrigin = (req) => {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(verseLinkAppUrl).origin; } catch { return false; }
};
const publicTokenPattern = /^[A-Za-z0-9_-]{40,128}$/;
const publicRate = new Map();
const publicRateLimit = (req) => {
  const now = Date.now();
  const address = req.socket?.remoteAddress || "unknown";
  const current = publicRate.get(address);
  if (!current || current.resetAt <= now) { publicRate.set(address, { count: 1, resetAt: now + 60_000 }); return true; }
  if (current.count >= 120) return false;
  current.count += 1;
  return true;
};
const escapeLike = (value) => String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
const parsePublicSearch = (url) => {
  const q = url.searchParams.get("q")?.trim() || null;
  const category = url.searchParams.get("category")?.trim() || null;
  const subcategory = url.searchParams.get("subcategory")?.trim() || null;
  const manufacturer = url.searchParams.get("manufacturer")?.trim() || null;
  for (const value of [q, category, subcategory, manufacturer]) if (value && value.length > 100) return { error: "search parameter too long" };
  const pageRaw = url.searchParams.get("page") || "1";
  const sizeRaw = url.searchParams.get("page_size") || "50";
  const page = Number(pageRaw), pageSize = Number(sizeRaw);
  if (!Number.isInteger(page) || page < 1 || page > 100000) return { error: "invalid page" };
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) return { error: "invalid page_size" };
  return { page, pageSize, offset: (page - 1) * pageSize, q: q ? `%${escapeLike(q)}%` : null, category, subcategory, manufacturer };
};

const validText = (value, max = 500) => typeof value === "string" && value.length > 0 && value.length <= max;
const normalizeRsiProfileUrl = (value) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)robertsspaceindustries\.com$/i.test(url.hostname) ? url.href : null;
  } catch { return null; }
};
const isRsiHost = (hostname) => /(^|\.)robertsspaceindustries\.com$/i.test(hostname);
const decodeRsiText = (value) => String(value || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim() || null;
const rsiEntry = (html, label) => {
  const labelPattern = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<span\\s+class="label"[^>]*>\\s*${labelPattern}\\s*<\\/span>\\s*<strong\\s+class="value"[^>]*>([\\s\\S]*?)<\\/strong>`, "i"));
  return decodeRsiText(match?.[1]);
};
const parseRsiProfile = (html, profileUrl) => {
  const avatarMatch = html.match(/<div class="profile left-col">[\s\S]*?<div class="thumb">\s*<img\s+src="([^"]+)"/i);
  let avatarUrl = null;
  if (avatarMatch?.[1]) {
    try {
      const candidate = new URL(avatarMatch[1], profileUrl);
      if (candidate.protocol === "https:" && isRsiHost(candidate.hostname)) avatarUrl = candidate.href;
    } catch {}
  }
  return {
    avatarUrl,
    handle: rsiEntry(html, "Handle name"),
    citizenRecord: rsiEntry(html, "UEE Citizen Record"),
    enlisted: rsiEntry(html, "Enlisted"),
    fluency: rsiEntry(html, "Fluency"),
    organization: decodeRsiText(html.match(/<div class="main-org[^>]*>[\s\S]*?<a[^>]*class="value[^\"]*"[^>]*>([\s\S]*?)<\/a>/i)?.[1])
  };
};
const fetchRsiProfile = async (profileUrl) => {
  const url = new URL(profileUrl);
  if (url.protocol !== "https:" || !isRsiHost(url.hostname)) throw new Error("invalid RSI profile URL");
  const response = await fetch(url, { headers: { accept: "text/html", "user-agent": "VerseLink profile preview" }, redirect: "error", signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`RSI returned HTTP ${response.status}`);
  const html = await response.text();
  if (html.length > 2_000_000) throw new Error("RSI profile response too large");
  const profile = parseRsiProfile(html, url.href);
  if (!profile.handle && !profile.avatarUrl) throw new Error("RSI public profile could not be read");
  return profile;
};
const normalizeOrderStatus = (order) => {
  if (order.status === "cancelled") return "cancelled";
  const required = Math.max(Number(order.required_quantity) || 0, 0);
  const delivered = Math.max(Number(order.delivered_quantity) || 0, 0);
  if (required > 0 && delivered >= required) return "completed";
  if (delivered > 0 || order.assigned_to || ["claimed", "reported"].includes(order.status)) return "in_progress";
  return "open";
};

const notifyDiscordBlueprintAdded = async (envelope) => {
  if (!discordWebhookUrl || envelope.event !== "blueprint.owned.added") return;
  const reference = validText(envelope.payload.tag, 300) ? await pool.query("SELECT category FROM reference_blueprints WHERE tag = $1", [envelope.payload.tag]) : { rows: [] };
  const category = envelope.payload.category || envelope.payload.type || reference.rows[0]?.category || "Unbekannt";
  const blueprintName = envelope.payload.product_name || envelope.payload.name || envelope.payload.tag || "Unbenannter Blueprint";
  const userName = envelope.user.handle || envelope.user.id;
  await fetch(discordWebhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `🧾 Neuer Blueprint erhalten\n\n**${userName}** besitzt jetzt:\n**${blueprintName}**\n\nKategorie: **${category}**` }) });
};

const normalizeCategory = (value = "") => {
  const key = value.toLowerCase().replace(/[\s_-]+/g, "");
  const labels = {
    ammo: "Ammo",
    ammunition: "Ammo",
    armour: "Armor",
    armor: "Armor",
    mininglaser: "Mining Laser",
    mining: "Mining Laser",
    powerplant: "Powerplant",
    quantumdrive: "Quantum drive",
    quantum: "Quantum drive",
    radar: "Radar",
    refuelling: "Refuelling",
    refueling: "Refuelling",
    shield: "Shield",
    shieldgenerator: "Shield",
    weapon: "Weapons",
    weapons: "Weapons",
    shipweapon: "Weapons",
    shipweapons: "Weapons"
  };
  return labels[key] || value || "Other";
};

const validateEnvelope = (envelope) => {
  if (!envelope || envelope.schema !== 1) return "unsupported schema";
  if (!validText(envelope.event_id, 128) || !validText(envelope.event, 128)) return "invalid event identity";
  if (!Number.isSafeInteger(envelope.ts)) return "invalid timestamp";
  if (envelope.event !== "inventory.transaction" && !validText(envelope.user?.id, 128)) return "invalid user identity";
  if (!envelope.payload || typeof envelope.payload !== "object") return "invalid payload";
  return null;
};

const syncReferenceData = async () => {
  try {
    const manifest = await fetch("https://scmdb.net/data/latest.json").then((response) => {
      if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
      return response.json();
    });
    const live = manifest?.channels?.live;
    const filename = live?.files?.crafting_blueprints;
    if (!filename) throw new Error("crafting_blueprints file missing from manifest");
    const data = await fetch(`https://scmdb.net/data/${filename}`).then((response) => {
      if (!response.ok) throw new Error(`reference HTTP ${response.status}`);
      return response.json();
    });
    const blueprints = Array.isArray(data?.blueprints) ? data.blueprints : [];
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const blueprint of blueprints) {
        if (!validText(blueprint?.tag, 300)) continue;
        await client.query(
          `INSERT INTO reference_blueprints (tag, product_name, category, subcategory, manufacturer, source_version, materials_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (tag) DO UPDATE SET product_name = EXCLUDED.product_name, category = EXCLUDED.category,
             subcategory = EXCLUDED.subcategory, manufacturer = EXCLUDED.manufacturer,
             source_version = EXCLUDED.source_version, materials_json = EXCLUDED.materials_json, updated_at = now()`,
          [blueprint.tag, blueprint.productName ?? null, normalizeCategory(blueprint.type ?? blueprint.gear ?? blueprint.subtype), blueprint.subtype ?? null, blueprint.manufacturer ?? null, live.version, JSON.stringify(blueprint.ingredients ?? blueprint.materials ?? blueprint.resources ?? [])]
        );
      }
      await client.query("COMMIT");
      console.log(`[reference] synced ${blueprints.length} blueprints from ${live.version}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.warn(`[reference] sync skipped: ${error.message}`);
  }
};

const lookupWikiImage = async (productName, blueprintTag) => {
  if (!validText(productName, 300)) return null;
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrsearch: `\"${productName}\"`,
    gsrlimit: "10",
    prop: "pageimages",
    piprop: "thumbnail",
    pithumbsize: "320",
    redirects: "1"
  });
  const result = await fetch(`https://starcitizen.tools/api.php?${params}`).then((response) => {
    if (!response.ok) throw new Error(`wiki HTTP ${response.status}`);
    return response.json();
  });
  const page = selectWikiCandidate(Object.values(result?.query?.pages ?? {}), { productName, blueprintTag });
  if (!page) return null;
  let imageUrl = page.thumbnail?.source || null;
  if (!imageUrl) {
    const pageParams = new URLSearchParams({ action: "query", format: "json", titles: page.title, prop: "images", imlimit: "50" });
    const pageResult = await fetch(`https://starcitizen.tools/api.php?${pageParams}`).then((response) => {
      if (!response.ok) throw new Error(`wiki image list HTTP ${response.status}`);
      return response.json();
    });
    const exactPage = Object.values(pageResult?.query?.pages ?? {})[0];
    const image = selectWikiImageFile(exactPage?.images, { productName, blueprintTag });
    if (image?.title) {
      const imageParams = new URLSearchParams({ action: "query", format: "json", titles: image.title, prop: "imageinfo", iiprop: "url", iiurlwidth: "320" });
      const imageResult = await fetch(`https://starcitizen.tools/api.php?${imageParams}`).then((response) => {
        if (!response.ok) throw new Error(`wiki image info HTTP ${response.status}`);
        return response.json();
      });
      const imagePage = Object.values(imageResult?.query?.pages ?? {})[0];
      imageUrl = imagePage?.imageinfo?.[0]?.thumburl || imagePage?.imageinfo?.[0]?.url || null;
    }
  }
  return {
    imageUrl: imageUrl || null,
    sourceUrl: `https://starcitizen.tools/${encodeURIComponent(page.title).replace(/%20/g, "_")}`
  };
};

const syncWikiImages = async () => {
  try {
    const candidates = await pool.query(
      `SELECT DISTINCT m.tag, coalesce(r.product_name, m.product_name) AS product_name, r.image_checked_at, r.source_url, r.image_url
       FROM member_blueprints m LEFT JOIN reference_blueprints r ON r.tag = m.tag
       LIMIT 2000`
    );
    for (const candidate of candidates.rows) {
      if (candidate.image_url && !shouldRefreshReference({ checkedAt: candidate.image_checked_at }) && wikiSourceMatchesProduct(candidate.source_url, candidate.product_name)) continue;
      try {
        const match = await lookupWikiImage(candidate.product_name, candidate.tag);
        await pool.query(
          `INSERT INTO reference_blueprints (tag, product_name, image_url, source_url, image_checked_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT (tag) DO UPDATE SET product_name = COALESCE(reference_blueprints.product_name, EXCLUDED.product_name),
             image_url = EXCLUDED.image_url, source_url = EXCLUDED.source_url, image_checked_at = EXCLUDED.image_checked_at, updated_at = now()`,
          [candidate.tag, candidate.product_name, match?.imageUrl ?? null, match?.sourceUrl ?? null]
        );
        console.log(`[images] ${match?.imageUrl ? "matched" : match ? "page found, no image" : "no match"}; tag=${candidate.tag}`);
      } catch (error) {
        console.warn(`[images] lookup skipped; tag=${candidate.tag}; reason=${error.message}`);
      }
    }
  } catch (error) {
    console.warn(`[images] sync skipped: ${error.message}`);
  }
};

const lookupBlueprintIngredients = async (tag, productName) => {
  let match = null;
  const slug = String(productName || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (slug) {
    const slugResponse = await fetch(`https://api.star-citizen.wiki/api/blueprints/${encodeURIComponent(slug)}`);
    if (slugResponse.ok) match = await slugResponse.json();
  }
  const direct = await fetch(`https://api.star-citizen.wiki/api/blueprints/${encodeURIComponent(tag)}`);
  if (direct.ok) match = await direct.json();
  if (!match) {
    const params = new URLSearchParams({ "filter[key]": tag, "page[size]": "10" });
    const response = await fetch(`https://api.star-citizen.wiki/api/blueprints?${params}`);
    if (!response.ok) throw new Error(`blueprint API HTTP ${response.status}`);
    const data = await response.json();
    const rows = Array.isArray(data) ? data : (Array.isArray(data.data) ? data.data : (data.results ?? data.items ?? []));
    match = rows.find((row) => row.tag === tag || row.key === tag || row.output?.tag === tag || row.output?.key === tag || row.output?.id === tag);
  }
  if (!match) {
    const searchResponse = await fetch(`https://api.star-citizen.wiki/api/search/${encodeURIComponent(tag)}`);
    if (searchResponse.ok) {
      const searchData = await searchResponse.json();
      const rawResults = Array.isArray(searchData) ? searchData : (searchData.data ?? searchData.results ?? []);
      const results = [];
      const collect = (value) => { if (Array.isArray(value)) return value.forEach(collect); if (value && typeof value === "object") { results.push(value); Object.values(value).forEach((child) => { if (child && typeof child === "object") collect(child); }); } };
      collect(rawResults);
      const hit = results.find((row) => row.key === tag || row.identifier === tag || row.slug === tag || row.uuid === tag || row.output?.key === tag || row.type === "blueprint");
      const identifier = hit?.uuid ?? hit?.id ?? hit?.key;
      if (identifier) {
        const detail = await fetch(`https://api.star-citizen.wiki/api/blueprints/${encodeURIComponent(identifier)}`);
        if (detail.ok) match = await detail.json();
      }
    }
  }
  if (!match) return [];
  const ingredients = match?.ingredients ?? match?.data?.ingredients ?? match?.output?.ingredients ?? [];
  return Array.isArray(ingredients) ? ingredients.slice(0, 100) : [];
};

let materialsSyncState = { lastSyncAt: null, running: false };
let uexSyncState = { lastSyncAt: null, running: false, locations: 0 };
const normalizeUexLocation = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
const uexLocationFromTerminal = row => {
  const terminalName = String(row.name || row.terminal_name || row.name_terminal || row.displayname || "").trim();
  const name = [row.outpost_name, row.space_station_name, row.city_name, row.moon_name, row.planet_name, row.orbit_name, row.displayname, terminalName]
    .map(value => String(value || "").trim())
    .find(Boolean);
  const starSystem = String(row.star_system_name || row.system_name || "").trim();
  const planetOrMoon = String(row.moon_name || row.planet_name || row.orbit_name || "").trim();
  if (!name) return null;
  const locationId = row.id_outpost || row.id_space_station || row.id_city || row.id_poi || row.id_orbit || normalizeUexLocation(name);
  return {
    name,
    planet_or_moon: planetOrMoon,
    star_system: starSystem,
    type: "UEX location",
    external_id: `uex-location:${row.id_star_system || normalizeUexLocation(starSystem)}:${locationId}`,
    aliases: [terminalName, row.fullname, row.displayname, row.nickname].map(value => String(value || "").trim()).filter(Boolean)
  };
};
const uniqueUexLocations = terminals => {
  const locations = new Map();
  const aliases = new Map();
  for (const terminal of terminals) {
    // UEX marks some valid destinations (for example Sakura Sun Goldenrod
    // Workcenter) as not visible although they remain available in-game.
    if (Number(terminal.is_available ?? 1) === 0) continue;
    const location = uexLocationFromTerminal(terminal);
    if (!location) continue;
    const key = `${normalizeUexLocation(location.name)}|${normalizeUexLocation(location.planet_or_moon)}|${normalizeUexLocation(location.star_system)}`;
    const canonical = locations.get(key) || location;
    locations.set(key, canonical);
    for (const alias of [...canonical.aliases, ...location.aliases, canonical.name]) aliases.set(normalizeUexLocation(alias), canonical);
  }
  return { locations: [...locations.values()], aliases };
};
const syncUexData = async () => {
  if (uexSyncState.running) throw new Error("UEX sync is already running");
  uexSyncState.running = true;
  try {
    const response = await fetch('https://api.uexcorp.uk/2.0/refineries_yields');
    if (!response.ok) throw new Error(`UEX HTTP ${response.status}`);
    const responseText = await response.text();
    let payload;
    try { payload = JSON.parse(responseText); } catch { throw new Error("UEX returned invalid JSON"); }
    const refineryRows = Array.isArray(payload.data) ? payload.data : Array.isArray(payload) ? payload : [];
    for (const row of refineryRows) {
      if (!row.terminal_name) continue;
      await pool.query("INSERT INTO uex_refinery_locations (terminal_name,system_name,planet_name,station_name,is_available_live,updated_at) VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (terminal_name) DO UPDATE SET system_name=EXCLUDED.system_name,planet_name=EXCLUDED.planet_name,station_name=EXCLUDED.station_name,is_available_live=EXCLUDED.is_available_live,updated_at=now()", [row.terminal_name, row.star_system_name || null, row.planet_name || null, row.space_station_name || row.city_name || row.outpost_name || null, row.is_available_live !== 0]);
    }
    if (!uexApiToken) throw new Error("UEX API token is not configured");
    const terminalsResponse = await fetch('https://api.uexcorp.uk/2.0/terminals', { headers: { Authorization: `Bearer ${uexApiToken}`, Accept: 'application/json' } });
    if (!terminalsResponse.ok) throw new Error(`UEX terminals HTTP ${terminalsResponse.status}`);
    const terminalsText = await terminalsResponse.text();
    let terminalsPayload;
    try { terminalsPayload = JSON.parse(terminalsText); } catch { throw new Error("UEX terminals returned invalid JSON"); }
    const terminals = Array.isArray(terminalsPayload.data) ? terminalsPayload.data : [];
    const { locations } = uniqueUexLocations(terminals);
    for (const location of locations) {
      const existing = await pool.query("SELECT id,name,external_id FROM inventory_locations WHERE name=$1 OR external_id=$2", [location.name, location.external_id]);
      const nameMatch = existing.rows.find(row => row.name === location.name);
      const externalIdMatch = existing.rows.find(row => row.external_id === location.external_id);
      const target = nameMatch || externalIdMatch;
      if (target) {
        // Legacy terminal rows can already own the canonical external ID. Keep the
        // name row's existing ID in that case instead of merging/deleting records
        // that may be referenced by personal inventory.
        const externalId = nameMatch && externalIdMatch && nameMatch.id !== externalIdMatch.id
          ? nameMatch.external_id
          : location.external_id;
        await pool.query("UPDATE inventory_locations SET external_id=$1,name=$2,type='UEX location',star_system=$3,active=true,updated_at=now() WHERE id=$4", [externalId, location.name, location.star_system || null, target.id]);
      } else {
        await pool.query("INSERT INTO inventory_locations (external_id,name,type,star_system,active,updated_at) VALUES ($1,$2,'UEX location',$3,true,now())", [location.external_id, location.name, location.star_system || null]);
      }
    }
    uexLocationCache = { expiresAt: Date.now() + 1800000, rows: [] };
    await pool.query("INSERT INTO uex_sync_state (id,last_sync_at) VALUES (true,now()) ON CONFLICT (id) DO UPDATE SET last_sync_at=now()");
    uexSyncState = { lastSyncAt: new Date().toISOString(), running: false, locations: locations.length };
    return uexSyncState;
  } catch (error) {
    uexSyncState = { ...uexSyncState, running: false };
    throw error;
  }
};
const syncWikiMaterials = async () => {
  materialsSyncState.running = true;
  try {
    const candidates = await pool.query(`SELECT DISTINCT m.tag, COALESCE(r.product_name, m.product_name) AS product_name FROM member_blueprints m LEFT JOIN reference_blueprints r ON r.tag = m.tag LIMIT 2000`);
    console.log(`[materials] sync started; candidates=${candidates.rows.length}`);
    for (const candidate of candidates.rows) {
      try {
        const materials = await lookupBlueprintIngredients(candidate.tag, candidate.product_name);
        if (materials.length) {
          await pool.query("UPDATE reference_blueprints SET materials_json = $1, updated_at = now() WHERE tag = $2", [JSON.stringify(materials), candidate.tag]);
        }
        console.log(`[materials] ${materials.length ? "matched" : "no match"}; tag=${candidate.tag}`);
      } catch (error) { console.warn(`[materials] lookup skipped; tag=${candidate.tag}; reason=${error.message}`); }
    }
  } catch (error) { console.warn(`[materials] sync skipped: ${error.message}`); }
  finally { materialsSyncState = { lastSyncAt: new Date().toISOString(), running: false }; }
};
const notifyDiscordOrderCreated = async ({ order, groupName, creatorName, creatorProfilePath }) => {
  const normalizedGroupName = String(groupName || "").trim().toLowerCase();
  const webhookUrl = discordOrdersWebhooks.get(normalizedGroupName);
  if (!webhookUrl) { logger.debug("discord.order_notification.skipped", { group: normalizedGroupName || "unknown" }); return; }
  const creator = creatorProfilePath ? `[${creatorName}](${verseLinkAppUrl}${creatorProfilePath})` : creatorName;
  const orderUrl = `${verseLinkAppUrl}/mobiglass?group_id=${encodeURIComponent(order.group_id)}&order_id=${encodeURIComponent(order.id)}#orders`;
  try {
    const response = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(8000), body: JSON.stringify({ embeds: [{ title: `📦 Neue Order ${order.order_number}`, description: `**${order.material_name}** · **${order.required_quantity} ${order.quantity_unit}**\nQuality: **${order.required_quality || "Any quality"}**\nErstellt von: **${creator}**`, color: 0x29b6f6, fields: [{ name: "Gruppe", value: groupName || "Unbekannte Gruppe", inline: true }, { name: "Order öffnen", value: `[${order.order_number} in VerseLink öffnen](${orderUrl})`, inline: true }], footer: { text: "VerseLink · Material Orders" } }] }) });
    if (!response.ok) logger.warn("discord.order_notification.failed", { status: response.status });
    else logger.info("discord.order_notification.sent", { order_id: order.id, group: normalizedGroupName });
  } catch (error) { logger.warn("discord.order_notification.failed", { error: error.message }); }
};

const parseCookies = (header = "") => Object.fromEntries(header.split(";").map((part) => {
  const [key, ...value] = part.trim().split("=");
  return [key, decodeURIComponent(value.join("="))];
}).filter(([key]) => key));

const getSessionContext = async (req) => {
  const session = parseCookies(req.headers.cookie).bp_session;
  if (!session || !/^[A-Za-z0-9_-]{32,}$/.test(session)) return null;
  const result = await pool.query(
    `SELECT ds.app_user_id
     FROM dashboard_sessions ds
     JOIN app_users u ON u.id = ds.app_user_id
     WHERE ds.session_hash = $1 AND ds.expires_at > now()
       AND u.account_status = 'active'`,
    [hashSession(session)]
  );
  const row = result.rows[0];
  return row ? { appUserId: row.app_user_id } : null;
};

const getCurrentAppUser = async (req) => {
  const context = await getSessionContext(req);
  if (!context?.appUserId) return null;
  const result = await pool.query(`SELECT u.id, COALESCE(u.verselink_name, u.display_name) AS display_name, u.display_name AS scmdb_display_name, u.verselink_name, u.is_admin, u.account_status, c.user_handle, p.display_name AS profile_display_name FROM app_users u LEFT JOIN LATERAL (SELECT token_hash, user_handle FROM scmdb_connections WHERE app_user_id = u.id AND revoked_at IS NULL AND connection_status IN ('connected', 'pending') ORDER BY CASE connection_status WHEN 'connected' THEN 0 ELSE 1 END, last_seen_at DESC NULLS LAST LIMIT 1) c ON true LEFT JOIN scmdb_profiles p ON p.token_hash = c.token_hash WHERE u.id = $1`, [context.appUserId]);
  const user = result.rows[0];
  if (!user) return null;
  const syncedName = user.profile_display_name || user.user_handle;
  if (syncedName && syncedName !== "SCMDB user" && syncedName !== user.scmdb_display_name) {
    await pool.query("UPDATE app_users SET display_name=$1 WHERE id=$2", [syncedName, user.id]);
    user.scmdb_display_name = syncedName;
    if (!user.verselink_name) user.display_name = syncedName;
  }
  return user;
};

const getConnectedServiceUser = async (client, tokenHash) => {
  const connection = await client.query(
    "SELECT c.app_user_id, c.user_handle, p.display_name AS profile_display_name FROM scmdb_connections c LEFT JOIN scmdb_profiles p ON p.token_hash = c.token_hash WHERE c.token_hash = $1 AND c.app_user_id IS NOT NULL AND c.connection_status IN ('pending', 'connected') AND c.revoked_at IS NULL FOR UPDATE OF c",
    [tokenHash]
  );
  if (!connection.rowCount) throw new Error("sink not registered");
  const profileName = connection.rows[0].profile_display_name || connection.rows[0].user_handle;
  if (profileName && profileName !== "SCMDB user") await client.query("UPDATE app_users SET display_name=$1 WHERE id=$2", [profileName, connection.rows[0].app_user_id]);
  return connection.rows[0].app_user_id;
};

const createDashboardSession = async (client, appUserId) => {
  const session = randomBytes(32).toString("hex");
  await client.query(
    `INSERT INTO dashboard_sessions (session_hash, app_user_id, expires_at)
     VALUES ($1, $2, now() + interval '30 days')`,
    [hashSession(session), appUserId]
  );
  return session;
};

const accessibleBlueprintQuery = `
  SELECT m.tag, coalesce(r.product_name, min(m.product_name)) AS product_name,
         CASE WHEN lower(coalesce(r.category, 'Other')) = 'armour' THEN 'Armor' ELSE coalesce(r.category, 'Other') END AS category, r.subcategory, r.manufacturer,
         r.image_url, r.source_url, r.materials_json, max(m.owned_at) AS owned_at,
         (max(m.first_seen_at) >= CASE WHEN max(m.first_seen_at) > 100000000000
            THEN floor(extract(epoch FROM now() - interval '24 hours') * 1000)
            ELSE floor(extract(epoch FROM now() - interval '24 hours')) END) AS is_new,
         (max(m.first_seen_at) >= CASE WHEN max(m.first_seen_at) > 100000000000
            THEN floor(extract(epoch FROM now() - interval '7 days') * 1000)
            ELSE floor(extract(epoch FROM now() - interval '7 days')) END) AS is_week,
         string_agg(DISTINCT coalesce(owner_user.verselink_name, owner_user.display_name, p.display_name, p.rsi_handle, c.user_handle, 'SCMDB user'), E'\\n') AS owner_name,
         jsonb_agg(DISTINCT jsonb_build_object('name', coalesce(owner_user.verselink_name, owner_user.display_name, p.display_name, p.rsi_handle, c.user_handle, 'SCMDB user'), 'profile_path', CASE WHEN owner_user.profile_public THEN '/profile/' || owner_user.id::text ELSE null END)) AS owner_profiles,
         array_agg(DISTINCT owner_user.id::text) AS owner_ids
  FROM member_blueprints m
  JOIN scmdb_connections c ON c.token_hash = m.token_hash
  JOIN app_users owner_user ON owner_user.id = c.app_user_id AND owner_user.account_status = 'active'
  LEFT JOIN reference_blueprints r ON r.tag = m.tag
  LEFT JOIN scmdb_profiles p ON p.token_hash = m.token_hash
  WHERE c.connection_status = 'connected'
    AND c.revoked_at IS NULL
    AND EXISTS (
      SELECT 1 FROM group_members owner_membership
      JOIN group_members viewer_membership ON viewer_membership.group_id = owner_membership.group_id
      WHERE owner_membership.app_user_id = c.app_user_id
        AND viewer_membership.app_user_id = $1
    )
  GROUP BY m.tag, r.product_name, r.category, r.subcategory, r.manufacturer, r.image_url, r.source_url, r.materials_json
  ORDER BY lower(coalesce(r.product_name, min(m.product_name), m.tag)), m.tag`;

const publicBlueprintQuery = `
  SELECT m.tag, coalesce(r.product_name, min(m.product_name)) AS name,
         CASE WHEN lower(coalesce(r.category, 'Other')) = 'armour' THEN 'Armor' ELSE coalesce(r.category, 'Other') END AS category,
         r.subcategory, r.manufacturer, r.image_url
  FROM member_blueprints m
  JOIN scmdb_connections c ON c.token_hash = m.token_hash
  JOIN app_users u ON u.id = c.app_user_id AND u.account_status = 'active'
  JOIN group_members gm ON gm.group_id = $1 AND gm.app_user_id = c.app_user_id
  LEFT JOIN reference_blueprints r ON r.tag = m.tag
  WHERE ($4::text IS NULL OR coalesce(r.product_name, m.product_name, m.tag) ILIKE $4 ESCAPE '\\')
    AND ($5::text IS NULL OR lower(coalesce(r.category, 'Other')) = lower($5))
    AND ($6::text IS NULL OR coalesce(r.subcategory, '') ILIKE '%' || $6 || '%')
    AND ($7::text IS NULL OR coalesce(r.manufacturer, '') ILIKE '%' || $7 || '%')
  GROUP BY m.tag, r.product_name, r.category, r.subcategory, r.manufacturer, r.image_url
  ORDER BY lower(coalesce(r.product_name, min(m.product_name), m.tag)), m.tag
  LIMIT $2 OFFSET $3`;

const htmlEscape = (value = "") => String(value).replace(/[&<>\"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"
}[char]));

const logValue = (value) => String(value ?? "unknown").replace(/[\r\n\t]/g, " ").slice(0, 200);
const requestLogContext = (req, user) => ({ request_id: req.requestId, user_id: user?.id, user: user?.verselink_name || user?.display_name });
const pollingPaths = new Set(["/api/notifications", "/api/session", "/api/me", "/api/me/status"]);
const logApiRequest = (req, res, url, startedAt) => {
  if (!url.pathname.startsWith("/api/")) return;
  res.once("finish", () => {
    getCurrentAppUser(req).then((user) => {
      const identity = user?.user_handle || user?.scmdb_display_name || user?.display_name || "anonymous";
      const duration = Date.now() - startedAt;
      const level = res.statusCode >= 500 || duration > 1000 ? "WARN" : res.statusCode >= 400 ? "WARN" : pollingPaths.has(url.pathname) ? "DEBUG" : "INFO";
      const entry = { request_id: req.requestId, user_id: user?.id, user: logValue(identity), method: req.method, path: logValue(url.pathname), status: res.statusCode, duration_ms: duration, ...(duration > 3000 ? { slow_request: true } : {}) };
      logger.access(entry, level);
    }).catch((error) => {
      logger.warn("http.request_log.failed", { method: req.method, path: logValue(url.pathname), error: error.message }, { request_id: req.requestId });
    });
  });
};

const materialHtml = (material) => {
  const name = material?.name ?? material?.label ?? material?.item ?? "Material";
  const quantity = material?.quantity_scu != null ? ` · ${htmlEscape(material.quantity_scu)} SCU` : (material?.quantity != null ? ` · ${htmlEscape(material.quantity)} qty` : "");
  return `<br>• <a href="https://scmdb.net/?page=mine&r=${encodeURIComponent(name)}" target="_blank" rel="noreferrer">${htmlEscape(name)}</a>${quantity}`;
};

const categoryIcon = (category = "") => {
  const value = category.toLowerCase();
  if (value.includes("quantum")) return "✦";
  if (value.includes("armor") || value.includes("armour")) return "⬢";
  if (value.includes("weapon")) return "⌁";
  if (value.includes("mining")) return "◈";
  if (value.includes("medical")) return "＋";
  if (value.includes("vehicle") || value.includes("ship")) return "◇";
  return "◆";
};

const categoryMedia = (category = "") => {
  const value = category.toLowerCase();
  if (value.includes("quantum")) return {
    image: "https://media.starcitizen.tools/thumb/b/b2/VK-00_QD_in-game_cutout_-_Mesh_BG_SCT_logo.jpg/320px-VK-00_QD_in-game_cutout_-_Mesh_BG_SCT_logo.jpg.webp",
    source: "https://starcitizen.tools/VK-00"
  };
  if (value.includes("weapon")) return {
    image: "https://media.starcitizen.tools/thumb/d/dd/MonthlyReport-1605-Co-Bucc3.jpg/320px-MonthlyReport-1605-Co-Bucc3.jpg.webp",
    source: "https://starcitizen.tools/Ship_weapons"
  };
  return null;
};

let dashboardHtml = (blueprints) => {
  blueprints = blueprints.map((bp) => { const materials = Array.isArray(bp.materials_json) ? bp.materials_json : []; const materialText = materials.length ? `\n\nBenötigte Materialien:\n${materials.map((m) => `• ${m.name ?? m.label ?? m.item ?? "Material"}${m.quantity != null ? ` × ${m.quantity}` : ""}`).join("\n")}` : ""; return { ...bp, product_name: `${bp.product_name || "Unbenannter Blueprint"}${bp.owner_name ? `\n\nBesitzer:\n${bp.owner_name.split("\n").map((name) => `• ${name}`).join("\n")}` : ""}` }; });
  const categories = [...new Set(blueprints.map((bp) => bp.category || "Other"))].sort((a, b) => a.localeCompare(b));
  const latest = blueprints.filter((bp) => bp.is_new);
  const tickerItems = latest.map((bp) => { const media = bp.image_url ? { image: bp.image_url, source: bp.source_url } : categoryMedia(bp.category); const name = String(bp.product_name || "Unbenannter Blueprint").split("\n\nBesitzer:")[0]; return `<a class="ticker-item" href="https://scmdb.net/?page=fab&fab=${encodeURIComponent(bp.tag)}" title="${htmlEscape(name)}"><img src="${htmlEscape(media?.image || "/favicon.png")}" alt=""><span>${htmlEscape(name)}</span></a>`; }).join("");
  const tickerMarkup = latest.length ? `<section class="news-ticker" aria-label="In den letzten 24 Stunden hinzugefügte Blueprints"><strong>Neu (24h)</strong><div class="ticker-window"><div class="ticker-track">${tickerItems}</div></div></section>` : "";
  const tickerScript = latest.length ? `<script>(()=>{const viewport=document.querySelector('.ticker-window'),track=document.querySelector('.ticker-track');if(!viewport||!track)return;let x=0,last=performance.now(),paused=false,waitUntil=0;const speed=42;const frame=(now)=>{const distance=Math.max(0,track.scrollWidth-viewport.clientWidth);if(!paused){const dt=Math.min(100,now-last);last=now;if(waitUntil){if(now>=waitUntil){x=0;waitUntil=0}else{x=distance}}else if(distance>0){x+=speed*dt/1000;if(x>=distance){x=distance;waitUntil=now+2000}}track.style.transform='translate3d('+(-x)+'px,0,0)'}requestAnimationFrame(frame)};viewport.addEventListener('mouseenter',()=>{paused=true});viewport.addEventListener('mouseleave',()=>{paused=false;last=performance.now()});requestAnimationFrame(frame)})()</script>` : "";
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Blueprint Inventory</title><style>.name{white-space:pre-line;margin-top:10px}.materials{margin-top:24px;margin-bottom:22px;line-height:1.45}.materials a{display:inline-block;margin-bottom:8px}.news-ticker{display:flex;align-items:center;gap:14px;overflow:hidden;margin:0 0 20px;padding:10px 12px;border:1px solid #33454d;border-radius:12px;background:#151d22}.news-ticker strong{flex:0 0 auto;color:#8df0b8;font-size:.85rem}.ticker-window{position:relative;flex:1 1 auto;width:100%;min-width:0;height:36px;overflow:hidden}.ticker-track{display:flex;align-items:center;gap:28px;width:max-content;height:36px;will-change:transform}.ticker-item{display:flex;flex:0 0 auto;align-items:center;gap:8px;color:#eef4f7;text-decoration:none;white-space:nowrap}.ticker-item:hover{text-decoration:underline}.ticker-item img{width:30px;height:30px;object-fit:cover;border-radius:7px;background:#11181c}
</style>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#101317;color:#eef4f7}body{margin:0;background:radial-gradient(circle at top right,#173e4a 0,#101317 45%);min-height:100vh}main{width:min(1180px,calc(100% - 40px));margin:auto;padding:42px 0}.top{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}.greeting{color:#b7c7cd;font-size:1rem;margin-bottom:4px}.dashboard-nav{display:flex;align-items:flex-start;justify-content:flex-end;align-self:flex-start;flex-wrap:wrap;gap:10px}.dashboard-nav-link,.dashboard-nav form{flex:0 0 auto;margin:0}.dashboard-nav-link,.dashboard-nav .logout{box-sizing:border-box;min-height:46px;padding:10px 14px;font-size:1rem;line-height:1.2}.groups-button{display:inline-block;text-decoration:none;font:inherit;border-radius:10px;border:1px solid #1e8cae;padding:12px 14px;background:#16495a;color:#eef4f7}.dashboard-nav .logout{background:transparent;color:#9baeb6;border-color:#33454d}.brand{display:flex;align-items:center;gap:16px}.brand-icon{display:block;width:76px;height:76px;object-fit:contain;flex:0 0 76px}.eyebrow{color:#5ed9ff;letter-spacing:.14em;text-transform:uppercase;font-size:.75rem}h1{font-size:clamp(2rem,5vw,4rem);margin:12px 0 28px}.panel{border:1px solid #26343b;border-radius:18px;background:rgba(24,30,35,.86);padding:22px;box-shadow:0 18px 70px #0004}.toolbar{display:grid;grid-template-columns:1fr minmax(180px,240px) auto;gap:12px;margin-bottom:20px}input,select,button{font:inherit;border-radius:10px;border:1px solid #33454d;padding:12px 14px;background:#151d22;color:#eef4f7}button{cursor:pointer;background:#16495a;border-color:#1e8cae}button:hover{background:#1c6277}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}.card{border:1px solid #2b3a40;border-radius:14px;padding:16px;background:#1a2227}.media{display:block;margin:-16px -16px 14px}.media img{display:block;width:100%;height:130px;object-fit:cover;border-radius:14px 14px 0 0;background:#11181c}.tag{font:12px ui-monospace,monospace;color:#72d9f6;word-break:break-all}.name{font-size:1.1rem;margin-top:10px;white-space:pre-line}.materials{margin-top:18px;line-height:1.45}.materials a{display:inline-block;margin-bottom:6px}.category{display:flex;align-items:center;gap:8px;color:#a9dcec;font-size:.9rem}.category-icon{display:grid;place-items:center;width:28px;height:28px;border-radius:9px;background:#153d4b;color:#5ed9ff;font-size:1.1rem}.muted{color:#9baeb6;font-size:.9rem}.count{color:#8df0b8}.logout{background:transparent;color:#9baeb6;border-color:#33454d}.attribution{margin-top:18px;color:#71858d;font-size:.75rem}.attribution a{color:#72d9f6}
</style></head><body><main><div class="top"><div class="brand"><img class="brand-icon" src="/assets/apps/inventory.png" alt="Blueprint Inventory"><div><div class="greeting" id="greeting">Hello</div><div class="eyebrow">Blueprint inventory, <a href="https://scmdb.net/" target="_blank" rel="noreferrer">feeded by SCMDB</a></div><h1>Your groups blueprints.</h1></div></div><div class="top-actions"><a class="groups-button" href="/groups">Groups</a><form method="post" action="/logout"><button class="logout">Abmelden</button></form></div></div>${tickerMarkup}${tickerScript}<section class="panel"><div class="muted"><span class="count">● Synchronisiert</span> · ${blueprints.length} Blueprints</div><div class="toolbar"><input id="search" placeholder="Nach Name oder Tag suchen …" autocomplete="off"><select id="category"><option value="">Alle Kategorien</option><option value="__new__">Neu hinzugefügt (24h)</option><option value="__week__">Letzte 7 Tage</option>${categories.map((category) => `<option value="${htmlEscape(category)}">${htmlEscape(category)}</option>`).join("")}</select><button type="button" id="clear">Filter zurücksetzen</button></div><div class="grid" id="grid">${blueprints.map((bp) => { const media = bp.image_url ? { image: bp.image_url, source: bp.source_url } : categoryMedia(bp.category); return `<article class="card" data-category="${htmlEscape(bp.category || "Other")}" data-new="${bp.is_new ? "1" : "0"}" data-week="${bp.is_week ? "1" : "0"}" data-search="${htmlEscape(`${bp.product_name ?? ""} ${bp.tag}`.toLowerCase())}">${media ? `<a class="media" href="${media.source}" target="_blank" rel="noreferrer" title="Bildquelle öffnen"><img src="${media.image}" loading="lazy" referrerpolicy="no-referrer" alt="${htmlEscape(bp.product_name || bp.category || "Blueprint-Bild")}"></a>` : ""}<div class="tag">${htmlEscape(bp.tag)}</div><div class="name">${htmlEscape(bp.product_name || "Unbenannter Blueprint")}${Array.isArray(bp.materials_json) && bp.materials_json.length ? `<div class="materials"><a href="https://scmdb.net/?page=fab&fab=${encodeURIComponent(bp.tag)}" target="_blank" rel="noreferrer">Benötigte Materialien:</a>${bp.materials_json.map(materialHtml).join("")}</div>` : ""}</div><div class="category"><span class="category-icon" aria-hidden="true">${categoryIcon(bp.category)}</span><span>${htmlEscape(bp.category || "Other")}${bp.subcategory ? ` · ${htmlEscape(bp.subcategory)}` : ""}${bp.manufacturer ? ` · ${htmlEscape(bp.manufacturer)}` : ""}</span></div></article>`; }).join("") || `<div class="muted">Noch keine Blueprints empfangen. In SCMDB einen Resync auslösen.</div>`}</div><div class="attribution">Blueprint images are matched via <a href="https://starcitizen.tools/" target="_blank" rel="noreferrer">Star Citizen Wiki</a> and loaded externally; this application does not store image files.</div></section></main><script>const input=document.querySelector('#search'),category=document.querySelector('#category'),cards=[...document.querySelectorAll('.card')];function filter(){const q=input.value.toLowerCase().trim(),c=category.value;cards.forEach(card=>card.hidden=(q&&!card.dataset.search.includes(q))||(c==='__new__'&&card.dataset.new!=='1')||(c==='__week__'&&card.dataset.week!=='1')||(c&&c!=='__new__'&&c!=='__week__'&&card.dataset.category!==c))}input.addEventListener('input',filter);category.addEventListener('change',filter);document.querySelector('#clear').onclick=()=>{input.value='';category.value='';filter()};</script></body></html>`;
}
const baseDashboardHtml = dashboardHtml;
dashboardHtml = (blueprints) => baseDashboardHtml(blueprints).replace('<div class="top-actions"><a class="groups-button" href="/groups">Groups</a><form method="post" action="/logout"><button class="logout">Abmelden</button></form></div>', '<nav class="dashboard-nav" aria-label="Hauptnavigation"><a class="groups-button dashboard-nav-link" href="/groups">Groups</a><a class="groups-button dashboard-nav-link" href="/orders">Aufträge</a><a class="groups-button dashboard-nav-link" href="/trading">TradeMax</a><form method="post" action="/logout"><button class="logout dashboard-nav-link">Abmelden</button></form></nav>').replace('h1{font-size:clamp(2rem,5vw,4rem)', 'h1{font-size:clamp(1.7rem,4vw,3.2rem)');

const groupsHtml = () => `<!doctype html><html lang="de"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gruppen · Blueprint Inventory</title><style>:root{color-scheme:dark;font-family:system-ui;background:#101317;color:#eef4f7}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at top right,#173e4a,#101317 45%)}main{width:min(620px,calc(100% - 40px));padding:30px;border:1px solid #26343b;border-radius:18px;background:#181e23}h1{margin-top:0}p,small{color:#aebdc4;line-height:1.5}.panel{margin-top:18px;padding:18px;border:1px solid #33454d;border-radius:12px}input,button{box-sizing:border-box;width:100%;font:inherit;padding:12px;margin-top:10px;border-radius:9px;border:1px solid #33454d;background:#11181c;color:#eef4f7}button{cursor:pointer;background:#16495a;border-color:#1e8cae}.code{word-break:break-all;color:#72d9f6}.back{color:#72d9f6}</style><main><a class="back" href="/">← Inventar</a><h1>Deine Crew</h1><p>Erstelle einen einmal gültigen Einladungscode für einen Freund. Der Code läuft nach sieben Tagen ab.</p><section class="panel"><h2>Freund einladen</h2><button id="create">Einladungscode erstellen</button><p id="created" class="code"></p></section><section class="panel"><h2>Einladung beitreten</h2><p>Der Freund muss sich zuerst mit seinem eigenen SCMDB-Sink-Token anmelden und dann hier den erhaltenen Code einfügen.</p><form id="join"><input name="invite" placeholder="Einladungscode" required autocomplete="off"><button>Gruppe beitreten</button></form><p id="joined"></p></section><form method="post" action="/logout"><button>Abmelden</button></form></main><script>const out=document.querySelector('#created');document.querySelector('#create').onclick=async()=>{const r=await fetch('/api/invites',{method:'POST'}),d=await r.json();out.textContent=d.invite?'Code: '+d.invite:(d.error||'Fehler')};document.querySelector('#join').onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/invites/join',{method:'POST',body:new URLSearchParams(new FormData(e.target))}),d=await r.json();document.querySelector('#joined').textContent=d.ok?'Du bist der Gruppe beigetreten.':(d.error||'Fehler')};</script></html>`;

const applyBlueprintEvent = async (client, tokenHash, envelope) => {
  const { event, payload, ts } = envelope;
  if (event === "inventory.transaction") {
    const userId = await getConnectedServiceUser(client, tokenHash);
    const itemClass = String(payload.item_class || "").trim();
    const direction = String(payload.direction || "").trim().toUpperCase();
    const stationKey = String(payload.station_key || "").trim();
    const stationName = String(payload.station_name || stationKey || "Unbekannter Standort").trim();
    const quantity = Number(payload.quantity ?? 1);
    const category = String(payload.category || "Other").trim();
    if (!/^[A-Za-z0-9_.-]{1,300}$/.test(itemClass) || !["TO_BACKPACK", "TO_STATION"].includes(direction) || !stationKey || stationKey.length > 200 || !Number.isInteger(quantity) || quantity < 1 || quantity > 1000000) throw new Error("invalid inventory transaction");
    if (!["Weapons", "Armor"].includes(category)) throw new Error("inventory category not tracked");
    await client.query("INSERT INTO inventory_locations (external_id,name,type,star_system) VALUES ($1,$2,'station',$3) ON CONFLICT (external_id) DO UPDATE SET name=EXCLUDED.name, updated_at=now()", [stationKey, stationName, String(payload.star_system || "") || null]);
    await client.query("INSERT INTO item_catalog (external_id,name,category,source) VALUES ($1,$1,$2,'game-log') ON CONFLICT (external_id) DO UPDATE SET category=EXCLUDED.category, updated_at=now()", [itemClass, category]);
    const catalogItem = await client.query("SELECT id FROM item_catalog WHERE external_id=$1", [itemClass]);
    const location = await client.query("SELECT id FROM inventory_locations WHERE external_id=$1", [stationKey]);
    const backpackDelta = direction === "TO_BACKPACK" ? quantity : -quantity;
    const stationDelta = direction === "TO_BACKPACK" ? -quantity : quantity;
    if (direction === "TO_BACKPACK") {
      await client.query(`INSERT INTO user_inventory (user_id,item_id,location_id,quantity) VALUES ($1,$2,$3,$4)
        ON CONFLICT (user_id,item_id,location_id) DO UPDATE SET quantity=user_inventory.quantity+EXCLUDED.quantity, updated_at=now()`, [userId,catalogItem.rows[0].id,location.rows[0].id,quantity]);
    } else {
      await client.query("DELETE FROM user_inventory WHERE user_id=$1 AND item_id=$2 AND location_id=$3 AND quantity <= $4", [userId,catalogItem.rows[0].id,location.rows[0].id,quantity]);
      await client.query("UPDATE user_inventory SET quantity=quantity-$4, updated_at=now() WHERE user_id=$1 AND item_id=$2 AND location_id=$3", [userId,catalogItem.rows[0].id,location.rows[0].id,quantity]);
    }
    for (const [storageType, delta] of [["BACKPACK", backpackDelta], ["STATION", stationDelta]]) {
      await client.query(`INSERT INTO inventory_sync_state (user_id,item_external_id,item_name,category,location_external_id,location_name,storage_type,quantity)
        VALUES ($1,$2,$2,$3,$4,$5,$6,GREATEST($7,0)) ON CONFLICT (user_id,item_external_id,location_external_id,storage_type)
        DO UPDATE SET quantity=GREATEST(inventory_sync_state.quantity + $7,0), updated_at=now()`, [userId,itemClass,category,stationKey,stationName,storageType,delta]);
    }
    await client.query("INSERT INTO inventory_transactions (event_id,user_id,item_external_id,direction,quantity,location_external_id,location_name,game_channel) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [envelope.event_id,userId,itemClass,direction,quantity,stationKey,stationName,String(payload.game_channel || "") || null]);
    return;
  }
  if (event === "profile.snapshot" || event === "profile.updated") {
    const profile = payload.profile && typeof payload.profile === "object" ? payload.profile : payload;
    const displayName = validText(profile.display_name, 200) ? profile.display_name : (validText(profile.displayName, 200) ? profile.displayName : null);
    const rsiHandle = validText(profile.rsi_handle, 200) ? profile.rsi_handle : (validText(profile.rsiHandle, 200) ? profile.rsiHandle : null);
    const organizations = Array.isArray(profile.organizations) ? profile.organizations.slice(0, 100) : null;
    await client.query(
      `INSERT INTO scmdb_profiles (token_hash, scmdb_user_id, display_name, rsi_handle, organizations)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token_hash) DO UPDATE SET scmdb_user_id = EXCLUDED.scmdb_user_id,
         display_name = COALESCE(EXCLUDED.display_name, scmdb_profiles.display_name),
         rsi_handle = COALESCE(EXCLUDED.rsi_handle, scmdb_profiles.rsi_handle),
         organizations = COALESCE(EXCLUDED.organizations, scmdb_profiles.organizations), updated_at = now()`,
      [tokenHash, envelope.user.id, displayName, rsiHandle, organizations ? JSON.stringify(organizations) : null]
    );
    const syncedName = displayName || rsiHandle || (validText(envelope.user.handle, 200) ? envelope.user.handle : null);
    if (syncedName) {
      const appUser = await client.query("SELECT app_user_id FROM scmdb_connections WHERE token_hash=$1", [tokenHash]);
      if (appUser.rows[0]?.app_user_id) {
        await client.query("UPDATE app_users SET display_name=$1 WHERE id=$2", [syncedName, appUser.rows[0].app_user_id]);
        await client.query("UPDATE blueprint_groups SET name=$1 WHERE created_by=$2 AND name='SCMDB user''s crew'", [`${syncedName}'s crew`, appUser.rows[0].app_user_id]);
      }
    }
    return;
  }
  if (event === "blueprint.snapshot") {
    if (!Array.isArray(payload.owned) || payload.owned.length > 10000) throw new Error("invalid blueprint snapshot");
    const blueprintTags = payload.owned.filter((blueprint) => validText(blueprint?.tag, 300)).map((blueprint) => blueprint.tag);
    for (const blueprint of payload.owned) {
      if (!validText(blueprint?.tag, 300)) continue;
      await client.query(
        `INSERT INTO member_blueprints (token_hash, tag, product_name, owned_at, first_seen_at)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (token_hash, tag) DO UPDATE SET product_name = EXCLUDED.product_name, owned_at = EXCLUDED.owned_at`,
        [tokenHash, blueprint.tag, validText(blueprint.product_name, 500) ? blueprint.product_name : null, ts]
      );
    }
    await client.query("DELETE FROM member_blueprints WHERE token_hash = $1 AND NOT (tag = ANY($2::text[]))", [tokenHash, blueprintTags]);
    return;
  }
  if (event === "blueprint.owned.added") {
    if (!validText(payload.tag, 300)) throw new Error("invalid blueprint tag");
    await client.query(
      `INSERT INTO member_blueprints (token_hash, tag, product_name, owned_at, first_seen_at)
       VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (token_hash, tag) DO UPDATE SET product_name = EXCLUDED.product_name, owned_at = EXCLUDED.owned_at`,
      [tokenHash, payload.tag, validText(payload.product_name, 500) ? payload.product_name : null, ts]
    );
    return;
  }
  if (event === "blueprint.owned.removed") {
    if (!validText(payload.tag, 300)) throw new Error("invalid blueprint tag");
    await client.query("DELETE FROM member_blueprints WHERE token_hash = $1 AND tag = $2", [tokenHash, payload.tag]);
  }
};

const ensureSchema = async () => {
  await pool.query(schemaSql);
  await pool.query(
    `UPDATE app_users
     SET is_admin = (account_status = 'active' AND id::text = ANY($1::text[]))
     WHERE is_admin IS DISTINCT FROM (account_status = 'active' AND id::text = ANY($1::text[]))`,
    [[...configuredAdminUserIds]]
  );
};

const serveHome = async (res) => {
  const html = await readFile(join(publicDir, "index.html"));
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
};

const refreshReferenceBlueprint = async (blueprintId) => {
  const existing = await pool.query(
    `SELECT m.tag, COALESCE(r.product_name, m.product_name) AS product_name,
            r.source_url, r.image_url
     FROM (SELECT DISTINCT tag, product_name FROM member_blueprints WHERE tag = $1) m
     LEFT JOIN reference_blueprints r ON r.tag = m.tag`,
    [blueprintId]
  );
  if (!existing.rowCount) return null;
  const row = existing.rows[0];
  const match = await lookupWikiImage(row.product_name, row.tag);
  const refreshedAt = new Date();
  const updated = await pool.query(
    `INSERT INTO reference_blueprints (tag, product_name, image_url, source_url, image_checked_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (tag) DO UPDATE SET product_name = COALESCE(EXCLUDED.product_name, reference_blueprints.product_name),
       image_url = EXCLUDED.image_url, source_url = EXCLUDED.source_url,
       image_checked_at = EXCLUDED.image_checked_at, updated_at = EXCLUDED.updated_at
     RETURNING image_url, source_url, image_checked_at`,
    [row.tag, row.product_name, match?.imageUrl ?? null, match?.sourceUrl ?? null, refreshedAt]
  );
  return { tag: row.tag, previous: row, current: updated.rows[0], matched: Boolean(match) };
};

const tradingNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
};
const tradingField = (row, ...names) => names.map((name) => row?.[name]).find((value) => value !== undefined && value !== null);
const normalizeUexRows = (payload, terminalsPayload) => {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  const terminals = new Map((Array.isArray(terminalsPayload?.data) ? terminalsPayload.data : []).map((terminal) => [String(terminal.id), terminal]));
  return data.map((row) => ({
    commodityId: tradingField(row, "id_commodity", "commodity_id"),
    commodity: tradingField(row, "commodity_name", "name_commodity", "commodity") || "Unknown commodity",
    buyPrice: tradingNumber(tradingField(row, "price_buy", "buy_price")),
    sellPrice: tradingNumber(tradingField(row, "price_sell", "sell_price")),
    buyStock: tradingNumber(tradingField(row, "scu_buy", "buy_stock", "stock_buy")),
    sellDemand: tradingNumber(tradingField(row, "scu_sell", "sell_demand", "demand_sell")),
    terminalId: tradingField(row, "id_terminal", "terminal_id"),
    terminal: tradingField(row, "terminal_name", "name_terminal", "terminal") || "Unknown terminal",
    systemId: tradingField(row, "id_star_system", "star_system_id") ?? terminals.get(String(tradingField(row, "id_terminal", "terminal_id")))?.id_star_system,
    system: tradingField(row, "star_system_name", "name_star_system", "star_system") || terminals.get(String(tradingField(row, "id_terminal", "terminal_id")))?.star_system_name || "",
    updatedAt: tradingField(row, "date_modified", "date_updated", "updated_at", "last_updated")
  })).filter((row) => row.commodityId != null && row.terminalId != null && row.system);
};
const getUexPrices = async () => {
  if (uexPriceCache.rows && uexPriceCache.expiresAt > Date.now()) { console.log("[trading] UEX cache hit"); return uexPriceCache; }
  if (!uexApiToken) throw Object.assign(new Error("UEX API ist nicht konfiguriert."), { code: "UEX_NOT_CONFIGURED" });
  console.log("[trading] UEX cache refresh");
  const response = await fetch("https://api.uexcorp.uk/2.0/commodities_prices_all/", { headers: { Authorization: `Bearer ${uexApiToken}`, Accept: "application/json" } });
  if (response.status === 429) throw Object.assign(new Error("UEX API Rate Limit erreicht."), { code: "UEX_RATE_LIMIT" });
  if (!response.ok) throw Object.assign(new Error("UEX API ist nicht erreichbar."), { code: "UEX_UNAVAILABLE" });
  const payload = await response.json();
  if (payload.status !== "ok") throw Object.assign(new Error("UEX API hat keine gültigen Daten geliefert."), { code: "UEX_INVALID" });
  const terminalResponse = await fetch("https://api.uexcorp.uk/2.0/terminals?type=commodity", { headers: { Authorization: `Bearer ${uexApiToken}`, Accept: "application/json" } });
  if (!terminalResponse.ok) throw Object.assign(new Error("UEX Terminaldaten sind nicht erreichbar."), { code: "UEX_UNAVAILABLE" });
  const terminalPayload = await terminalResponse.json();
  if (terminalPayload.status !== "ok") throw Object.assign(new Error("UEX Terminaldaten sind ungültig."), { code: "UEX_INVALID" });
  const rows = normalizeUexRows(payload, terminalPayload);
  uexPriceCache = { rows, updatedAt: new Date().toISOString(), expiresAt: Date.now() + UEX_CACHE_TTL_MS };
  return uexPriceCache;
};
const tradingAgeSeconds = (value) => {
  const numeric = Number(value);
  const time = Number.isFinite(numeric) && numeric > 0 ? (numeric < 1e12 ? numeric * 1000 : numeric) : Date.parse(value || "");
  return Number.isFinite(time) ? Math.max(0, Math.floor((Date.now() - time) / 1000)) : null;
};
const calculateTradingRoutes = (rows, system, ship, capital, fullLoadOnly, hideOutdated, sort) => {
  const buys = new Map(), sells = new Map();
  for (const row of rows.filter((item) => item.system.toLowerCase() === system.toLowerCase())) {
    const key = String(row.commodityId);
    if (row.buyPrice > 0 && row.buyStock > 0) (buys.get(key) || buys.set(key, []).get(key)).push(row);
    if (row.sellPrice > 0 && row.sellDemand > 0) (sells.get(key) || sells.set(key, []).get(key)).push(row);
  }
  const routes = [];
  for (const [commodityId, buyRows] of buys) for (const buy of buyRows) for (const sell of (sells.get(commodityId) || [])) {
    if (String(buy.terminalId) === String(sell.terminalId) || sell.sellPrice <= buy.buyPrice) continue;
    const ages = [tradingAgeSeconds(buy.updatedAt), tradingAgeSeconds(sell.updatedAt)].filter((age) => age != null);
    const dataAgeSeconds = ages.length ? Math.max(...ages) : null;
    if (hideOutdated && (dataAgeSeconds == null || dataAgeSeconds > TRADING_DATA_MAX_AGE_SECONDS)) continue;
    const capitalScu = capital == null ? Infinity : Math.floor(capital / buy.buyPrice);
    const usableSCU = Math.floor(Math.min(ship.cargo, buy.buyStock, sell.sellDemand, capitalScu));
    if (usableSCU <= 0) continue;
    const investment = usableSCU * buy.buyPrice, sellRevenue = usableSCU * sell.sellPrice, netProfit = sellRevenue - investment;
    const loadPercent = (usableSCU / ship.cargo) * 100;
    const loadStatus = loadPercent >= 100 ? "full" : loadPercent >= 25 ? "partial" : "poor";
    if (fullLoadOnly && loadStatus !== "full") continue;
    routes.push({ commodity: buy.commodity, buyLocation: buy.terminal, sellLocation: sell.terminal, buyStock: buy.buyStock, sellDemand: sell.sellDemand, usableSCU, buyPrice: buy.buyPrice, sellPrice: sell.sellPrice, investment, sellRevenue, netProfit, profitPerSCU: netProfit / usableSCU, roi: investment ? (netProfit / investment) * 100 : 0, loadPercent, loadStatus, dataAgeSeconds });
  }
  const sorters = { profit: "netProfit", roi: "roi", profit_per_scu: "profitPerSCU", investment: "investment", revenue: "sellRevenue", load: "usableSCU", age: "dataAgeSeconds", buy_stock: "buyStock", sell_demand: "sellDemand", buy_location: "buyLocation" };
  const field = sorters[sort] || "netProfit";
  return routes.sort((a, b) => { if (field === "buyLocation") return `${a.buyLocation} ${a.sellLocation}`.localeCompare(`${b.buyLocation} ${b.sellLocation}`); if (field === "age") return (a[field] ?? Infinity) - (b[field] ?? Infinity); return b[field] - a[field]; });
};
const tradingHtml = () => readFile(join(publicDir, "trading.html"), "utf8");

const server = createServer(async (req, res) => {
  req.requestId = randomUUID();
  res.setHeader("x-request-id", req.requestId);
  try {
    const url = new URL(req.url, "http://localhost");
    logApiRequest(req, res, url, Date.now());

    if (req.method === "OPTIONS" && url.pathname.startsWith("/v1/scmdb/")) {
      res.writeHead(204, corsHeaders);
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/healthz") {
      await pool.query("SELECT 1");
      return json(res, 200, { ok: true, service: "blueprint-inventory", database: "ok" });
    }

    if (req.method === "GET" && url.pathname === "/api/trading/routes") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "authentication required" });
      if (url.searchParams.get("execute") !== "true") return json(res, 200, { system: tradingSystems[(url.searchParams.get("system") || "stanton").toLowerCase()] || "Stanton", source: "UEX", updatedAt: uexPriceCache.updatedAt, routes: [], deferred: true });
      const systemId = (url.searchParams.get("system") || "stanton").toLowerCase();
      const shipId = (url.searchParams.get("ship") || "railen").toLowerCase();
      if (!tradingSystems[systemId]) return json(res, 400, { error: "invalid system" });
      if (!tradingShips[shipId]) return json(res, 400, { error: "invalid ship" });
      const capitalRaw = url.searchParams.get("capital");
      const capital = capitalRaw == null || capitalRaw.trim() === "" ? null : Number(capitalRaw);
      if (capital != null && (!Number.isFinite(capital) || capital <= 0)) return json(res, 400, { error: "invalid capital" });
      const sort = url.searchParams.get("sort") || "profit";
      if (!["profit", "roi", "profit_per_scu", "investment", "revenue", "load", "age", "buy_stock", "sell_demand", "buy_location"].includes(sort)) return json(res, 400, { error: "invalid sort" });
      try {
        const cache = await getUexPrices();
        const routes = calculateTradingRoutes(cache.rows, tradingSystems[systemId], tradingShips[shipId], capital, url.searchParams.get("fullLoadOnly") === "true", url.searchParams.get("hideOutdated") === "true", sort);
        console.log(`[trading] routes calculated: ${routes.length}; system=${tradingSystems[systemId]} ship=${tradingShips[shipId].name}`);
        return json(res, 200, { system: tradingSystems[systemId], ship: { id: shipId, name: tradingShips[shipId].name, capacity: tradingShips[shipId].cargo }, source: "UEX", updatedAt: cache.updatedAt, cacheExpiresAt: new Date(cache.expiresAt).toISOString(), routes });
      } catch (error) {
        console.warn(`[trading] request failed; reason=${error.message}`);
        const status = error.code === "UEX_NOT_CONFIGURED" ? 503 : error.code === "UEX_RATE_LIMIT" ? 429 : 502;
        return json(res, status, { error: error.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/trading/config") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "authentication required" });
      return json(res, 200, { systems: Object.entries(tradingSystems).map(([id, name]) => ({ id, name })), ships: tradingShipOptions.map(([id, ship]) => ({ id, ...ship })) });
    }

    if (req.method === "GET" && ["/public/", "/public-preview/"].some((prefix) => url.pathname.startsWith(prefix)) && url.pathname.split("/").filter(Boolean).length === 2) {
      const preview = url.pathname.startsWith("/public-preview/");
      const token = url.pathname.slice(preview ? "/public-preview/".length : "/public/".length);
      if (!publicTokenPattern.test(token)) return json(res, 404, { error: "public link not found" });
      const html = await readFile(join(publicDir, preview ? "public-preview.html" : "public-search.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }

    if (req.method === "POST" && url.pathname.startsWith("/v1/scmdb/")) {
      const token = url.pathname.slice("/v1/scmdb/".length);
      console.log("[sink] POST received");
      if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) {
        console.warn("[sink] rejected: invalid sink token format");
        return json(res, 401, { error: "invalid sink" });
      }
      let envelope;
      try { envelope = JSON.parse(await readBody(req)); } catch {
        console.warn("[sink] rejected: invalid JSON");
        return json(res, 400, { error: "invalid JSON" });
      }
      const validationError = validateEnvelope(envelope);
      if (validationError) {
        console.warn(`[sink] rejected: ${validationError}; event=${envelope?.event ?? "unknown"}`);
        return json(res, 400, { error: validationError });
      }

      const tokenHash = hashToken(token);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const revoked = await client.query("SELECT 1 FROM revoked_sink_tokens WHERE token_hash = $1", [tokenHash]);
        if (revoked.rowCount) {
          await client.query("ROLLBACK");
          console.warn(`[sink] rejected: revoked sink; event=${envelope.event}`);
          return json(res, 401, { error: "sink revoked" });
        }
        const connection = await client.query("SELECT app_user_id, scmdb_user_id, user_handle, connection_status FROM scmdb_connections WHERE token_hash = $1 AND app_user_id IS NOT NULL AND connection_status IN ('pending', 'connected') AND revoked_at IS NULL FOR UPDATE", [tokenHash]);
        if (!connection.rowCount) {
          await client.query("ROLLBACK");
          console.warn(`[sink] rejected: sink not registered; event=${envelope.event}`);
          return json(res, 401, { error: "sink not registered" });
        }
        if (!connection.rows[0].scmdb_user_id && ["profile.snapshot", "profile.updated"].includes(envelope.event)) {
          await client.query("UPDATE scmdb_connections SET scmdb_user_id=$2, user_handle=COALESCE($3,user_handle) WHERE token_hash=$1", [tokenHash, envelope.user.id, validText(envelope.user.handle, 200) ? envelope.user.handle : null]);
        } else if (envelope.event === "inventory.transaction") {
          envelope.user = { id: connection.rows[0].scmdb_user_id, handle: connection.rows[0].user_handle || null };
        } else if (connection.rows[0].scmdb_user_id !== envelope.user.id) {
          await client.query("ROLLBACK");
          console.warn(`[sink] rejected: sink identity mismatch; event=${envelope.event}`);
          return json(res, 403, { error: "sink identity mismatch" });
        }
        await client.query("UPDATE scmdb_connections SET connection_status = CASE WHEN connection_status = 'pending' THEN 'connected' ELSE connection_status END, connected_at = CASE WHEN connection_status = 'pending' THEN COALESCE(connected_at, now()) ELSE connected_at END, disconnected_at = CASE WHEN connection_status = 'pending' THEN NULL ELSE disconnected_at END, last_seen_at = now(), user_handle = COALESCE($2, user_handle) WHERE token_hash = $1 AND connection_status <> 'revoked'", [tokenHash, validText(envelope.user.handle, 200) ? envelope.user.handle : null]);
        const duplicate = await client.query("SELECT 1 FROM scmdb_events WHERE event_id = $1", [envelope.event_id]);
        if (duplicate.rowCount) {
          await client.query("COMMIT");
          console.log(`[sink] duplicate ignored; event=${envelope.event}`);
          return accepted(res);
        }
        await applyBlueprintEvent(client, tokenHash, envelope);
        await client.query(
          "INSERT INTO scmdb_events (event_id, token_hash, event_name, event_ts) VALUES ($1, $2, $3, $4)",
          [envelope.event_id, tokenHash, envelope.event, envelope.ts]
        );
        await client.query("COMMIT");
        console.log(`[sink] accepted; event=${envelope.event}`);
        notifyDiscordBlueprintAdded(envelope).catch((error) => console.warn(`[discord] notification failed: ${error.message}`));
        syncWikiMaterials();
        return accepted(res);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`[sink] rejected during processing; event=${envelope.event}; reason=${error.message}`);
        return json(res, 400, { error: error.message === "invalid blueprint tag" || error.message === "invalid blueprint snapshot" ? error.message : "event rejected" });
      } finally {
        client.release();
      }
    }

    if (req.method === "POST" && url.pathname === "/auth/register") {
      const rateKey = clientKey(req);
      if (!registrationRateLimit.allow(rateKey)) return tooManyRequests(res);
      const body = await readBody(req);
      let payload;
      try { payload = body.trim().startsWith("{") ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)); } catch { registrationRateLimit.recordFailure(rateKey); return json(res, 400, { error: "invalid registration" }); }
      const token = generateVerseLinkToken();
      const displayName = String(payload.display_name || "").trim();
      if (!validText(displayName, 50) || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(displayName)) { registrationRateLimit.recordFailure(rateKey); return json(res, 400, { error: "invalid VerseLink ID or display name" }); }
      const recoveryKey = generateRecoveryToken();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tokenHash = hashAuthToken(token);
        const recoveryHash = hashRecoveryToken(recoveryKey, pepper);
        const existing = await client.query("SELECT 1 FROM auth_tokens WHERE token_hash=$1", [tokenHash]);
        if (existing.rowCount) { await client.query("ROLLBACK"); registrationRateLimit.recordFailure(rateKey); return json(res, 409, { error: "VerseLink ID already exists" }); }
        const user = await client.query("INSERT INTO app_users (display_name) VALUES ($1) RETURNING id", [displayName]);
        await client.query("INSERT INTO auth_tokens (app_user_id, token_hash) VALUES ($1, $2)", [user.rows[0].id, tokenHash]);
        await client.query("INSERT INTO auth_recovery_tokens (app_user_id, token_hash) VALUES ($1, $2)", [user.rows[0].id, recoveryHash]);
        const group = await client.query("INSERT INTO blueprint_groups (name, created_by) VALUES ($1, $2) RETURNING id", [`${displayName}'s crew`, user.rows[0].id]);
        await client.query("INSERT INTO group_members (group_id, app_user_id, role) VALUES ($1, $2, 'owner')", [group.rows[0].id, user.rows[0].id]);
        const session = await createDashboardSession(client, user.rows[0].id);
        await client.query("COMMIT");
        registrationRateLimit.clear(rateKey);
        logger.info("auth.register", {}, { request_id: req.requestId, user_id: user.rows[0].id });
        res.writeHead(201, { "content-type": "application/json; charset=utf-8", "set-cookie": `bp_session=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
        res.end(JSON.stringify({ ok: true, token, recovery_key: recoveryKey }));
        void notifyNewUserRegistration({ userId: user.rows[0].id, displayName, registeredAt: new Date().toISOString() }).catch(() => {});
        return;
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); if (error.code === "23505") return json(res, 409, { error: "VerseLink ID already exists" }); throw error; } finally { client.release(); }
    }

    if (req.method === "POST" && url.pathname === "/auth/recover") {
      const invalidRecovery = () => json(res, 401, { error: "invalid or expired recovery key" });
      const rateKey = clientKey(req);
      if (!recoveryRateLimit.allow(rateKey)) return tooManyRequests(res);
      let payload;
      try { payload = JSON.parse(await readBody(req)); } catch { recoveryRateLimit.recordFailure(rateKey); return invalidRecovery(); }
      const recoveryKey = String(payload.recovery_key || "");
      if (!isRecoveryToken(recoveryKey)) { recoveryRateLimit.recordFailure(rateKey); return invalidRecovery(); }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const recovery = await client.query(
          "SELECT r.id,r.app_user_id,r.revoked_at,u.account_status FROM auth_recovery_tokens r JOIN app_users u ON u.id=r.app_user_id WHERE r.token_hash=$1 FOR UPDATE",
          [hashRecoveryToken(recoveryKey, pepper)]
        );
        if (!recovery.rowCount || recovery.rows[0].revoked_at || recovery.rows[0].account_status !== "active") {
          await client.query("ROLLBACK");
          recoveryRateLimit.recordFailure(rateKey);
          return invalidRecovery();
        }
        const appUserId = recovery.rows[0].app_user_id;
        const newToken = generateVerseLinkToken();
        const newRecoveryKey = generateRecoveryToken();
        await client.query("UPDATE auth_tokens SET revoked_at=now() WHERE app_user_id=$1 AND revoked_at IS NULL", [appUserId]);
        await client.query("INSERT INTO auth_tokens (app_user_id, token_hash) VALUES ($1,$2)", [appUserId, hashAuthToken(newToken)]);
        await client.query("UPDATE auth_recovery_tokens SET revoked_at=now(), last_used_at=now() WHERE id=$1", [recovery.rows[0].id]);
        await client.query("INSERT INTO auth_recovery_tokens (app_user_id, token_hash) VALUES ($1,$2)", [appUserId, hashRecoveryToken(newRecoveryKey, pepper)]);
        await client.query("DELETE FROM dashboard_sessions WHERE app_user_id=$1", [appUserId]);
        await client.query("COMMIT");
        recoveryRateLimit.clear(rateKey);
        return json(res, 200, { token: newToken, recovery_key: newRecoveryKey });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    if (req.method === "POST" && url.pathname === "/auth/login") {
      const rateKey = clientKey(req);
      if (!loginRateLimit.allow(rateKey)) return tooManyRequests(res);
      const body = await readBody(req);
      let payload;
      try { payload = body.trim().startsWith("{") ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body)); } catch { loginRateLimit.recordFailure(rateKey); return json(res, 401, { error: "invalid VerseLink ID" }); }
      const token = String(payload.token || "");
      if (!verseLinkTokenPattern.test(token)) { loginRateLimit.recordFailure(rateKey); return json(res, 401, { error: "invalid VerseLink ID" }); }
      const result = await pool.query("SELECT t.id, t.app_user_id, u.account_status FROM auth_tokens t JOIN app_users u ON u.id=t.app_user_id WHERE t.token_hash=$1 AND t.revoked_at IS NULL", [hashAuthToken(token)]);
      if (!result.rowCount || result.rows[0].account_status !== "active") { loginRateLimit.recordFailure(rateKey); return json(res, 401, { error: "invalid VerseLink ID" }); }
      const client = await pool.connect();
      try { await client.query("BEGIN"); await client.query("UPDATE auth_tokens SET last_used_at=now() WHERE id=$1", [result.rows[0].id]); const session = await createDashboardSession(client, result.rows[0].app_user_id); await client.query("COMMIT"); loginRateLimit.clear(rateKey); logger.info("auth.login.success", {}, { request_id: req.requestId, user_id: result.rows[0].app_user_id }); res.writeHead(200, { "content-type": "application/json; charset=utf-8", "set-cookie": `bp_session=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` }); return res.end(JSON.stringify({ ok: true })); } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; } finally { client.release(); }
    }

    if (req.method === "POST" && url.pathname === "/logout") {
      const session = parseCookies(req.headers.cookie).bp_session;
      if (session) await pool.query("DELETE FROM dashboard_sessions WHERE session_hash = $1", [hashSession(session)]);
      logger.info("auth.logout", {}, { request_id: req.requestId });
      res.writeHead(303, { location: "/login", "set-cookie": "bp_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/api/blueprints") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 200, { blueprints: [], scmdb_connected: false });
      const connected = await pool.query("SELECT 1 FROM scmdb_connections WHERE app_user_id=$1 AND connection_status='connected' AND revoked_at IS NULL LIMIT 1", [context.appUserId]);
      if (!connected.rowCount) return json(res, 200, { blueprints: [], scmdb_connected: false });
      const result = await pool.query(accessibleBlueprintQuery, [context.appUserId]);
      return json(res, 200, { blueprints: result.rows, scmdb_connected: true });
    }

    if (url.pathname.startsWith("/api/personalinventory")) {
      const current = await getCurrentAppUser(req);
      if (!current) return json(res, 401, { error: "login required" });
      if (req.method === "GET" && url.pathname === "/api/personalinventory/catalog") {
        const q = String(url.searchParams.get("search") || "").trim();
        const values = []; const clauses = ["active = true"];
        if (q) { values.push(`%${q}%`); clauses.push(`(name ILIKE $${values.length} OR manufacturer ILIKE $${values.length} OR category ILIKE $${values.length} OR subcategory ILIKE $${values.length})`); }
        for (const field of ["category", "manufacturer"]) { const value = url.searchParams.get(field)?.trim(); if (value) { values.push(value); clauses.push(`${field} ILIKE $${values.length}`); } }
        const result = await pool.query(`SELECT id, external_id, name, category, subcategory, manufacturer, description, image_url, source FROM item_catalog WHERE ${clauses.join(" AND ")} ORDER BY lower(name) LIMIT 100`, values);
        return json(res, 200, { items: result.rows });
      }
      if (req.method === "GET" && url.pathname === "/api/personalinventory/locations") {
        const result = await pool.query("SELECT id, external_id, name, type, star_system, is_home_location FROM inventory_locations WHERE active=true ORDER BY is_home_location DESC, lower(name)");
        return json(res, 200, { locations: result.rows });
      }
      if (req.method === "GET" && url.pathname === "/api/personalinventory") {
        const personal = await pool.query(`SELECT ui.id, ui.item_id, ui.location_id, ui.quantity, ui.trade_status, ui.trade_quantity, ui.owner_note, ui.share_note, ui.favorite, ui.target_quantity, GREATEST(ui.quantity-COALESCE(ui.target_quantity,ui.quantity),0)::int AS surplus, ic.name, ic.category, ic.subcategory, ic.manufacturer, ic.image_url, il.name AS location_name, 'PERSONAL' AS source FROM user_inventory ui JOIN item_catalog ic ON ic.id=ui.item_id JOIN inventory_locations il ON il.id=ui.location_id WHERE ui.user_id=$1`, [current.id]);
        const synced = await pool.query(`SELECT s.id, NULL::uuid AS item_id, NULL::uuid AS location_id, s.quantity, 'NOT_FOR_TRADE' AS trade_status, 0 AS trade_quantity, NULL AS owner_note, false AS share_note, false AS favorite, NULL::integer AS target_quantity, s.quantity AS surplus, s.item_name AS name, s.category, NULL AS subcategory, NULL AS manufacturer, NULL AS image_url, 'Station: ' || s.location_name AS location_name, 'SYNC_STATION' AS source FROM inventory_sync_state s WHERE s.user_id=$1 AND s.storage_type='STATION' AND s.quantity > 0`, [current.id]);
        const items = [...personal.rows, ...synced.rows].sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.location_name).localeCompare(String(b.location_name)));
        return json(res, 200, { items });
      }
      if (req.method === "GET" && url.pathname === "/api/personalinventory/settings") {
        const result = await pool.query(`INSERT INTO personal_inventory_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING RETURNING user_id, visibility, location_visibility`, [current.id]);
        if (result.rowCount) return json(res, 200, { settings: result.rows[0] });
        const existing = await pool.query("SELECT user_id, visibility, location_visibility FROM personal_inventory_settings WHERE user_id=$1", [current.id]);
        return json(res, 200, { settings: existing.rows[0] });
      }
      if (req.method === "PATCH" && url.pathname === "/api/personalinventory/settings") {
        let data; try { data = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
        const visibility = String(data.visibility || "").toUpperCase(), locationVisibility = String(data.location_visibility || "").toUpperCase();
        const levels = { PRIVATE: 0, GROUPS: 1, PUBLIC: 2 };
        if (!(visibility in levels) || !(locationVisibility in levels)) return json(res, 400, { error: "invalid visibility" });
        if (levels[locationVisibility] > levels[visibility]) return json(res, 400, { error: "location visibility cannot exceed inventory visibility" });
        const result = await pool.query(`INSERT INTO personal_inventory_settings (user_id,visibility,location_visibility) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET visibility=EXCLUDED.visibility, location_visibility=EXCLUDED.location_visibility, updated_at=now() RETURNING user_id, visibility, location_visibility`, [current.id, visibility, locationVisibility]);
        return json(res, 200, { settings: result.rows[0] });
      }
      if (req.method === "GET" && url.pathname === "/api/personalinventory/wanted") {
        const result = await pool.query(`SELECT w.id,w.item_id,w.wanted_quantity,w.note,w.priority,w.created_at,w.updated_at,ic.name,ic.category,ic.subcategory,ic.manufacturer FROM inventory_wanted w JOIN item_catalog ic ON ic.id=w.item_id WHERE w.user_id=$1 ORDER BY CASE w.priority WHEN 'HIGH' THEN 0 WHEN 'NORMAL' THEN 1 ELSE 2 END, lower(ic.name)`, [current.id]);
        return json(res, 200, { items: result.rows });
      }
      if (req.method === "POST" && url.pathname === "/api/personalinventory/wanted") {
        let data; try { data = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
        const quantity = Number(data.wanted_quantity), note = data.note == null ? null : String(data.note).trim(), priority = String(data.priority || 'NORMAL').toUpperCase();
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000000 || !['LOW','NORMAL','HIGH'].includes(priority) || (note && note.length > 240) || !/^[0-9a-f-]{36}$/i.test(String(data.item_id || ""))) return json(res, 400, { error: "invalid wanted item" });
        const valid = await pool.query("SELECT 1 FROM item_catalog WHERE id=$1 AND active=true", [data.item_id]); if (!valid.rowCount) return json(res, 400, { error: "invalid catalog item" });
        const result = await pool.query(`INSERT INTO inventory_wanted (user_id,item_id,wanted_quantity,note,priority) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id,item_id) DO UPDATE SET wanted_quantity=EXCLUDED.wanted_quantity,note=EXCLUDED.note,priority=EXCLUDED.priority,updated_at=now() RETURNING id,wanted_quantity,note,priority`, [current.id,data.item_id,quantity,note,priority]);
        return json(res, 201, { item: result.rows[0] });
      }
      const wantedMatch = url.pathname.match(/^\/api\/personalinventory\/wanted\/([0-9a-f-]+)$/i);
      if (wantedMatch && ["PATCH","DELETE"].includes(req.method)) {
        if (req.method === "DELETE") { const deleted = await pool.query("DELETE FROM inventory_wanted WHERE id=$1 AND user_id=$2 RETURNING id", [wantedMatch[1],current.id]); if (!deleted.rowCount) return json(res,404,{error:"wanted item not found"}); return json(res,200,{ok:true}); }
        let data; try { data = JSON.parse(await readBody(req)); } catch { return json(res,400,{error:"invalid JSON"}); }
        const quantity=Number(data.wanted_quantity), note=data.note==null?null:String(data.note).trim(), priority=String(data.priority||'NORMAL').toUpperCase(); if(!Number.isInteger(quantity)||quantity<1||quantity>1000000||!['LOW','NORMAL','HIGH'].includes(priority)||(note&&note.length>240))return json(res,400,{error:"invalid wanted item"});
        const updated=await pool.query("UPDATE inventory_wanted SET wanted_quantity=$1,note=$2,priority=$3,updated_at=now() WHERE id=$4 AND user_id=$5 RETURNING id,wanted_quantity,note,priority",[quantity,note,priority,wantedMatch[1],current.id]); if(!updated.rowCount)return json(res,404,{error:"wanted item not found"}); return json(res,200,{item:updated.rows[0]});
      }
      if (req.method === "GET" && url.pathname === "/api/personalinventory/owners") {
        const itemId = url.searchParams.get("item_id") || ""; if (!/^[0-9a-f-]{36}$/i.test(itemId)) return json(res,400,{error:"invalid item"});
        const result = await pool.query(`SELECT u.id AS user_id,COALESCE(u.verselink_name,u.display_name) AS display_name,ui.item_id,ic.name,ui.trade_status,ui.trade_quantity,CASE WHEN ui.share_note THEN ui.owner_note ELSE NULL END AS owner_note,CASE WHEN s.location_visibility='PUBLIC' OR (s.location_visibility='GROUPS' AND EXISTS (SELECT 1 FROM group_members a JOIN group_members b ON b.group_id=a.group_id WHERE a.app_user_id=u.id AND b.app_user_id=$2)) OR u.id=$2 THEN il.name ELSE NULL END AS location_name FROM user_inventory ui JOIN app_users u ON u.id=ui.user_id AND u.account_status='active' JOIN item_catalog ic ON ic.id=ui.item_id JOIN inventory_locations il ON il.id=ui.location_id LEFT JOIN personal_inventory_settings s ON s.user_id=u.id WHERE ui.item_id=$1 AND ui.trade_status IN ('MAY_TRADE','FOR_TRADE') AND (u.id=$2 OR COALESCE(s.visibility,'PRIVATE')='PUBLIC' OR (COALESCE(s.visibility,'PRIVATE')='GROUPS' AND EXISTS (SELECT 1 FROM group_members a JOIN group_members b ON b.group_id=a.group_id WHERE a.app_user_id=u.id AND b.app_user_id=$2))) ORDER BY lower(COALESCE(u.verselink_name,u.display_name))`, [itemId,current.id]);
        return json(res,200,{owners:result.rows.map(row=>({...row,available:row.trade_status==='FOR_TRADE'?row.trade_quantity:null}))});
      }
      if (req.method === "GET" && url.pathname === "/api/personalinventory/matches") {
        const result = await pool.query(`SELECT w.item_id,w.wanted_quantity,w.note,ic.name AS item_name,u.id AS user_id,COALESCE(u.verselink_name,u.display_name) AS display_name,ui.trade_status,ui.trade_quantity,CASE WHEN ui.share_note THEN ui.owner_note ELSE NULL END AS owner_note,CASE WHEN s.location_visibility='PUBLIC' OR (s.location_visibility='GROUPS' AND EXISTS (SELECT 1 FROM group_members a JOIN group_members b ON b.group_id=a.group_id WHERE a.app_user_id=u.id AND b.app_user_id=$1)) THEN il.name ELSE NULL END AS location_name FROM inventory_wanted w JOIN item_catalog ic ON ic.id=w.item_id JOIN user_inventory ui ON ui.item_id=w.item_id AND ui.user_id<>$1 AND ui.trade_status IN ('MAY_TRADE','FOR_TRADE') JOIN app_users u ON u.id=ui.user_id AND u.account_status='active' LEFT JOIN personal_inventory_settings s ON s.user_id=u.id JOIN inventory_locations il ON il.id=ui.location_id WHERE (COALESCE(s.visibility,'PRIVATE')='PUBLIC' OR (COALESCE(s.visibility,'PRIVATE')='GROUPS' AND EXISTS (SELECT 1 FROM group_members a JOIN group_members b ON b.group_id=a.group_id WHERE a.app_user_id=u.id AND b.app_user_id=$1))) AND w.user_id=$1 ORDER BY lower(ic.name),lower(COALESCE(u.verselink_name,u.display_name))`, [current.id]);
        return json(res,200,{matches:result.rows.map(row=>({...row,available:row.trade_status==='FOR_TRADE'?row.trade_quantity:null}))});
      }
      if (req.method === "GET" && url.pathname === "/api/personalinventory/events") {
        const result = await pool.query(`SELECT e.id, e.event_type, e.game_version, e.target_location_id, l.name AS target_location_name, e.unique_items, e.total_items, e.location_count, e.created_at FROM inventory_events e LEFT JOIN inventory_locations l ON l.id=e.target_location_id WHERE e.user_id=$1 ORDER BY e.created_at DESC LIMIT 50`, [current.id]);
        return json(res, 200, { events: result.rows });
      }
      if (req.method === "POST" && ["/api/personalinventory/patch-reset", "/api/personalinventory/wipe"].includes(url.pathname)) {
        const raw = await readBody(req); let data = {};
        try { if (raw.trim()) data = raw.trim().startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); } catch { return json(res, 400, { error: "invalid JSON" }); }
        const gameVersion = String(data.game_version || "").trim() || null;
        if (gameVersion && gameVersion.length > 50) return json(res, 400, { error: "game_version too long" });
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const snapshot = await client.query("SELECT COUNT(DISTINCT item_id)::int AS unique_items, COALESCE(SUM(quantity),0)::int AS total_items, COUNT(DISTINCT location_id)::int AS location_count FROM user_inventory WHERE user_id=$1", [current.id]);
          const counts = snapshot.rows[0];
          if (url.pathname.endsWith("patch-reset")) {
            if (!/^[0-9a-f-]{36}$/i.test(String(data.location_id || ""))) throw new Error("invalid home location");
            const target = await client.query("SELECT id, name FROM inventory_locations WHERE id=$1 AND active=true AND is_home_location=true", [data.location_id]);
            if (!target.rowCount) throw new Error("invalid home location");
            const source = await client.query("SELECT item_id, quantity, trade_quantity, trade_status, owner_note, share_note, favorite, target_quantity, created_at FROM user_inventory WHERE user_id=$1 ORDER BY item_id, created_at, id", [current.id]);
            const merged = new Map();
            for (const row of source.rows) { const item = merged.get(row.item_id) || { ...row, quantity: 0, trade_quantity: 0, notes: [], allNotesShared: true, favorite: false, target_quantity: null }; item.quantity += row.quantity; item.trade_quantity += row.trade_quantity; item.favorite ||= row.favorite; item.target_quantity = Math.max(item.target_quantity ?? 0, row.target_quantity ?? 0); if (row.owner_note?.trim()) { if (!item.notes.includes(row.owner_note.trim())) item.notes.push(row.owner_note.trim()); item.allNotesShared &&= row.share_note; } merged.set(row.item_id, item); }
            await client.query("DELETE FROM user_inventory WHERE user_id=$1", [current.id]);
            for (const item of merged.values()) { const note = item.notes.join(' | '); if (note.length > 500) throw new Error('merged owner note exceeds 500 characters'); const status = item.trade_quantity > 0 ? 'FOR_TRADE' : (item.trade_status === 'FOR_TRADE' ? 'FOR_TRADE' : item.trade_status); await client.query("INSERT INTO user_inventory (user_id,item_id,location_id,quantity,trade_status,trade_quantity,owner_note,share_note,favorite,target_quantity) VALUES ($1,$2,$3,$4::integer,$5,LEAST($6::integer,$4::integer),$7,$8::boolean,$9::boolean,$10::integer)", [current.id, item.item_id, data.location_id, item.quantity, status, status === 'NOT_FOR_TRADE' ? 0 : item.trade_quantity, note || null, !item.notes.length || item.allNotesShared, item.favorite, item.target_quantity]); }
            await client.query("INSERT INTO inventory_events (user_id,event_type,game_version,target_location_id,unique_items,total_items,location_count) VALUES ($1,'PATCH_RESET',$2,$3,$4::integer,$5::integer,$6::integer)", [current.id, gameVersion, data.location_id, counts.unique_items, counts.total_items, counts.location_count]);
            await client.query("COMMIT");
            return json(res, 200, { ok: true, target_location: target.rows[0], unique_items: counts.unique_items, total_items: counts.total_items, source_locations: counts.location_count });
          }
          await client.query("DELETE FROM user_inventory WHERE user_id=$1", [current.id]);
          await client.query("INSERT INTO inventory_events (user_id,event_type,game_version,unique_items,total_items,location_count) VALUES ($1,'FULL_WIPE',$2,$3,$4,$5)", [current.id, gameVersion, counts.unique_items, counts.total_items, counts.location_count]);
          await client.query("COMMIT");
          return json(res, 200, { ok: true, unique_items_removed: counts.unique_items, total_items_removed: counts.total_items, locations_removed: counts.location_count });
        } catch (error) { await client.query("ROLLBACK"); return json(res, 400, { error: error.message }); } finally { client.release(); }
      }
      const idMatch = url.pathname.match(/^\/api\/personalinventory\/([0-9a-f-]+)$/i);
      if (["POST", "PATCH"].includes(req.method) && (url.pathname === "/api/personalinventory" || idMatch)) {
        const raw = await readBody(req); let data; try { data = raw.trim().startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); } catch { return json(res, 400, { error: "invalid JSON" }); }
        let quantity = Number(data.quantity);
        if (idMatch && data.quantity === undefined) { const existing = await pool.query("SELECT quantity FROM user_inventory WHERE id=$1 AND user_id=$2", [idMatch[1], current.id]); if (!existing.rowCount) return json(res,404,{error:"inventory item not found"}); quantity = existing.rows[0].quantity; }
        if (!Number.isInteger(quantity) || quantity < 0 || quantity > 1000000) return json(res, 400, { error: "invalid quantity" });
        if (idMatch) {
          if (quantity === 0) { const deleted = await pool.query("DELETE FROM user_inventory WHERE id=$1 AND user_id=$2 RETURNING id", [idMatch[1], current.id]); if (!deleted.rowCount) return json(res, 404, { error: "inventory item not found" }); return json(res, 200, { ok: true, removed: true }); }
          if (data.trade_status !== undefined || data.trade_quantity !== undefined || data.owner_note !== undefined || data.share_note !== undefined || data.favorite !== undefined || data.target_quantity !== undefined) {
            const existingTrade = await pool.query("SELECT trade_status,trade_quantity,owner_note,share_note,favorite,target_quantity FROM user_inventory WHERE id=$1 AND user_id=$2", [idMatch[1], current.id]); if (!existingTrade.rowCount) return json(res,404,{error:"inventory item not found"});
            const status = String(data.trade_status ?? existingTrade.rows[0].trade_status).toUpperCase(), tradeQuantity = Number(data.trade_quantity ?? existingTrade.rows[0].trade_quantity);
            const ownerNote = data.owner_note === null ? null : (data.owner_note === undefined ? existingTrade.rows[0].owner_note : String(data.owner_note).trim() || null), shareNote = data.share_note === undefined ? existingTrade.rows[0].share_note : data.share_note === true, favorite = data.favorite === undefined ? existingTrade.rows[0].favorite : data.favorite === true, target = data.target_quantity === null ? null : (data.target_quantity === undefined ? existingTrade.rows[0].target_quantity : Number(data.target_quantity));
            if (!["NOT_FOR_TRADE","MAY_TRADE","FOR_TRADE"].includes(status) || !Number.isInteger(tradeQuantity) || tradeQuantity < 0 || tradeQuantity > quantity || (status === "NOT_FOR_TRADE" && tradeQuantity !== 0) || (ownerNote && ownerNote.length > 500) || (data.share_note !== undefined && typeof data.share_note !== 'boolean') || (data.favorite !== undefined && typeof data.favorite !== 'boolean') || (target !== null && (!Number.isInteger(target) || target < 0))) return json(res, 400, { error: "invalid inventory settings" });
            const updated = await pool.query("UPDATE user_inventory SET quantity=$1, trade_status=$2, trade_quantity=$3, owner_note=$4, share_note=$5, favorite=$6, target_quantity=$7, updated_at=now() WHERE id=$8 AND user_id=$9 RETURNING id, quantity, trade_status, trade_quantity, owner_note, share_note, favorite, target_quantity, GREATEST(quantity-COALESCE(target_quantity,quantity),0)::int AS surplus", [quantity,status,tradeQuantity,ownerNote,shareNote,favorite,target,idMatch[1],current.id]); if (!updated.rowCount) return json(res,404,{error:"inventory item not found"}); return json(res,200,{item:updated.rows[0]});
          }
          const updated = await pool.query("UPDATE user_inventory SET quantity=$1, trade_quantity=LEAST(trade_quantity,$1), updated_at=now() WHERE id=$2 AND user_id=$3 RETURNING id, quantity, trade_status, trade_quantity", [quantity, idMatch[1], current.id]); if (!updated.rowCount) return json(res, 404, { error: "inventory item not found" }); return json(res, 200, { item: updated.rows[0] });
        }
        if (quantity < 1 || !/^[0-9a-f-]{36}$/i.test(String(data.item_id || "")) || !/^[0-9a-f-]{36}$/i.test(String(data.location_id || ""))) return json(res, 400, { error: "invalid item, location or quantity" });
        const [itemValid, locationValid] = await Promise.all([pool.query("SELECT 1 FROM item_catalog WHERE id=$1 AND active=true", [data.item_id]), pool.query("SELECT 1 FROM inventory_locations WHERE id=$1 AND active=true", [data.location_id])]);
        if (!itemValid.rowCount || !locationValid.rowCount) return json(res, 400, { error: "invalid item or location" });
        const result = await pool.query(`INSERT INTO user_inventory (user_id,item_id,location_id,quantity) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id,item_id,location_id) DO UPDATE SET quantity=user_inventory.quantity+EXCLUDED.quantity, trade_quantity=LEAST(user_inventory.trade_quantity,user_inventory.quantity+EXCLUDED.quantity), updated_at=now() RETURNING id, quantity, trade_status, trade_quantity`, [current.id, data.item_id, data.location_id, quantity]);
        return json(res, 201, { item: result.rows[0] });
      }
      if (req.method === "DELETE" && idMatch) { const deleted = await pool.query("DELETE FROM user_inventory WHERE id=$1 AND user_id=$2 RETURNING id", [idMatch[1], current.id]); if (!deleted.rowCount) return json(res, 404, { error: "inventory item not found" }); return json(res, 200, { ok: true }); }
    }

    if (req.method === "POST" && url.pathname === "/api/public-links") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const current = await getCurrentAppUser(req);
      const params = new URLSearchParams(await readBody(req));
      const groupId = params.get("group_id") || "";
      const label = params.get("label")?.trim() || null;
      const expiresRaw = params.get("expires_at")?.trim() || null;
      if (!/^[0-9a-f-]{36}$/i.test(groupId) || (label && !validText(label, 120))) return json(res, 400, { error: "invalid public link" });
      let expiresAt = null;
      if (expiresRaw) { const parsed = new Date(expiresRaw); if (Number.isNaN(parsed.valueOf()) || parsed <= new Date()) return json(res, 400, { error: "invalid expiry" }); expiresAt = parsed.toISOString(); }
      const allowed = await pool.query(`SELECT 1 FROM group_members WHERE group_id = $1 AND role = 'owner' AND app_user_id = $2`, [groupId, context.appUserId]);
      if (!allowed.rowCount && !current?.is_admin) return json(res, 403, { error: "group owner or app admin required" });
      const token = randomBytes(32).toString("base64url");
      const result = await pool.query(`INSERT INTO public_group_links (group_id, token_hash, token_ciphertext, label, expires_at, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, label, enabled, expires_at, created_at`, [groupId, hashPublicToken(token), encryptPublicToken(token), label, expiresAt, context.appUserId]);
      return json(res, 201, { link: { ...result.rows[0], public_path: `/public/${token}` }, token, public_path: `/public/${token}` });
    }

    if (req.method === "GET" && url.pathname === "/api/public-links") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const current = await getCurrentAppUser(req);
      const groupId = url.searchParams.get("group_id") || "";
      if (!/^[0-9a-f-]{36}$/i.test(groupId)) return json(res, 400, { error: "invalid group" });
      const allowed = await pool.query(`SELECT 1 FROM group_members WHERE group_id = $1 AND role = 'owner' AND app_user_id = $2`, [groupId, context.appUserId]);
      if (!allowed.rowCount && !current?.is_admin) return json(res, 403, { error: "group owner or app admin required" });
      const result = await pool.query(`SELECT id, group_id, label, enabled, expires_at, created_at, last_used_at, token_ciphertext FROM public_group_links WHERE group_id = $1 AND enabled ORDER BY created_at DESC`, [groupId]);
      return json(res, 200, { links: result.rows.map(({ token_ciphertext, ...link }) => { const token = decryptPublicToken(token_ciphertext); return { ...link, public_path: token ? `/public/${token}` : null }; }) });
    }

    if (req.method === "POST" && url.pathname === "/api/public-links/revoke") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const current = await getCurrentAppUser(req);
      const linkId = new URLSearchParams(await readBody(req)).get("link_id") || "";
      if (!/^[0-9a-f-]{36}$/i.test(linkId)) return json(res, 400, { error: "invalid link" });
      const result = await pool.query(`UPDATE public_group_links l SET enabled = false WHERE l.id = $1 AND ($3 OR l.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.app_user_id = $2 AND gm.role = 'owner')) RETURNING id`, [linkId, context.appUserId, Boolean(current?.is_admin)]);
      if (!result.rowCount) return json(res, 403, { error: "group owner or app admin required" });
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/public-links/rotate") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const current = await getCurrentAppUser(req);
      const params = new URLSearchParams(await readBody(req));
      const linkId = params.get("link_id") || "";
      if (!/^[0-9a-f-]{36}$/i.test(linkId)) return json(res, 400, { error: "invalid link" });
      const allowed = await pool.query(`SELECT l.group_id, l.label FROM public_group_links l WHERE l.id = $1 AND ($3 OR l.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.app_user_id = $2 AND gm.role = 'owner'))`, [linkId, context.appUserId, Boolean(current?.is_admin)]);
      if (!allowed.rowCount) return json(res, 403, { error: "group owner or app admin required" });
      const token = randomBytes(32).toString("base64url");
      await pool.query("UPDATE public_group_links SET enabled = false WHERE id = $1", [linkId]);
      await pool.query("INSERT INTO public_group_links (group_id, token_hash, token_ciphertext, label, created_by) VALUES ($1, $2, $3, $4, $5)", [allowed.rows[0].group_id, hashPublicToken(token), encryptPublicToken(token), allowed.rows[0].label, context.appUserId]);
      return json(res, 201, { token, public_path: `/public/${token}` });
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/public/groups/") && url.pathname.endsWith("/blueprints")) {
      if (!publicRateLimit(req)) return json(res, 429, { error: "too many requests" });
      const token = url.pathname.slice("/api/public/groups/".length, -"/blueprints".length);
      if (!publicTokenPattern.test(token)) return json(res, 404, { error: "public link not found" });
      const parsed = parsePublicSearch(url);
      if (parsed.error) return json(res, 400, { error: parsed.error });
      const link = await pool.query(`SELECT l.id, l.group_id FROM public_group_links l JOIN blueprint_groups g ON g.id = l.group_id WHERE l.token_hash = $1 AND l.enabled AND (l.expires_at IS NULL OR l.expires_at > now())`, [hashPublicToken(token)]);
      if (!link.rowCount) return json(res, 404, { error: "public link not found" });
      await pool.query(`UPDATE public_group_links SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')`, [link.rows[0].id]);
      const result = await pool.query(publicBlueprintQuery, [link.rows[0].group_id, parsed.pageSize + 1, parsed.offset, parsed.q, parsed.category, parsed.subcategory, parsed.manufacturer]);
      const items = result.rows.slice(0, parsed.pageSize).map(({ tag, name, category, subcategory, manufacturer, image_url }) => ({ tag, name, category, subcategory, manufacturer, image_url }));
      return json(res, 200, { items, page: parsed.page, page_size: parsed.pageSize, has_more: result.rows.length > parsed.pageSize });
    }

    if (req.method === "POST" && url.pathname === "/api/invites") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const current = await getCurrentAppUser(req);
      const inviteParams = new URLSearchParams(await readBody(req));
      const requestedGroupId = inviteParams.get("group_id");
      const group = await pool.query(
        `SELECT g.id FROM blueprint_groups g JOIN group_members gm ON gm.group_id = g.id
         WHERE ($2 OR (gm.app_user_id = $1 AND gm.role = 'owner')) AND ($3 = '' OR g.id::text = $3) ORDER BY g.created_at LIMIT 1`, [context.appUserId, Boolean(current?.is_admin), requestedGroupId || ""]
      );
      if (!group.rowCount) return json(res, 403, { error: "group owner required" });
      const invite = randomBytes(24).toString("base64url");
      const reusable = inviteParams.get("reusable") === "1";
      const expiryDays = Number(inviteParams.get("expires_in_days") || 14);
      if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > 365) return json(res, 400, { error: "expiry must be between 1 and 365 days" });
      const expiresAt = inviteExpiryDate(expiryDays);
      await pool.query("INSERT INTO group_invites (group_id, invite_hash, invite_code, expires_at, max_uses) VALUES ($1, $2, $3, $4, $5)", [group.rows[0].id, hashSession(`invite:${invite}`), invite, expiresAt, reusable ? null : 1]);
      return json(res, 201, { invite, expires_at: expiresAt.toISOString(), expires_in_days: expiryDays, reusable });
    }

    if (req.method === "POST" && url.pathname === "/api/invites/join") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const params = new URLSearchParams(await readBody(req));
      const invite = params.get("invite") || "";
      if (!/^[A-Za-z0-9_-]{20,}$/.test(invite)) return json(res, 400, { error: "invalid invite" });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const found = await client.query("SELECT id, group_id FROM group_invites WHERE invite_hash = $1 AND accepted_at IS NULL AND expires_at > now() AND (max_uses IS NULL OR use_count < max_uses) FOR UPDATE", [hashSession(`invite:${invite}`)]);
        if (!found.rowCount) throw new Error("invite invalid or expired");
        await client.query("INSERT INTO group_members (group_id, app_user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [found.rows[0].group_id, context.appUserId]);
        await client.query("UPDATE group_invites SET use_count = use_count + 1, accepted_at = CASE WHEN max_uses IS NULL THEN NULL ELSE now() END WHERE id = $1", [found.rows[0].id]);
        await client.query("COMMIT");
        return json(res, 200, { ok: true });
      } catch (error) { await client.query("ROLLBACK"); return json(res, 400, { error: error.message }); } finally { client.release(); }
    }

    if (req.method === "GET" && url.pathname === "/api/groups") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const result = await pool.query(`
        SELECT g.id, g.name, gm.role,
          COALESCE(json_agg(json_build_object(
            'user_id', u.id, 'name', COALESCE(u.verselink_name, u.display_name), 'role', members.role,
            'last_sync', c.last_seen_at,
            'stale', c.last_seen_at < now() - interval '24 hours'
          ) ORDER BY COALESCE(u.verselink_name, u.display_name)) FILTER (WHERE u.id IS NOT NULL AND u.account_status = 'active'), '[]') AS members
        FROM blueprint_groups g
        JOIN group_members gm ON gm.group_id = g.id
        LEFT JOIN group_members members ON members.group_id = g.id
        LEFT JOIN app_users u ON u.id = members.app_user_id
        LEFT JOIN scmdb_connections c ON c.app_user_id = u.id
        WHERE gm.app_user_id = $1
        GROUP BY g.id, g.name, gm.role ORDER BY g.name`, [context.appUserId]);
      return json(res, 200, { groups: result.rows });
    }

    if (req.method === "GET" && url.pathname === "/api/orders") {
      const context = await getSessionContext(req); if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const groupId = url.searchParams.get("group_id") || "";
      if (groupId !== "all" && !/^[0-9a-f-]{36}$/i.test(groupId)) return json(res, 400, { error: "invalid group" });
      const access = await pool.query("SELECT 1 FROM group_members gm WHERE gm.app_user_id=$1 AND ($2='all' OR gm.group_id::text=$2)", [context.appUserId, groupId]);
      if (!access.rowCount) return json(res, 403, { error: "group member required" });
      const result = await pool.query(`
        SELECT o.id,o.order_number,o.group_id,g.name AS group_name,o.blueprint_tag,o.material_name,o.required_quantity,o.quantity_unit,o.required_quality,
          COALESCE(d.delivered_quantity,o.delivered_quantity,0) AS delivered_quantity,COALESCE(d.delivered_quality,o.delivered_quality) AS delivered_quality,
          d.contributors,d.contribution_segments,o.status,o.assigned_to,o.created_by,o.note,o.created_at,o.completed_at,
          COALESCE(cu.verselink_name,cu.display_name) AS creator_name,CASE WHEN cu.profile_public THEN '/profile/' || cu.id::text ELSE null END AS creator_profile_path,
          COALESCE(au.verselink_name,au.display_name) AS assignee_name,CASE WHEN au.profile_public THEN '/profile/' || au.id::text ELSE null END AS assignee_profile_path
        FROM material_orders o
        JOIN blueprint_groups g ON g.id=o.group_id
        JOIN app_users cu ON cu.id=o.created_by
        LEFT JOIN app_users au ON au.id=o.assigned_to
        LEFT JOIN (
          SELECT d.order_id,SUM(d.delivered_quantity) AS delivered_quantity,
            STRING_AGG(DISTINCT d.delivered_quality, ', ') FILTER (WHERE d.delivered_quality IS NOT NULL AND d.delivered_quality <> '') AS delivered_quality,
            STRING_AGG(DISTINCT COALESCE(u.verselink_name,u.display_name), ', ' ORDER BY COALESCE(u.verselink_name,u.display_name)) AS contributors,
            JSON_AGG(json_build_object('name',COALESCE(u.verselink_name,u.display_name),'quantity',d.delivered_quantity,'profile_path',CASE WHEN u.profile_public THEN '/profile/' || u.id::text ELSE null END) ORDER BY d.created_at) AS contribution_segments
          FROM material_order_deliveries d JOIN app_users u ON u.id=d.delivered_by GROUP BY d.order_id
        ) d ON d.order_id=o.id
        WHERE o.hidden_at IS NULL AND ($1='all' OR o.group_id::text=$1)
          AND EXISTS (SELECT 1 FROM group_members gm WHERE gm.group_id=o.group_id AND gm.app_user_id=$2)
        ORDER BY o.created_at DESC`, [groupId, context.appUserId]);
      return json(res, 200, { orders: result.rows.map((order) => ({ ...order, status: normalizeOrderStatus(order) })) });
    }

    const miningAccess = async (appUserId, groupId) => (await pool.query("SELECT gm.group_id,gm.role FROM group_members gm WHERE gm.app_user_id=$1 AND gm.group_id=$2", [appUserId, groupId])).rows[0];
    const qualityBand = value => { const q=Number(value); return q>=1&&q<=399?1:q<=599?2:q<=699?3:q<=799?4:q<=899?5:q<=949?6:q<=998?7:q<=1000?8:null; };
    const normalizeMaterialLocation = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
    const materialLocationSystems = async () => new Map((await pool.query("SELECT name,star_system FROM inventory_locations WHERE active=true AND star_system IS NOT NULL")).rows.map(row => [normalizeMaterialLocation(row.name), row.star_system]));
    const materialSystemName = value => ({stanton:"Stanton",pyro:"Pyro",nyx:"Nyx"}[String(value || "").trim().toLowerCase()] || "");
    const materialSystemForLocation = (source, systems) => {
      const location = String(source || "").trim();
      const system = /^(Stanton|Pyro|Nyx)\s*\//i.exec(location)?.[1] || /(?:^|\|)\s*(Stanton|Pyro|Nyx)\s*$/i.exec(location)?.[1] || systems.get(normalizeMaterialLocation(location));
      return materialSystemName(system) || "Unknown";
    };
    const materialInventoryNetRows = async (groupId, db = pool) => {
      const [contributions, withdrawals] = await Promise.all([
        db.query("SELECT c.*,COALESCE(u.verselink_name,u.display_name) AS player_name,CASE WHEN u.profile_public AND u.account_status='active' THEN '/profile/'||u.id::text ELSE NULL END AS profile_path FROM material_inventory_contributions c JOIN app_users u ON u.id=c.user_id WHERE c.group_id=$1 ORDER BY c.created_at,c.id", [groupId]),
        db.query("SELECT * FROM material_inventory_withdrawals WHERE group_id=$1 ORDER BY created_at,id", [groupId])
      ]);
      const rows = new Map();
      for (const contribution of contributions.rows) {
        const key = [contribution.user_id, contribution.material_name.toLowerCase(), contribution.quality_band, contribution.quality_value, contribution.source_location || ""].join("|");
        const row = rows.get(key) || { ...contribution, quantity_scu: 0, notes: [], withdrawn_scu: 0 };
        row.quantity_scu += Number(contribution.quantity_scu) || 0;
        if (contribution.note && !row.notes.includes(contribution.note)) row.notes.push(contribution.note);
        rows.set(key, row);
      }
      const netRows = [...rows.values()];
      const matches = (row, withdrawal, exactQuality) =>
        row.material_name.toLowerCase() === String(withdrawal.material_name).toLowerCase() &&
        Number(row.quality_band) === Number(withdrawal.quality_band) &&
        (row.source_location || "") === (withdrawal.warehouse || "") &&
        (!exactQuality || (Number(row.quality_value) === Number(withdrawal.quality_value) && (!withdrawal.contributor_user_id || row.user_id === withdrawal.contributor_user_id)));
      for (const withdrawal of withdrawals.rows) {
        let remaining = Number(withdrawal.quantity_scu) || 0;
        const exactQuality = withdrawal.quality_value !== null && withdrawal.quality_value !== undefined && Number.isInteger(Number(withdrawal.quality_value));
        for (const row of netRows.filter(row => matches(row, withdrawal, exactQuality))) {
          const available = Math.max(0, Number(row.quantity_scu) - Number(row.withdrawn_scu));
          const used = Math.min(available, remaining);
          row.withdrawn_scu += used;
          remaining -= used;
          if (remaining <= 0) break;
        }
      }
      return netRows.map(row => ({ ...row, available_scu: Math.max(0, Number(row.quantity_scu) - Number(row.withdrawn_scu)) }));
    };
    const miningMatrixRows = async (appUserId, groupId, poolId = "") => {
      const access = await miningAccess(appUserId, groupId); if (!access) return null;
      const result = await pool.query(`SELECT c.id contribution_id,c.user_id,c.quantity_scu,c.quality_value,c.status,c.source_location,c.in_refinery,c.refinery_station,c.created_at,r.material_name,r.quality_band,p.id pool_id,p.name pool_name,COALESCE(u.verselink_name,u.display_name) player_name FROM mining_pool_contributions c JOIN mining_pool_resources r ON r.id=c.pool_resource_id JOIN mining_pools p ON p.id=r.pool_id JOIN app_users u ON u.id=c.user_id WHERE p.group_id=$1 AND p.status='open' AND ($2='' OR p.id::text=$2) ORDER BY c.created_at DESC`, [groupId, poolId]);
      return result.rows;
    };
    if (req.method === "POST" && url.pathname === "/api/material-inventory/contributions") {
      const context=await getSessionContext(req);if(!context?.appUserId)return json(res,401,{error:"login required"});
      const params=new URLSearchParams(await readBody(req)),groupId=params.get("group_id")||"",materialName=params.get("material_name")||"",qualityValue=Number(params.get("quality_value")),qualityBand=Number(params.get("quality_band")),quantity=Number(params.get("quantity_scu"));
      if(!/^[0-9a-f-]{36}$/i.test(groupId)||!materialName||!Number.isInteger(qualityValue)||qualityValue<1||qualityValue>1000||!Number.isInteger(qualityBand)||qualityBand<1||qualityBand>8||!Number.isFinite(quantity)||quantity<=0)return json(res,400,{error:"invalid contribution"});
      const member=await pool.query("SELECT app_user_id FROM group_members WHERE group_id=$1 AND app_user_id=$2",[groupId,context.appUserId]);if(!member.rowCount)return json(res,403,{error:"group member required"});
      const userId=context.appUserId,sourceLocation=params.get("source_location")||params.get("source")||null,insert=await pool.query("INSERT INTO material_inventory_contributions (group_id,material_name,quality_band,user_id,quantity_scu,quality_value,status,source_location,note,in_refinery,refinery_station,deposited_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CASE WHEN $7='deposited' THEN now() ELSE NULL END) RETURNING id",[groupId,materialName,qualityBand,userId,quantity,qualityValue,params.get("status")==="deposited"?"deposited":"reported",sourceLocation,params.get("note")||null,["1","on","true"].includes(params.get("in_refinery")),params.get("refinery_station")||null]);
      logger.info("material.contributed", { group_id: groupId, material_id: insert.rows[0].id, amount_scu: quantity, source_location_id: sourceLocation }, { request_id: req.requestId, user_id: userId }); return json(res,201,{ok:true,id:insert.rows[0].id});
    }

    if (req.method === "GET" && url.pathname === "/api/material-inventory/locations") {
      const context=await getSessionContext(req);if(!context?.appUserId)return json(res,401,{error:"login required"}); const groupId=url.searchParams.get("group_id")||"",query=(url.searchParams.get("q")||"").trim();
      const member=await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND app_user_id=$2",[groupId,context.appUserId]); if(!member.rowCount)return json(res,403,{error:"group member required"});
      if(!uexLocationCache.rows.length||uexLocationCache.expiresAt<Date.now()){let locations=[],aliases=new Map();if(uexApiToken){try{const response=await fetch("https://api.uexcorp.uk/2.0/terminals",{headers:{Authorization:`Bearer ${uexApiToken}`,Accept:"application/json"}});const payload=await response.json();({locations,aliases}=uniqueUexLocations(Array.isArray(payload.data)?payload.data:[]));}catch(error){console.warn(`[materials] UEX location lookup failed; reason=${logValue(error.message)}`);}}const local=(await pool.query("SELECT name,star_system,type FROM inventory_locations WHERE active=true ORDER BY lower(name)")).rows;const retainedLocal=locations.length?local.filter(row=>row.type!=="freight elevator"&&row.type!=="UEX location"):local;const combined=new Map();for(const row of [...locations,...retainedLocal.map(row=>aliases.get(normalizeUexLocation(row.name))||{...row,planet_or_moon:""})]){const key=`${normalizeUexLocation(row.name)}|${normalizeUexLocation(row.planet_or_moon)}|${normalizeUexLocation(row.star_system)}`;if(!combined.has(key))combined.set(key,row);}uexLocationCache={expiresAt:Date.now()+1800000,rows:[...combined.values()].sort((a,b)=>String(a.name).localeCompare(String(b.name))||String(a.planet_or_moon).localeCompare(String(b.planet_or_moon))||String(a.star_system).localeCompare(String(b.star_system)))};}
      const needle=query.toLowerCase();return json(res,200,{locations:uexLocationCache.rows.filter(row=>!needle||`${row.name} ${row.planet_or_moon||""} ${row.star_system}`.toLowerCase().includes(needle)).slice(0,100)});
    }
    if (req.method === "GET" && url.pathname === "/api/material-inventory/refineries") {
      const context=await getSessionContext(req);if(!context?.appUserId)return json(res,401,{error:"login required"});
      const query=(url.searchParams.get("q")||"").trim().toLowerCase();
      const result=await pool.query("SELECT terminal_name,station_name,planet_name,system_name FROM uex_refinery_locations WHERE is_available_live=true ORDER BY lower(system_name),lower(planet_name),lower(station_name),lower(terminal_name)");
      const refineries=result.rows.map(row=>({name:row.station_name||row.terminal_name,planet_or_moon:row.planet_name||"",star_system:row.system_name||"",terminal_name:row.terminal_name}));
      return json(res,200,{refineries:refineries.filter(row=>!query||`${row.name} ${row.planet_or_moon} ${row.star_system} ${row.terminal_name}`.toLowerCase().includes(query)).slice(0,100)});
    }
    if (req.method === "POST" && url.pathname === "/api/material-inventory/move-all") {
      const context=await getSessionContext(req);if(!context?.appUserId)return json(res,401,{error:"login required"});
      const p=new URLSearchParams(await readBody(req)),groupId=p.get("group_id")||"",destination=(p.get("destination")||"").trim();
      if(!/^[0-9a-f-]{36}$/i.test(groupId)||!destination)return json(res,400,{error:"invalid move-all request"});
      const member=await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND app_user_id=$2",[groupId,context.appUserId]);if(!member.rowCount)return json(res,403,{error:"group member required"});
      const client=await pool.connect();try{await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`material-inventory:${groupId}:user:${context.appUserId}`]);
        const rows=(await materialInventoryNetRows(groupId,client)).filter(row=>row.user_id===context.appUserId&&Number(row.available_scu)>0);
        for(const row of rows){const quantity=Number(row.available_scu);await client.query("INSERT INTO material_inventory_withdrawals(group_id,material_name,quality_band,quality_value,user_id,contributor_user_id,warehouse,quantity_scu,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)",[groupId,row.material_name,row.quality_band,row.quality_value,context.appUserId,context.appUserId,row.source_location||null,quantity]);await client.query("INSERT INTO material_inventory_contributions(group_id,material_name,quality_band,user_id,quantity_scu,quality_value,status,source_location,note,in_refinery) VALUES($1,$2,$3,$4,$5,$6,'reported',$7,NULL,false)",[groupId,row.material_name,row.quality_band,context.appUserId,quantity,row.quality_value,destination]);}
        await client.query("COMMIT");logger.info("material.moved", { group_id: groupId, destination_location_id: destination, moved_rows: rows.length }, { request_id: req.requestId, user_id: context.appUserId });return json(res,201,{ok:true,moved:rows.length});
      }catch(error){await client.query("ROLLBACK");logger.error("material.move_all.failed",error,{request_id:req.requestId,user_id:context.appUserId});return json(res,500,{error:"all material could not be moved"});}finally{client.release();}
    }
    const handleMaterialInventoryMove = async (req, res, url) => {
      const context=await getSessionContext(req);if(!context?.appUserId)return json(res,401,{error:"login required"});const p=new URLSearchParams(await readBody(req)),groupId=p.get("group_id")||"",destination=(p.get("destination")||"").trim(),qty=Number(p.get("quantity_scu")),band=Number(p.get("quality_band")),qualityValue=Number(p.get("quality_value")),contributorUserId=p.get("contributor_user_id")||"",source=p.get("source_location")||"",material=p.get("material_name")||"";const member=await pool.query("SELECT app_user_id FROM group_members WHERE group_id=$1 AND app_user_id=$2",[groupId,context.appUserId]);if(!member.rowCount)return json(res,403,{error:"group member required"});if(member.rows[0].app_user_id!==contributorUserId)return json(res,403,{error:"only the contribution owner can move this stock"});if(!/^[0-9a-f-]{36}$/i.test(groupId)||!material||!destination||destination===source||!Number.isInteger(band)||!Number.isInteger(qualityValue)||!/^[0-9a-f-]{36}$/i.test(contributorUserId)||!Number.isFinite(qty)||qty<=0)return json(res,400,{error:"invalid move"});const client=await pool.connect();try{await client.query("BEGIN");await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`material-inventory:${groupId}:user:${context.appUserId}`]);const rows=await materialInventoryNetRows(groupId,client);const stock=rows.find(row=>row.user_id===contributorUserId&&row.material_name.toLowerCase()===material.toLowerCase()&&Number(row.quality_band)===band&&Number(row.quality_value)===qualityValue&&(row.source_location||"")===source);if(!stock||qty>Number(stock.available_scu)){await client.query("ROLLBACK");return json(res,400,{error:"move exceeds available stock"});}await client.query("INSERT INTO material_inventory_withdrawals(group_id,material_name,quality_band,quality_value,user_id,contributor_user_id,warehouse,quantity_scu,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL)",[groupId,material,band,qualityValue,context.appUserId,contributorUserId,source,qty]);const insert=await client.query("INSERT INTO material_inventory_contributions(group_id,material_name,quality_band,user_id,quantity_scu,quality_value,status,source_location,note,in_refinery) VALUES($1,$2,$3,$4,$5,$6,'reported',$7,NULL,false) RETURNING id",[groupId,material,band,contributorUserId,qty,qualityValue,destination]);await client.query("COMMIT");return json(res,201,{ok:true,id:insert.rows[0].id});}catch(error){await client.query("ROLLBACK");console.error("[materials] move failed",error.message);return json(res,500,{error:"material move could not be saved"});}finally{client.release();}
    };
    if (req.method === "POST" && url.pathname === "/api/material-inventory/moves") {
      return handleMaterialInventoryMove(req, res, url);
    }
    if (req.method === "POST" && url.pathname === "/api/material-inventory/withdrawals") {
      const context=await getSessionContext(req);if(!context?.appUserId)return json(res,401,{error:"login required"});
      const p=new URLSearchParams(await readBody(req)),groupId=p.get("group_id")||"",qty=Number(p.get("quantity_scu")),band=Number(p.get("quality_band")),qualityValue=Number(p.get("quality_value")),contributorUserId=p.get("contributor_user_id")||"";
      const member=await pool.query("SELECT app_user_id FROM group_members WHERE group_id=$1 AND app_user_id=$2",[groupId,context.appUserId]);
      if(!member.rowCount)return json(res,403,{error:"group member required"});
      if(member.rows[0].app_user_id!==contributorUserId)return json(res,403,{error:"only the contribution owner can withdraw this stock"});
      if(!/^[0-9a-f-]{36}$/i.test(groupId)||!p.get("material_name")||!Number.isInteger(band)||!Number.isInteger(qualityValue)||!/^[0-9a-f-]{36}$/i.test(contributorUserId)||!Number.isFinite(qty)||qty<=0)return json(res,400,{error:"invalid withdrawal"});
      const client=await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`material-inventory:${groupId}:user:${context.appUserId}`]);
        const rows=await materialInventoryNetRows(groupId,client);
        const stock=rows.find(row=>row.user_id===contributorUserId&&row.material_name.toLowerCase()===p.get("material_name").toLowerCase()&&Number(row.quality_band)===band&&Number(row.quality_value)===qualityValue&&(row.source_location||"")===(p.get("warehouse")||""));
        if(!stock||qty>Number(stock.available_scu)){await client.query("ROLLBACK");return json(res,400,{error:"withdrawal exceeds available stock"});}
        const r=await client.query("INSERT INTO material_inventory_withdrawals(group_id,material_name,quality_band,quality_value,user_id,contributor_user_id,warehouse,quantity_scu,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id",[groupId,p.get("material_name"),band,qualityValue,member.rows[0].app_user_id,contributorUserId,p.get("warehouse")||null,qty,p.get("note")||null]);
        await client.query("COMMIT");return json(res,201,{ok:true,id:r.rows[0].id});
      } catch(error) { await client.query("ROLLBACK");console.error("[materials] withdrawal failed",error.message);return json(res,500,{error:"withdrawal could not be saved"}); } finally { client.release(); }
    }
    const handleMaterialInventoryWithdrawalTotals = async (req, res, url) => {
      const context=await getSessionContext(req);
      if(!context?.appUserId)return json(res,401,{error:"login required"});
      const groupId=url.searchParams.get("group_id")||"";
      const member=await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND app_user_id=$2",[groupId,context.appUserId]);
      if(!member.rowCount)return json(res,403,{error:"group member required"});
      const result=await pool.query("SELECT material_name,SUM(quantity_scu) withdrawn_scu FROM material_inventory_withdrawals WHERE group_id=$1 GROUP BY material_name",[groupId]);
      return json(res,200,{withdrawals:result.rows});
    };
    if (req.method === "GET" && url.pathname === "/api/material-inventory/withdrawal-totals") {
      return handleMaterialInventoryWithdrawalTotals(req, res, url);
    }
    const handleMaterialInventoryMatrix = async (req, res, url) => {
      const context=await getSessionContext(req);
      if(!context?.appUserId)return json(res,401,{error:"login required"});
      const groupId=url.searchParams.get("group_id")||"";
      if(!/^[0-9a-f-]{36}$/i.test(groupId))return json(res,400,{error:"invalid group"});
      const member=await pool.query("SELECT app_user_id FROM group_members WHERE group_id=$1 AND app_user_id=$2",[groupId,context.appUserId]);
      if(!member.rowCount)return json(res,403,{error:"group member required"});
      const result=await materialInventoryNetRows(groupId),locationSystems=await materialLocationSystems();
      if(url.searchParams.get("mine")==="1"){
        const own=member.rows[0].app_user_id;
        for(let i=result.length-1;i>=0;i--)if(result[i].user_id!==own)result.splice(i,1);
      }
      const materials=new Map();
      for(const row of result){
        const key=row.material_name.toLowerCase(),qty=Number(row.available_scu)||0,system=materialSystemForLocation(row.source_location,locationSystems),item=materials.get(key)||{material_name:row.material_name,uex_code:materialOrderCode(row.material_name),total_scu:0,tracked_scu:0,deposited_scu:0,reported_scu:0,refinery_scu:0,contributors:new Set(),locations:new Set(),pools:0,systems:{},bands:{}};
        item.total_scu+=qty;item.tracked_scu+=qty;
        if(row.status==='deposited')item.deposited_scu+=qty;else item.reported_scu+=qty;
        if(row.in_refinery)item.refinery_scu+=qty;
        item.contributors.add(row.user_id);if(row.source_location)item.locations.add(row.source_location);
        item.systems[system]??={total_scu:0,bands:{}};item.systems[system].total_scu+=qty;item.systems[system].bands[row.quality_band]=(item.systems[system].bands[row.quality_band]||0)+qty;item.bands[row.quality_band]=(item.bands[row.quality_band]||0)+qty;materials.set(key,item)
      }
      return json(res,200,{materials:[...materials.values()].map(item=>({...item,contributors:item.contributors.size,locations:item.locations.size}))});
    };
    if (req.method === "GET" && url.pathname === "/api/material-inventory/matrix") {
      return handleMaterialInventoryMatrix(req, res, url);
    }

    const handleMaterialInventoryMatrixMaterial = async (req, res, url, code) => {
      const context=await getSessionContext(req);
      if(!context?.appUserId)return json(res,401,{error:"login required"});
      const groupId=url.searchParams.get("group_id")||"";
      const member=await pool.query("SELECT app_user_id FROM group_members WHERE group_id=$1 AND app_user_id=$2",[groupId,context.appUserId]);
      if(!member.rowCount)return json(res,403,{error:"group member required"});
      const rows=(await materialInventoryNetRows(groupId)).filter(row=>materialOrderCode(row.material_name)===code);
      return json(res,200,{viewer_user_id:member.rows[0].app_user_id,rows,contributions:rows});
    };
    if (req.method === "GET" && url.pathname.startsWith("/api/material-inventory/matrix/material/")) {
      const code=decodeURIComponent(url.pathname.split("/").pop()).toUpperCase();
      return handleMaterialInventoryMatrixMaterial(req, res, url, code);
    }

    const handleMiningPoolMatrix = async (req, res, url) => {
      const context=await getSessionContext(req);if(!context?.appUserId)return json(res,401,{error:"login required"});const groupId=url.searchParams.get("group_id")||"",poolId=url.searchParams.get("pool_id")||"";if(!/^[0-9a-f-]{36}$/i.test(groupId))return json(res,400,{error:"invalid group"});const access=await pool.query("SELECT 1 FROM group_members WHERE app_user_id=$1 AND group_id=$2",[context.appUserId,groupId]);if(!access.rowCount)return json(res,403,{error:"group member required"});const result=await pool.query(`SELECT c.id contribution_id,c.user_id,c.quantity_scu,c.quality_value,c.status,c.source_location,c.in_refinery,c.refinery_station,c.created_at,r.material_name,r.quality_band,p.id pool_id,p.name pool_name,COALESCE(u.verselink_name,u.display_name) player_name FROM mining_pool_contributions c JOIN mining_pool_resources r ON r.id=c.pool_resource_id JOIN mining_pools p ON p.id=r.pool_id JOIN app_users u ON u.id=c.user_id WHERE p.group_id=$1 AND p.status='open' AND ($2='' OR p.id::text=$2) ORDER BY c.created_at DESC`,[groupId,poolId]);const rows=result.rows;const materials=new Map();for(const row of rows){const key=row.material_name.toLowerCase(),qty=Number(row.quantity_scu)||0,system=/^(Stanton|Pyro|Nyx)\s*\//i.exec(String(row.source_location||''))?.[1]||'Unknown';const item=materials.get(key)||{material_name:row.material_name,uex_code:materialOrderCode(row.material_name),total_scu:0,tracked_scu:0,deposited_scu:0,reported_scu:0,refinery_scu:0,contributors:new Set(),locations:new Set(),pools:new Set(),systems:{},bands:{}};item.total_scu+=qty;item.tracked_scu+=qty;if(row.status==='deposited')item.deposited_scu+=qty;else item.reported_scu+=qty;if(row.in_refinery)item.refinery_scu+=qty;item.contributors.add(row.user_id);if(row.source_location)item.locations.add(row.source_location);item.pools.add(row.pool_id);item.systems[system]??={total_scu:0,bands:{}};item.systems[system].total_scu+=qty;item.systems[system].bands[row.quality_band]=(item.systems[system].bands[row.quality_band]||0)+qty;item.bands[row.quality_band]=(item.bands[row.quality_band]||0)+qty;materials.set(key,item)}return json(res,200,{materials:[...materials.values()].map(item=>({...item,contributors:item.contributors.size,locations:item.locations.size,pools:item.pools.size}))});
    };
    if (req.method === "GET" && url.pathname === "/api/mining-pools/matrix") {
      return handleMiningPoolMatrix(req, res, url);
    }
    const handleMiningPoolMatrixMaterial = async (req, res, url, code) => {
      const context=await getSessionContext(req);if(!context?.appUserId)return json(res,401,{error:"login required"});const groupId=url.searchParams.get("group_id")||"",poolId=url.searchParams.get("pool_id")||"";const access=await pool.query("SELECT 1 FROM group_members WHERE app_user_id=$1 AND group_id=$2",[context.appUserId,groupId]);if(!access.rowCount)return json(res,403,{error:"group member required"});const result=await pool.query(`SELECT c.id contribution_id,c.user_id,c.quantity_scu,c.quality_value,c.status,c.source_location,c.in_refinery,c.refinery_station,c.created_at,r.material_name,r.quality_band,p.id pool_id,p.name pool_name,COALESCE(u.verselink_name,u.display_name) player_name FROM mining_pool_contributions c JOIN mining_pool_resources r ON r.id=c.pool_resource_id JOIN mining_pools p ON p.id=r.pool_id JOIN app_users u ON u.id=c.user_id WHERE p.group_id=$1 AND p.status='open' AND ($2='' OR p.id::text=$2) ORDER BY c.created_at DESC`,[groupId,poolId]);const filtered=result.rows.filter(row=>materialOrderCode(row.material_name)===code);return json(res,200,{contributions:filtered});
    };
    if (req.method === "GET" && url.pathname.match(/^\/api\/mining-pools\/matrix\/material\//)) {
      const code=decodeURIComponent(url.pathname.split("/").pop()).toUpperCase();
      return handleMiningPoolMatrixMaterial(req, res, url, code);
    }
    const handleMiningPoolList = async (req, res, url) => {
      const context=await getSessionContext(req);if(!context?.appUserId)return json(res,401,{error:"login required"}); const groupId=url.searchParams.get("group_id")||""; if(!/^[0-9a-f-]{36}$/i.test(groupId))return json(res,400,{error:"invalid group"}); if(!(await pool.query("SELECT 1 FROM group_members WHERE app_user_id=$1 AND group_id=$2",[context.appUserId,groupId])).rowCount)return json(res,403,{error:"group member required"});
      const result=await pool.query(`SELECT p.*,g.name group_name,COALESCE(u.verselink_name,u.display_name) creator_name,COALESCE((SELECT json_agg(json_build_object('id',r.id,'material_name',r.material_name,'quality_band',r.quality_band,'target_scu',r.target_scu,'total_scu',COALESCE((SELECT sum(c.quantity_scu) FROM mining_pool_contributions c WHERE c.pool_resource_id=r.id),0),'deposited_scu',COALESCE((SELECT sum(c.quantity_scu) FROM mining_pool_contributions c WHERE c.pool_resource_id=r.id AND c.status='deposited'),0)) ORDER BY r.material_name,r.quality_band) FROM mining_pool_resources r WHERE r.pool_id=p.id),'[]') resources FROM mining_pools p JOIN blueprint_groups g ON g.id=p.group_id JOIN app_users u ON u.id=p.created_by WHERE p.group_id=$1 ORDER BY p.created_at DESC`,[groupId]); return json(res,200,{pools:result.rows});
    };
    if (req.method === "GET" && url.pathname === "/api/mining-pools") {
      return handleMiningPoolList(req, res, url);
    }
    const handleMiningPoolCreate = async (req, res, url) => {
      const context=await getSessionContext(req); if(!context?.appUserId)return json(res,401,{error:"login required"}); const p=new URLSearchParams(await readBody(req)),groupId=p.get("group_id")||"",name=p.get("name")?.trim()||""; if(!/^[0-9a-f-]{36}$/i.test(groupId)||!validText(name,160)||!(await pool.query("SELECT 1 FROM group_members WHERE app_user_id=$1 AND group_id=$2",[context.appUserId,groupId])).rowCount)return json(res,400,{error:"invalid group or name"}); const r=await pool.query("INSERT INTO mining_pools(group_id,name,description,created_by) VALUES($1,$2,$3,$4) RETURNING id",[groupId,name,p.get("description")||null,context.appUserId]); return json(res,201,{ok:true,id:r.rows[0].id});
    };
    if (req.method === "POST" && url.pathname === "/api/mining-pools") {
      return handleMiningPoolCreate(req, res, url);
    }
    const handleMiningPoolDetail = async (req, res, url, id) => {
      const context=await getSessionContext(req);if(!context?.appUserId)return json(res,401,{error:"login required"});const access=await pool.query("SELECT 1 FROM mining_pools p JOIN group_members gm ON gm.group_id=p.group_id WHERE p.id=$1 AND gm.app_user_id=$2",[id,context.appUserId]);if(!access.rowCount)return json(res,404,{error:"pool not found"});const r=await pool.query(`SELECT p.*,r.id resource_id,r.material_name,r.quality_band,r.target_scu,c.id contribution_id,c.quantity_scu,c.quality_value,c.status,c.source_location,c.note,c.in_refinery,c.refinery_station,c.created_at contribution_created,COALESCE(u.verselink_name,u.display_name) contributor_name FROM mining_pools p JOIN mining_pool_resources r ON r.pool_id=p.id LEFT JOIN mining_pool_contributions c ON c.pool_resource_id=r.id LEFT JOIN app_users u ON u.id=c.user_id WHERE p.id=$1 ORDER BY r.material_name,r.quality_band,c.created_at`,[id]); if(!r.rowCount)return json(res,404,{error:"pool not found"}); return json(res,200,{pool:r.rows});
    };
    if (req.method === "GET" && url.pathname.match(/^\/api\/mining-pools\/[0-9a-f-]+$/i)) {
      const id=url.pathname.split("/").pop();
      return handleMiningPoolDetail(req, res, url, id);
    }
    const handleMiningPoolClose = async (req, res, url, id) => {
      const context=await getSessionContext(req);if(!context?.appUserId)return json(res,401,{error:"login required"}); const p=new URLSearchParams(await readBody(req)); const base=await pool.query("SELECT p.*,gm.group_id,gm.role FROM mining_pools p JOIN group_members gm ON gm.group_id=p.group_id WHERE gm.app_user_id=$1 AND p.id=$2",[context.appUserId,id]); if(!base.rowCount)return json(res,404,{error:"pool not found"}); await pool.query("UPDATE mining_pools SET status='closed',closed_at=now() WHERE id=$1",[id]);return json(res,200,{ok:true});
    };
    const handleMiningPoolResourceCreate = async (req, res, url, id) => {
      const context=await getSessionContext(req); if(!context?.appUserId)return json(res,401,{error:"login required"}); const p=new URLSearchParams(await readBody(req)); const base=await pool.query("SELECT p.*,gm.group_id,gm.role FROM mining_pools p JOIN group_members gm ON gm.group_id=p.group_id WHERE gm.app_user_id=$1 AND p.id=$2",[context.appUserId,id]); if(!base.rowCount)return json(res,404,{error:"pool not found"}); const band=Number(p.get("quality_band")),target=p.get("target_scu")===''?null:Number(p.get("target_scu")); if(!Number.isInteger(band)||band<1||band>8||(!Number.isFinite(target)&&target!==null))return json(res,400,{error:"invalid resource"}); const r=await pool.query("INSERT INTO mining_pool_resources(pool_id,material_name,quality_band,target_scu) VALUES($1,$2,$3,$4) RETURNING id",[id,p.get("material_name")?.trim(),band,target]); return json(res,201,{ok:true,id:r.rows[0].id});
    };
    const miningPoolActionMatch=url.pathname.match(/^\/api\/mining-pools\/([^/]+)\/(resources|close)$/);
    if (req.method === "POST" && miningPoolActionMatch) {
      const id=miningPoolActionMatch[1],action=miningPoolActionMatch[2];
      if(action==='close')return handleMiningPoolClose(req,res,url,id);
      return handleMiningPoolResourceCreate(req,res,url,id);
    }
    const handleMiningContributionCreate = async (req, res, url, rid) => { const context=await getSessionContext(req);if(!context?.appUserId)return json(res,401,{error:"login required"});const p=new URLSearchParams(await readBody(req)),q=Number(p.get("quality_value")),qty=Number(p.get("quantity_scu"));const band=Number(p.get("quality_band"));if(!Number.isFinite(q)||qualityBand(q)!==band||!Number.isFinite(qty)||qty<=0)return json(res,400,{error:"quality or quantity invalid"});const r=await pool.query("INSERT INTO mining_pool_contributions(pool_resource_id,user_id,quantity_scu,quality_value,status,source_location,note,deposited_at,in_refinery,refinery_station) SELECT $1,$2,$3,$4,$5,$6,$7,CASE WHEN $5='deposited' THEN now() END,$8,$9 FROM mining_pool_resources r JOIN mining_pools p ON p.id=r.pool_id WHERE r.id=$1 AND p.status='open' AND EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=p.group_id AND gm.app_user_id=$2) RETURNING id",[rid,context.appUserId,qty,q,p.get("status")==='deposited'?'deposited':'reported',p.get("source")||null,p.get("note")||null,p.get("in_refinery")==='on',p.get("refinery_station")||null]);if(!r.rowCount)return json(res,403,{error:"pool closed or inaccessible"});return json(res,201,{ok:true,id:r.rows[0].id}); };
    if (req.method === "POST" && url.pathname.match(/^\/api\/mining-pools\/resources\/[^/]+\/contributions$/)) {
      const rid=url.pathname.split("/")[4];
      return handleMiningContributionCreate(req, res, url, rid);
    }
    const handleMiningContributionStatusUpdate = async (req, res, url, id) => { const context=await getSessionContext(req);if(!context?.appUserId)return json(res,401,{error:"login required"});const r=await pool.query("UPDATE mining_pool_contributions c SET status='deposited',deposited_at=now() WHERE c.id=$1 AND c.status='reported' AND c.user_id=$2 AND EXISTS(SELECT 1 FROM mining_pool_resources r JOIN mining_pools p ON p.id=r.pool_id JOIN group_members gm ON gm.group_id=p.group_id WHERE r.id=c.pool_resource_id AND p.status='open' AND gm.app_user_id=$2) RETURNING c.id",[id,context.appUserId]);if(!r.rowCount)return json(res,403,{error:"contribution cannot be deposited"});return json(res,200,{ok:true}); };
    if (req.method === "PATCH" && url.pathname.match(/^\/api\/mining-pools\/contributions\//)) {
      const id=url.pathname.split("/").pop();
      return handleMiningContributionStatusUpdate(req, res, url, id);
    }

    if (req.method === "POST" && url.pathname === "/api/orders") {
      const context = await getSessionContext(req); if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const current = await getCurrentAppUser(req); const p = new URLSearchParams(await readBody(req)); const groupId=p.get("group_id")||""; const material=p.get("material_name")?.trim()||""; const qty=Number(p.get("required_quantity"));
      if (!/^[0-9a-f-]{36}$/i.test(groupId)||!validText(material,120)||!Number.isFinite(qty)||qty<=0) return json(res,400,{error:"invalid order"});
      const access=await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND app_user_id=$2",[groupId,context.appUserId]); if(!access.rowCount)return json(res,403,{error:"group member required"});
      const result=await pool.query("INSERT INTO material_orders (order_number,group_id,created_by,blueprint_tag,material_name,required_quantity,quantity_unit,required_quality,note) VALUES ($1||'-'||to_char(now(), 'YYYY')||'-'||lpad(nextval('material_order_number_seq')::text, 4, '0'),$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,order_number,group_id,material_name,required_quantity,quantity_unit,required_quality",[materialOrderCode(material),groupId,context.appUserId,p.get("blueprint_tag")||null,material,qty,p.get("quantity_unit")||"SCU",p.get("required_quality")||null,p.get("note")||null]); await pool.query("INSERT INTO app_notifications (app_user_id,kind,title,message,order_id) SELECT gm.app_user_id,'order_created',$1,$2,$3 FROM group_members gm WHERE gm.group_id=$4 AND gm.app_user_id<>$5",["NEW ORDER "+result.rows[0].order_number,material+" · "+qty+" "+(p.get("quantity_unit")||"SCU"),result.rows[0].id,groupId,context.appUserId]); const creator=await pool.query("SELECT g.name AS group_name,COALESCE(u.verselink_name,u.display_name) AS creator_name,CASE WHEN u.profile_public THEN '/profile/'||u.id::text ELSE null END AS creator_profile_path FROM blueprint_groups g JOIN app_users u ON u.id=$1 WHERE g.id=$2",[context.appUserId,groupId]); if(p.get("announce_discord")==="1") void notifyDiscordOrderCreated({order:result.rows[0],groupName:creator.rows[0]?.group_name,creatorName:creator.rows[0]?.creator_name||"Unbekannt",creatorProfilePath:creator.rows[0]?.creator_profile_path}); logger.info("order.created", { group_id: groupId, order_id: result.rows[0].id, amount_scu: qty }, requestLogContext(req, current)); return json(res,201,{ok:true,id:result.rows[0].id,order_number:result.rows[0].order_number});
    }

    if (req.method === "POST" && url.pathname === "/api/orders/action") {
      const context=await getSessionContext(req); if(!context?.appUserId)return json(res,401,{error:"login required"}); const current=await getCurrentAppUser(req); const p=new URLSearchParams(await readBody(req)); const id=p.get("id")||""; const action=p.get("action")||"";
      const order=await pool.query("SELECT o.*,gm.role FROM material_orders o JOIN group_members gm ON gm.group_id=o.group_id WHERE o.id=$1 AND gm.app_user_id=$2",[id,context.appUserId]); if(!order.rowCount)return json(res,404,{error:"order not found"}); const o=order.rows[0];
      if(action==="claim"){if(o.status!=="open")return json(res,409,{error:"order not open"});await pool.query("UPDATE material_orders SET status='claimed',assigned_to=$1 WHERE id=$2",[context.appUserId,id]);if(o.created_by!==current?.id)await pool.query("INSERT INTO app_notifications (app_user_id,kind,title,message,order_id) VALUES ($1,'order_claimed',$2,$3,$4)",[o.created_by,"ORDER CLAIMED "+o.order_number,(current?.verselink_name||current?.display_name||"A member")+" · "+o.material_name,id]);}
      else if(action==="report"){const qty=Number(p.get("delivered_quantity"));if(!Number.isFinite(qty)||qty<=0)return json(res,400,{error:"invalid quantity"});if(["completed","cancelled"].includes(o.status))return json(res,409,{error:"order is not open for delivery"});if(qty>Math.max(Number(o.required_quantity)-Number(o.delivered_quantity||0),0))return json(res,400,{error:"delivery exceeds remaining quantity"});const client=await pool.connect();try{await client.query("BEGIN");await client.query("INSERT INTO material_order_deliveries (order_id,delivered_by,delivered_quantity,delivered_quality) VALUES ($1,$2,$3,$4)",[id,context.appUserId,qty,p.get("delivered_quality")||null]);const totalResult=await client.query("SELECT COALESCE(SUM(delivered_quantity),0) AS total FROM material_order_deliveries WHERE order_id=$1",[id]);const total=Number(totalResult.rows[0].total||0);const nextStatus=total>=Number(o.required_quantity)?"completed":"reported";await client.query("UPDATE material_orders SET status=$1,delivered_quantity=$2,delivered_quality=$3,completed_at=CASE WHEN $1='completed' THEN now() ELSE NULL END WHERE id=$4",[nextStatus,total,p.get("delivered_quality")||null,id]);if(nextStatus==="completed"&&o.status!=="completed")await client.query("INSERT INTO app_notifications (app_user_id,kind,title,message,order_id) VALUES ($1,'order_completed',$2,$3,$4)",[o.created_by,"ORDER COMPLETED "+o.order_number,o.material_name+" · "+total+" "+o.quantity_unit,id]);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error}finally{client.release();}}
      else if(action==="complete"){if(!current?.is_admin&&o.created_by!==current?.id)return json(res,403,{error:"creator or app admin required"});if(Number(o.delivered_quantity||0)<Number(o.required_quantity||0))return json(res,409,{error:"required quantity not reached"});await pool.query("UPDATE material_orders SET status='completed',completed_at=now() WHERE id=$1",[id]);}
      else if(action==="hide"){if(!current?.is_admin&&o.created_by!==current?.id)return json(res,403,{error:"creator or app admin required"});await pool.query("UPDATE material_orders SET hidden_at=now() WHERE id=$1",[id]);}
      else if(action==="cancel"){if(!current?.is_admin&&o.created_by!==current?.id)return json(res,403,{error:"creator or app admin required"});await pool.query("UPDATE material_orders SET status='cancelled' WHERE id=$1",[id]);}
      else return json(res,400,{error:"invalid action"}); return json(res,200,{ok:true});
    }

    if (req.method === "GET" && url.pathname === "/api/notifications") {
      const context = await getSessionContext(req); if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const result = await pool.query("SELECT n.id,n.kind,n.title,n.message,n.order_id,n.created_at,n.read_at,o.order_number,o.group_id FROM app_notifications n LEFT JOIN material_orders o ON o.id=n.order_id WHERE n.app_user_id=$1 ORDER BY n.created_at DESC LIMIT 50", [context.appUserId]);
      return json(res, 200, { notifications: result.rows });
    }

    if (req.method === "POST" && url.pathname === "/api/notifications/read") {
      const context = await getSessionContext(req); if (!context?.appUserId) return json(res, 401, { error: "login required" }); const id = new URLSearchParams(await readBody(req)).get("id") || "";
      await pool.query("UPDATE app_notifications SET read_at=now() WHERE id=$1 AND app_user_id=$2", [id, context.appUserId]); return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/admin/logging") {
      const current = await getCurrentAppUser(req);
      if (!current?.is_admin) return json(res, 403, { error: "admin required" });
      return json(res, 200, logger.getState());
    }

    if (req.method === "PUT" && url.pathname === "/api/admin/logging") {
      const current = await getCurrentAppUser(req);
      if (!current?.is_admin) return json(res, 403, { error: "admin required" });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON body" }); }
      const context = requestLogContext(req, current);
      if (body?.reset === true) {
        logger.resetRuntimeOverride(context);
        return json(res, 200, logger.getState());
      }
      try {
        logger.setRuntimeOverride(body?.level, Number(body?.reset_after_minutes), context);
        return json(res, 200, logger.getState());
      } catch (error) {
        logger.warn("admin.log_level.invalid", { error: error.message }, context);
        return json(res, 400, { error: error.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/admin/state") {
      const current = await getCurrentAppUser(req); if (!current?.is_admin) return json(res, 403, { error: "app admin required" });
      const [groups, users, tokenStats] = await Promise.all([
        pool.query(`SELECT g.id, g.name, g.created_at, COALESCE(json_agg(json_build_object('user_id',u.id,'name',COALESCE(u.verselink_name,u.display_name),'profile_path',CASE WHEN u.profile_public AND u.account_status='active' THEN '/profile/' || u.id::text ELSE NULL END,'role',gm.role,'status',u.account_status) ORDER BY COALESCE(u.verselink_name,u.display_name)) FILTER (WHERE u.id IS NOT NULL),'[]') AS members FROM blueprint_groups g LEFT JOIN group_members gm ON gm.group_id=g.id LEFT JOIN app_users u ON u.id=gm.app_user_id GROUP BY g.id ORDER BY g.name`),
        pool.query("SELECT u.id, COALESCE(u.verselink_name, p.display_name, c.user_handle, u.display_name) AS display_name, CASE WHEN u.profile_public AND u.account_status='active' THEN '/profile/' || u.id::text ELSE NULL END AS profile_path, u.is_admin, u.account_status, u.created_at FROM app_users u LEFT JOIN scmdb_connections c ON c.app_user_id=u.id LEFT JOIN scmdb_profiles p ON p.token_hash=c.token_hash ORDER BY display_name"),
        pool.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE c.app_user_id IS NOT NULL AND COALESCE(u.account_status, 'active') = 'active')::int AS active, COUNT(*) FILTER (WHERE c.app_user_id IS NULL AND c.scmdb_user_id IS NULL)::int AS unconfigured, COUNT(*) FILTER (WHERE c.last_seen_at < now() - interval '30 days')::int AS stale, (SELECT COUNT(*)::int FROM revoked_sink_tokens) AS revoked FROM scmdb_connections c LEFT JOIN app_users u ON u.id = c.app_user_id")
      ]); return json(res, 200, { groups: groups.rows, users: users.rows, token_stats: tokenStats.rows[0] });
    }
    if (req.method === "GET" && url.pathname === "/api/admin/uex-sync") { const current=await getCurrentAppUser(req);if(!current?.is_admin)return json(res,403,{error:"admin required"});const result=await pool.query("SELECT last_sync_at FROM uex_sync_state WHERE id=true");return json(res,200,{...uexSyncState,lastSyncAt:result.rows[0]?.last_sync_at||uexSyncState.lastSyncAt}); }
    if (req.method === "POST" && url.pathname === "/api/admin/uex-sync") { const current=await getCurrentAppUser(req);if(!current?.is_admin)return json(res,403,{error:"admin required"});try{return json(res,200,await syncUexData())}catch(error){logger.warn("uex.sync.failed",{error:error.message},requestLogContext(req,current));return json(res,502,{error:"UEX sync failed"});} }

    if (req.method === "POST" && url.pathname === "/api/admin/tokens/cleanup") {
      const current = await getCurrentAppUser(req); if (!current?.is_admin) return json(res, 403, { error: "app admin required" });
      const removed = await pool.query("DELETE FROM scmdb_connections WHERE app_user_id IS NULL AND scmdb_user_id IS NULL AND last_seen_at < now() - interval '24 hours' RETURNING token_hash");
      logger.info("admin.tokens.cleaned", { removed: removed.rowCount }, requestLogContext(req, current));
      return json(res, 200, { ok: true, deleted: removed.rowCount });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/orders/clear") {
      const current = await getCurrentAppUser(req); if (!current?.is_admin) return json(res, 403, { error: "app admin required" });
      const client = await pool.connect();
      try { await client.query("BEGIN"); const removed = await client.query("SELECT COUNT(*)::int AS count FROM material_orders"); await client.query("DELETE FROM app_notifications WHERE order_id IS NOT NULL"); await client.query("DELETE FROM material_orders"); await client.query("COMMIT"); return json(res, 200, { ok: true, deleted: removed.rows[0].count }); }
      catch (error) { await client.query("ROLLBACK"); return json(res, 500, { error: "unable to clear orders" }); }
      finally { client.release(); }
    }

    if (req.method === "POST" && url.pathname === "/api/admin/notifications/send") {
      const current = await getCurrentAppUser(req); if (!current?.is_admin) return json(res, 403, { error: "app admin required" });
      const params = new URLSearchParams(await readBody(req)); const title = params.get("title")?.trim() || "", message = params.get("message")?.trim() || "";
      if (!validText(title, 160) || !validText(message, 2000)) return json(res, 400, { error: "title and message are required" });
      const result = await pool.query("INSERT INTO app_notifications (app_user_id,kind,title,message) SELECT id,'admin_broadcast',$1,$2 FROM app_users WHERE account_status='active' RETURNING id", [title, message]);
      return json(res, 200, { ok: true, sent: result.rowCount });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/notifications/clear") {
      const current = await getCurrentAppUser(req); if (!current?.is_admin) return json(res, 403, { error: "app admin required" });
      const removed = await pool.query("DELETE FROM app_notifications RETURNING id");
      return json(res, 200, { ok: true, deleted: removed.rowCount });
    }

    const refreshPrefix = "/api/admin/reference-blueprints/";
    if (req.method === "POST" && url.pathname.startsWith(refreshPrefix) && url.pathname.endsWith("/refresh")) {
      const current = await getCurrentAppUser(req);
      if (!current?.is_admin) return json(res, 403, { error: "app admin required" });
      const blueprintId = decodeURIComponent(url.pathname.slice(refreshPrefix.length, -"/refresh".length));
      if (!validText(blueprintId, 300) || blueprintId.includes("/")) return json(res, 400, { error: "invalid blueprint id" });
      try {
        const result = await refreshReferenceBlueprint(blueprintId);
        if (!result) return json(res, 404, { error: "blueprint not found" });
        console.log(`[reference] refresh; tag=${blueprintId}; ${result.matched ? "matched" : "no match"}`);
        return json(res, 200, { ok: true, blueprint_id: result.tag, previous: { source_url: result.previous.source_url, image_url: result.previous.image_url }, current: { source_url: result.current.source_url, image_url: result.current.image_url }, matched: result.matched, refreshed_at: result.current.image_checked_at });
      } catch (error) {
        console.warn(`[reference] refresh failed; tag=${blueprintId}; reason=${error.message}`);
        return json(res, 502, { error: "reference refresh failed" });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/admin/groups/transfer-owner") {
      const current = await getCurrentAppUser(req); if (!current?.is_admin) return json(res, 403, { error: "app admin required" });
      const params = new URLSearchParams(await readBody(req)); const groupId = params.get("group_id"), memberId = params.get("member_id");
      const client = await pool.connect(); try { await client.query("BEGIN"); const member = await client.query("SELECT 1 FROM group_members WHERE group_id=$1 AND app_user_id=$2", [groupId, memberId]); if (!member.rowCount) throw new Error("member not found"); await client.query("UPDATE group_members SET role=CASE WHEN app_user_id=$2 THEN 'owner' ELSE 'member' END WHERE group_id=$1", [groupId, memberId]); await client.query("COMMIT"); return json(res, 200, { ok: true }); } catch (error) { await client.query("ROLLBACK"); return json(res, 400, { error: error.message }); } finally { client.release(); }
    }

    if (req.method === "POST" && url.pathname === "/api/admin/users/status") {
      const current = await getCurrentAppUser(req); if (!current?.is_admin) return json(res, 403, { error: "app admin required" });
      const params = new URLSearchParams(await readBody(req)); const userId = params.get("user_id"), status = params.get("status");
      if (!/^[0-9a-f-]{36}$/i.test(userId || "") || !["active", "blocked", "deleted"].includes(status)) return json(res, 400, { error: "invalid user or status" });
      await pool.query("UPDATE app_users SET account_status=$1 WHERE id=$2 AND id<>$3", [status, userId, current.id]);
      if (status !== "active") await pool.query("DELETE FROM dashboard_sessions WHERE app_user_id=$1", [userId]);
      return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/admin/users/delete") {
      const current = await getCurrentAppUser(req); if (!current?.is_admin) return json(res, 403, { error: "app admin required" });
      const userId = new URLSearchParams(await readBody(req)).get("user_id");
      if (!/^[0-9a-f-]{36}$/i.test(userId || "") || userId === current.id) return json(res, 400, { error: "invalid user" });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM dashboard_sessions WHERE app_user_id = $1", [userId]);
        await client.query("DELETE FROM blueprint_groups WHERE created_by = $1", [userId]);
        await client.query("DELETE FROM group_members WHERE app_user_id = $1", [userId]);
        await client.query("INSERT INTO revoked_sink_tokens (token_hash, reason) SELECT token_hash, 'user deleted' FROM scmdb_connections WHERE app_user_id = $1 ON CONFLICT (token_hash) DO NOTHING", [userId]);
        await client.query("DELETE FROM scmdb_connections WHERE app_user_id = $1", [userId]);
        const deleted = await client.query("DELETE FROM app_users WHERE id = $1 RETURNING id", [userId]);
        if (!deleted.rowCount) throw new Error("user not found");
        await client.query("COMMIT"); return json(res, 200, { ok: true });
      } catch (error) { await client.query("ROLLBACK"); return json(res, 400, { error: error.message }); } finally { client.release(); }
    }

    const publicProfileApiMatch = url.pathname.match(/^\/api\/public-profiles\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && publicProfileApiMatch) {
      const result = await pool.query("SELECT COALESCE(verselink_name,display_name) AS display_name,rsi_profile_url,discord_name,rsi_avatar_url,rsi_handle,rsi_citizen_record,rsi_organization,rsi_enlisted,rsi_fluency FROM app_users WHERE id=$1 AND profile_public=true AND account_status='active'", [publicProfileApiMatch[1]]);
      if (!result.rowCount) return json(res, 404, { error: "profile not found" });
      return json(res, 200, { profile: result.rows[0] });
    }

    const publicProfileMatch = url.pathname.match(/^\/profile\/([0-9a-f-]{36})$/i);
    if (req.method === "GET" && publicProfileMatch) {
      const result = await pool.query("SELECT COALESCE(verselink_name,display_name) AS display_name,rsi_profile_url,discord_name,rsi_avatar_url,rsi_handle,rsi_citizen_record,rsi_organization,rsi_enlisted,rsi_fluency FROM app_users WHERE id=$1 AND profile_public=true AND account_status='active'", [publicProfileMatch[1]]);
      if (!result.rowCount) return json(res, 404, { error: "profile not found" });
      const profile = result.rows[0];
      const rsi = profile.rsi_profile_url ? `<a href="${htmlEscape(profile.rsi_profile_url)}" target="_blank" rel="noreferrer">OPEN RSI PROFILE ↗</a>` : "Not provided";
      const discord = profile.discord_name ? htmlEscape(profile.discord_name) : "Not provided";
      const rsiDetails = [["HANDLE", profile.rsi_handle], ["CITIZEN RECORD", profile.rsi_citizen_record], ["MAIN ORGANIZATION", profile.rsi_organization], ["ENLISTED", profile.rsi_enlisted], ["FLUENCY", profile.rsi_fluency]].filter(([, value]) => value);
      const rsiDossier = profile.rsi_avatar_url || rsiDetails.length ? `<section class="rsi-dossier">${profile.rsi_avatar_url ? `<img src="${htmlEscape(profile.rsi_avatar_url)}" alt="RSI avatar for ${htmlEscape(profile.rsi_handle || profile.display_name)}" referrerpolicy="no-referrer">` : ""}<div><strong>RSI CITIZEN DOSSIER</strong><dl>${rsiDetails.map(([label, value]) => `<div><dt>${label}</dt><dd>${htmlEscape(value)}</dd></div>`).join("")}</dl></div></section>` : "";
      const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(profile.display_name)} · VerseLink</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:#020912;color:#eafaff;font:15px Arial,sans-serif}main{width:min(560px,100%);padding:34px;border:1px solid #137b9f;background:linear-gradient(135deg,rgba(25,70,90,.22),rgba(1,9,16,.88));box-shadow:0 0 30px rgba(33,207,255,.18)}.profile-brand{display:flex;align-items:center;gap:16px;margin-bottom:24px}.profile-brand img{width:72px;height:72px;object-fit:contain;filter:drop-shadow(0 0 10px rgba(33,207,255,.35))}.profile-brand-copy{min-width:0}.kicker{color:#76abc0;font-size:11px;letter-spacing:.16em}h1{margin:8px 0 0;color:#c5f7ff;letter-spacing:.08em}.field{padding:16px 0;border-top:1px solid #137b9f}.field strong{display:block;margin-bottom:7px;color:#76abc0;font-size:11px;letter-spacing:.14em}.field a{color:#21cfff}footer{margin-top:28px;color:#76abc0;font-size:11px;letter-spacing:.1em}@media(max-width:460px){main{padding:26px}.profile-brand{gap:12px}.profile-brand img{width:58px;height:58px}h1{font-size:28px}}</style></head><body><main><header class="profile-brand"><img src="/assets/verselink.png" alt="VerseLink"><div class="profile-brand-copy"><div class="kicker">VERSELINK PUBLIC PROFILE</div><h1>${htmlEscape(profile.display_name)}</h1></div></header><div class="field"><strong>RSI PROFILE</strong>${rsi}</div><div class="field"><strong>DISCORD</strong>${discord}</div><footer>Shared voluntarily by this VerseLink member.</footer></main></body></html>`;
      const renderedPage = rsiDossier ? page.replace("</style>", ".rsi-dossier{display:flex;gap:16px;padding:16px 0;border-top:1px solid #137b9f}.rsi-dossier>img{width:82px;height:82px;object-fit:cover;border:1px solid #137b9f}.rsi-dossier strong,.rsi-dossier dt{color:#76abc0;font-size:11px;letter-spacing:.14em}.rsi-dossier dl{margin:10px 0 0;display:grid;gap:8px}.rsi-dossier dl div{display:grid;gap:2px}.rsi-dossier dt{font-size:9px}.rsi-dossier dd{margin:0;color:#eafaff}@media(max-width:460px){.rsi-dossier>img{width:66px;height:66px}}</style>").replace('<div class="field"><strong>RSI PROFILE</strong>', `${rsiDossier}<div class="field"><strong>RSI PROFILE</strong>`) : page;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(renderedPage);
    }

    if (req.method === "GET" && ["/", "/index.html"].includes(url.pathname)) {
      res.writeHead(308, { location: "/mobiglass" });
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/mobiglass") {
      let html = applyVerseLinkBranding(await readFile(join(publicDir, "mobiglass.html"), "utf8"))
        .replaceAll("fetch('/changelog')", "fetch('/api/changelog')")
        .replaceAll("AUFTRÄGE", "ORDERS")
        .replaceAll("Die wichtigsten Änderungen am Blueprint Inventory.", "The latest changes to VerseLink.")
        .replaceAll("Changelog-Daten sind momentan nicht verfügbar.", "Changelog data is currently unavailable.")
        .replace(
          '<button data-view="inventory" title="Inventory"><i class="nav-icon" style="--icon:url(\'/assets/icons/blueprint-inventory.svg\')"></i></button>',
          '<button data-view="inventory" title="Inventory"><i class="nav-icon" style="--icon:url(\'/assets/icons/inventory-cube.svg?v=1\')"></i></button>'
        )
        .replaceAll("/assets/icons/blueprint-inventory.svg", "/assets/icons/blueprint-schematic.svg?v=2")
        .replace("</head>", '<style>.theme-option[data-theme-choice="mobiglass"] .swatch{background:#21cfff}.theme-option[data-theme-choice="hector"] .swatch{background:#f3a72e}.theme-option[data-theme-choice="pyro"] .swatch{background:#f04b3b}</style><script src="/js/inventory-icon-fix.js" defer></script><script src="/js/changelog-mobiglass.js" defer></script><style>.github-release{margin-top:18px;padding:14px 16px;border-top:1px solid var(--border);background:rgba(0,0,0,.12);color:var(--muted);line-height:1.5}.github-release>strong{display:block;color:var(--accent);font-size:11px;letter-spacing:.12em}.github-release p{margin:10px 0}.github-release a{color:var(--bright);font-size:11px;letter-spacing:.08em}.github-release-notes{margin:10px 0;padding-left:18px}.github-release-notes li{margin:4px 0}.changelog-actions{display:flex;justify-content:center;margin-top:20px}.changelog-actions button{width:auto;padding:11px 16px;border:1px solid var(--accent);background:var(--panel2);color:var(--bright);font:inherit;letter-spacing:.1em;cursor:pointer}.changelog-actions button:hover,.changelog-actions button:focus-visible{background:var(--accent);color:var(--panel2);outline:0}</style></head>')
        .replace('title="VerseLink" aria-label="Open VerseLink"', 'title="Blueprint Inventory" aria-label="Open Blueprint Inventory"')
        .replace('<div class="brand"><div class="brand-mark"></div>', '<a class="brand brand-home" href="/mobiglass" aria-label="VerseLink Home"><div class="brand-mark"></div>')
        .replace('</div><div class="status-row"', '</a><div class="status-row"')
        .replace("{{APP_VERSION}}", appVersion)
        .replace("SC Blueprint Inventory is a tool for managing blueprints, tracking materials and coordinating orders within your organization.", "SC Blueprint Inventory is a tool for managing blueprints, tracking materials and coordinating orders within your organization. <br><a href=\"/about\" class=\"about-more\">FIND OUT MORE →</a>")
        .replace("<p>SC Blueprint Inventory is a tool for managing blueprints, tracking materials and coordinating orders within your organization.</p>", "<p>SC Blueprint Inventory is a tool for managing blueprints, tracking materials and coordinating orders within your organization.<br><a href=\"/about\" class=\"about-more\">FIND OUT MORE →</a></p>")
        .replace("</p></aside></div>'+apps()", "</p><a href=\"/about\" class=\"about-more\">FIND OUT MORE →</a></aside></div>'+apps()")
        .replace('<button type="button" data-view="changelog" title="Changelog"><i class="nav-icon" style="--icon:url(\'/assets/icons/info.svg\')"></i></button>', '<button class="admin-nav" data-view="admin" title="Administration" aria-label="Administration" hidden><i class="nav-icon" style="--icon:url(\'/assets/icons/lock.svg\')"></i></button><button type="button" data-view="about" title="About VerseLink" aria-label="About VerseLink"><i class="nav-icon" style="--icon:url(\'/assets/icons/info.svg\')"></i></button>')
        .replace("const views=new Set(['home','inventory','orders','groups','trademax','changelog']);", "const views=new Set(['home','inventory','orders','groups','trademax','changelog','miningpool','about','admin','profile']);")
        .replace("const views=new Set(['home','inventory','orders','groups','trademax','material','changelog']);", "const views=new Set(['home','inventory','orders','groups','trademax','material','changelog','miningpool','about','admin','profile']);")
        .replace('<button type="button" data-view="about" title="About VerseLink" aria-label="About VerseLink"><i class="nav-icon" style="--icon:url(\'/assets/icons/info.svg\')"></i></button>', '<button class="admin-nav" data-view="admin" title="Administration" aria-label="Administration" hidden><i class="nav-icon" style="--icon:url(\'/assets/icons/lock.svg\')"></i></button><button type="button" data-view="about" title="About VerseLink" aria-label="About VerseLink"><i class="nav-icon" style="--icon:url(\'/assets/icons/info.svg\')"></i></button>')
        .replace("function setView(v){if(!views.has(v))", "function setView(v){if(v==='admin'&&(!user||!user.is_admin))v='home';if(!views.has(v))")
        .replace("function setView(v){if(!views.has(v))", "function setView(v){content.classList.remove('about-active');if(!views.has(v))")
        .replace("else if(v==='changelog')changelog();else", "else if(v==='changelog')changelog();else if(v==='orders')import('/js/orders-mobiglass.js').then(module=>module.mount());else if(v==='miningpool')import('/js/material-inventory-mobiglass.js').then(module=>module.mount());else if(v==='about')window.renderVerseLinkAbout(content,user);else if(v==='admin')import('/js/admin-mobiglass.js').then(module=>module.mount(content));else if(v==='profile')import('/js/profile-mobiglass.js').then(module=>module.mount(content));else")
        .replace("user=m.user||null;document.body.classList.remove('session-pending');", "user=m.user||null;document.body.dataset.sessionAuthenticated=user?'true':'false';document.querySelector('.admin-nav').hidden=!Boolean(user?.is_admin);document.body.classList.remove('session-pending');")
        .replace("user=m.user;setView('home')", "user=m.user;document.body.dataset.sessionAuthenticated='true';setView('home')")
        .replace("user=null;setView('home')", "user=null;document.body.dataset.sessionAuthenticated='false';document.querySelector('.admin-nav').hidden=true;setView('home')")
.replace("</head>", '<style>.brand-home{text-decoration:none;color:inherit}.home-apps .app.locked{cursor:not-allowed}</style><script>(()=>{document.addEventListener("click",event=>{const material=event.target.closest(\'[data-app="material"],[aria-label="Open Material Inventory"]\');if(material&&document.body.dataset.sessionAuthenticated!=="true"){event.preventDefault();event.stopImmediatePropagation()}},true)})()</script><link rel="icon" type="image/png" href="/favicon.png?v=verselink"><link rel="apple-touch-icon" href="/assets/verselink.png"><link rel="manifest" href="/manifest.webmanifest"><script src="/js/about-mobiglass.js"></script><script type="module" src="/js/alias-mobiglass.js"></script><script type="module" src="/js/profile-mobiglass.js"></script><script type="module" src="/js/mobiglass-auth-entry.js"></script><script type="module" src="/js/notifications-mobiglass.js"></script><script type="module" src="/js/orders-core.js"></script><script type="module" src="/js/orders-mobiglass.js"></script><script type="module" src="/js/inventory-core.js"></script><script type="module" src="/js/inventory-mobiglass.js"></script><script type="module" src="/js/groups-core.js"></script><script type="module" src="/js/groups-mobiglass.js"></script><script type="module" src="/js/trading-core.js"></script><script type="module" src="/js/trading-mobiglass.js"></script><script type="module" src="/js/inventory-detail-clean.js"></script></head>');
      html = html.replace("</head>", '<script type="module" src="/js/version-watch.js"></script></head>');
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(html);
    }

    if (req.method === "GET" && url.pathname === "/api/changelog") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      return res.end(changelogSource);
    }

    if (req.method === "GET" && url.pathname === "/api/version") {
      return json(res, 200, { version: appVersion, build: appCommit, environment: appEnvironment });
    }

    if (req.method === "GET" && url.pathname.startsWith("/assets/icons/")) {
      const fileName = url.pathname.slice("/assets/icons/".length);
      if (!/^[a-z0-9-]+\.svg$/.test(fileName)) return json(res, 404, { error: "not found" });
      const content = await readFile(join(publicDir, "assets", "icons", fileName));
      res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "public, max-age=86400" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/assets/themes/stanton/stanton.png") {
      const content = await readFile(join(publicDir, "assets", "themes", "stanton", "stanton.png"));
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return res.end(content);
    }
    if (req.method === "GET" && url.pathname === "/assets/themes/nyx/nyx-levski-bg.png") {
      const content = await readFile(join(publicDir, "assets", "themes", "nyx", "nyx-levski-bg.png"));
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return res.end(content);
    }
    if (req.method === "GET" && url.pathname === "/about") { const html = (await readFile(join(publicDir, "about.html"), "utf8")).replace("</style>", ".wip{font-size:.55em;color:var(--accent);border:1px solid var(--accent);padding:3px 7px;letter-spacing:.12em;vertical-align:middle}h1.about-title{display:flex;align-items:center;gap:18px}h1.about-title img{width:140px;height:140px;object-fit:contain}@media(max-width:600px){h1.about-title{align-items:flex-start;gap:10px}h1.about-title img{width:96px;height:96px}}</style>").replace("<h1>🚀 VERSELINK – STAR CITIZEN COMPANION</h1>", "<h1 class=\"about-title\"><img src=\"/assets/verselink.png\" alt=\"VerseLink\">🚀 VERSELINK – STAR CITIZEN COMPANION</h1>").replace("🎒 PERSONAL INVENTORY</h2>", "🎒 PERSONAL INVENTORY <small class=\"wip\">WIP</small></h2>").replace("🔄 SHARING &amp; TRADING</h2>", "🔄 SHARING &amp; TRADING <small class=\"wip\">WIP</small></h2>"); res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" }); return res.end(html); }

    if (req.method === "GET" && url.pathname === "/assets/themes/pyro/pyro-checkmate-bg.png") {
      const content = await readFile(join(publicDir, "assets", "themes", "pyro", "pyro-checkmate-bg.png"));
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/assets/backgrounds/hector-workshop-public.png") {
      const content = await readFile(join(publicDir, "assets", "backgrounds", "hector-workshop-public.png"));
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/assets/orders/orders.png") {
      const content = await readFile(join(publicDir, "assets", "orders", "orders.png"));
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return res.end(content);
    }

    if (req.method === "GET" && ["/assets/apps/inventory.png", "/assets/apps/orders.png", "/assets/apps/groups.png", "/assets/apps/admin_center.png", "/assets/apps/blueprints-empty.png", "/assets/apps/blueprint-image-unavailable.png", "/assets/apps/materials.png"].includes(url.pathname)) {
      const content = await readFile(join(publicDir, "assets", "apps", url.pathname.split("/").pop()));
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/js/orders-core.js") {
      const content = await readFile(join(publicDir, "js", "orders-core.js"));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/js/orders-mobiglass.js") {
      const content = await readFile(join(publicDir, "js", "orders-mobiglass.js"));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/js/mining-pools-mobiglass.js") {
      const content = await readFile(join(publicDir, "js", "mining-pools-mobiglass.js"));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/js/material-inventory-mobiglass.js") {
      const content = await readFile(join(publicDir, "js", "material-inventory-mobiglass.js"));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/js/mining-pools-core.js") {
      const content = await readFile(join(publicDir, "js", "mining-pools-core.js"));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }

    if (req.method === "GET" && ["/js/notifications-core.js", "/js/notifications-mobiglass.js", "/js/about-mobiglass.js", "/js/changelog-mobiglass.js"].includes(url.pathname)) {
      const content = (await readFile(join(publicDir, "js", url.pathname.split("/").pop()), "utf8"))
        .replaceAll("{{APP_COMMIT}}", htmlEscape(appCommit))
        .replaceAll("{{APP_ENVIRONMENT}}", htmlEscape(appEnvironment))
        .replaceAll("{{APP_VERSION}}", htmlEscape(appVersion));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/js/inventory-core.js") {
      const content = await readFile(join(publicDir, "js", "inventory-core.js"));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/js/inventory-mobiglass.js") {
      const content = await readFile(join(publicDir, "js", "inventory-mobiglass.js"));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/js/groups-core.js") {
      const content = await readFile(join(publicDir, "js", "groups-core.js"));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/js/groups-mobiglass.js") {
      const content = await readFile(join(publicDir, "js", "groups-mobiglass.js"));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/js/groups-classic.js") {
      const content = await readFile(join(publicDir, "js", "groups-classic.js"));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }

    if (req.method === "GET" && ["/js/personalinventory-core.js", "/js/personalinventory-classic.js"].includes(url.pathname)) {
      const content = (await readFile(join(publicDir, "js", url.pathname.slice("/js/".length)), "utf8")).replaceAll("{{APP_COMMIT}}", htmlEscape(appCommit));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }
    if (req.method === "GET" && url.pathname === "/js/personalinventory-qol.js") {
      const content = await readFile(join(publicDir, "js", "personalinventory-qol.js"));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }
    if (req.method === "GET" && url.pathname === "/js/personalinventory-trade.js") {
      const content = await readFile(join(publicDir, "js", "personalinventory-trade.js"));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }

    if (req.method === "GET" && ["/js/about-mobiglass.js", "/js/admin-mobiglass.js", "/js/alias-mobiglass.js", "/js/profile-mobiglass.js", "/js/profile-accent.js", "/js/mobiglass-auth-entry.js", "/js/notifications-mobiglass.js", "/js/version-watch.js", "/js/auth-core.js", "/js/trading-core.js", "/js/trading-classic.js", "/js/trading-mobiglass.js"].includes(url.pathname)) {
      const content = await readFile(join(publicDir, "js", url.pathname.slice("/js/".length)));
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      return res.end(content);
    }

    if (req.method === "GET" && ["/assets/verselink.png", "/favicon.png", "/favicon.ico"].includes(url.pathname)) {
      const content = await readFile(join(publicDir, "assets", "verselink.png"));
      res.writeHead(200, { "content-type": "image/png", "cache-control": url.pathname === "/assets/verselink.png" ? "public, max-age=31536000, immutable" : "no-cache" });
      return res.end(content);
    }
    if (req.method === "GET" && url.pathname === "/assets/themes/mobiglass/mobiglass-blue-logo.png") {
      const content = await readFile(join(publicDir, "assets", "themes", "mobiglass", "mobiglass-blue-logo.png"));
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
      return res.end(content);
    }

    if (req.method === "GET" && ["/manifest.webmanifest", "/sw.js", "/trading-logo.png", "/hector-header.png"].includes(url.pathname)) {
      const file = url.pathname.slice(1);
      const content = await readFile(join(publicDir, file));
      const contentType = url.pathname.endsWith("webmanifest") ? "application/manifest+json" : url.pathname.endsWith(".png") ? "image/png" : "application/javascript";
      res.writeHead(200, { "content-type": contentType, "cache-control": url.pathname === "/hector-header.png" ? "no-cache, max-age=0, must-revalidate" : url.pathname.endsWith(".png") ? "public, max-age=86400" : "no-cache" });
      return res.end(content);
    }

    if (req.method === "GET" && url.pathname === "/api/me") {
      const current = await getCurrentAppUser(req);
      if (!current) return json(res, 401, { error: "login required" });
      const connected = await pool.query("SELECT 1 FROM scmdb_connections WHERE app_user_id=$1 AND connection_status='connected' AND revoked_at IS NULL LIMIT 1", [current.id]);
      return json(res, 200, { user: { id: current.id, display_name: current.display_name, verselink_name: current.verselink_name, scmdb_display_name: current.scmdb_display_name, is_admin: current.is_admin, account_status: current.account_status, accent_color: current.accent_color || null, user_handle: current.user_handle || null }, scmdb_connected: Boolean(connected.rowCount) });
    }

    if (req.method === "POST" && url.pathname === "/api/profile/scmdb/connect") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      if (!scmdbSinkBaseUrl) return json(res, 503, { error: "SCMDB synchronization is not configured on this VerseLink instance." });
      const rawToken = generateScmdbSinkToken();
      const tokenHash = hashToken(rawToken);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`scmdb-connect:${context.appUserId}`]);
        const user = await client.query("SELECT account_status FROM app_users WHERE id=$1 FOR UPDATE", [context.appUserId]);
        if (!user.rowCount || user.rows[0].account_status !== "active") {
          await client.query("ROLLBACK");
          return json(res, 403, { error: "account is not active" });
        }
        const pending = await client.query("SELECT token_hash FROM scmdb_connections WHERE app_user_id=$1 AND connection_status='pending' AND revoked_at IS NULL FOR UPDATE", [context.appUserId]);
        if (pending.rowCount) {
          await client.query("INSERT INTO revoked_sink_tokens (token_hash, reason) SELECT token_hash, 'pending connection replaced' FROM scmdb_connections WHERE app_user_id=$1 AND connection_status='pending' AND revoked_at IS NULL ON CONFLICT (token_hash) DO NOTHING", [context.appUserId]);
          await client.query("UPDATE scmdb_connections SET connection_status='revoked', revoked_at=now() WHERE app_user_id=$1 AND connection_status='pending' AND revoked_at IS NULL", [context.appUserId]);
        }
        await client.query("INSERT INTO scmdb_connections (token_hash, app_user_id, connection_status, connected_at, disconnected_at, revoked_at) VALUES ($1,$2,'pending',NULL,NULL,NULL)", [tokenHash, context.appUserId]);
        await client.query("COMMIT");
        return json(res, 201, { sink_token: rawToken, sink_url: scmdbSinkUrl(scmdbSinkBaseUrl, rawToken), connection_status: "pending" });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`[scmdb-connect] failed; user=${context.appUserId}; reason=${error.message}`);
        return json(res, 500, { error: "unable to create SCMDB connection" });
      } finally {
        client.release();
      }
    }

    if (req.method === "POST" && url.pathname === "/api/profile/scmdb/disconnect") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`scmdb-connect:${context.appUserId}`]);
        await client.query("INSERT INTO revoked_sink_tokens (token_hash, reason) SELECT token_hash, 'SCMDB connection disconnected' FROM scmdb_connections WHERE app_user_id=$1 AND connection_status IN ('pending','connected') AND revoked_at IS NULL ON CONFLICT (token_hash) DO NOTHING", [context.appUserId]);
        const result = await client.query("UPDATE scmdb_connections SET connection_status='revoked', revoked_at=now(), disconnected_at=COALESCE(disconnected_at, now()) WHERE app_user_id=$1 AND connection_status IN ('pending','connected') AND revoked_at IS NULL RETURNING token_hash", [context.appUserId]);
        await client.query("COMMIT");
        return json(res, 200, { ok: true, disconnected: result.rowCount });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error(`[scmdb-connect] disconnect failed; user=${context.appUserId}; reason=${error.message}`);
        return json(res, 500, { error: "unable to disconnect SCMDB" });
      } finally {
        client.release();
      }
    }

    if (req.method === "GET" && url.pathname === "/api/profile/scmdb") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const result = await pool.query("SELECT connection_status AS status, user_handle, connected_at, disconnected_at, first_seen_at, last_seen_at FROM scmdb_connections WHERE app_user_id=$1 ORDER BY first_seen_at DESC", [context.appUserId]);
      return json(res, 200, { connections: result.rows });
    }

    if (req.method === "POST" && url.pathname === "/api/me/recovery-key") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const rateKey = context.appUserId;
      if (!recoveryRotationRateLimit.allow(rateKey)) return tooManyRequests(res);
      const recoveryKey = generateRecoveryToken();
      if (!isRecoveryToken(recoveryKey)) return json(res, 500, { error: "unable to create recovery key" });
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`recovery-key:${context.appUserId}`]);
        const user = await client.query("SELECT account_status FROM app_users WHERE id=$1 FOR UPDATE", [context.appUserId]);
        if (!user.rowCount || user.rows[0].account_status !== "active") {
          await client.query("ROLLBACK");
          return json(res, 403, { error: "account is not active" });
        }
        await client.query("UPDATE auth_recovery_tokens SET revoked_at=now(), last_used_at=now() WHERE app_user_id=$1 AND revoked_at IS NULL", [context.appUserId]);
        await client.query("INSERT INTO auth_recovery_tokens (app_user_id, token_hash) VALUES ($1,$2)", [context.appUserId, hashRecoveryToken(recoveryKey, pepper)]);
        await client.query("COMMIT");
        recoveryRotationRateLimit.clear(rateKey);
        return json(res, 200, { recovery_key: recoveryKey });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }

    if (req.method === "POST" && url.pathname === "/api/profile/verselink-name") {
      const current = await getCurrentAppUser(req); if (!current) return json(res, 401, { error: "login required" });
      const name = (new URLSearchParams(await readBody(req)).get("name") || "").trim();
      if (name && (!validText(name, 50) || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name))) return json(res, 400, { error: "name must be 1-50 letters, numbers, spaces, dots, hyphens or underscores" });
      try {
        const updated = await pool.query("UPDATE app_users SET verselink_name=$1 WHERE id=$2 RETURNING COALESCE(verselink_name,display_name) AS display_name,verselink_name,display_name AS scmdb_display_name,is_admin,account_status", [name || null, current.id]);
        return json(res, 200, { ok: true, user: updated.rows[0] });
      } catch (error) {
        if (error.code === "23505") return json(res, 409, { error: "this VerseLink name is already in use" });
        throw error;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/profile") {
      const current = await getCurrentAppUser(req); if (!current) return json(res, 401, { error: "login required" });
      const result = await pool.query("SELECT id,COALESCE(verselink_name,display_name) AS display_name,verselink_name,display_name AS scmdb_display_name,rsi_profile_url,discord_name,profile_public,accent_color,rsi_avatar_url,rsi_handle,rsi_citizen_record,rsi_organization,rsi_enlisted,rsi_fluency,rsi_profile_synced_at,EXISTS(SELECT 1 FROM auth_recovery_tokens WHERE app_user_id=app_users.id AND revoked_at IS NULL) AS has_recovery_key FROM app_users WHERE id=$1", [current.id]);
      const profile = result.rows[0];
      return json(res, 200, { profile: { ...profile, public_path: `/profile/${profile.id}` } });
    }

    if (req.method === "POST" && url.pathname === "/api/profile/rsi-sync") {
      const current = await getCurrentAppUser(req); if (!current) return json(res, 401, { error: "login required" });
      const userResult = await pool.query("SELECT rsi_profile_url FROM app_users WHERE id=$1", [current.id]);
      const rsiProfileUrl = userResult.rows[0]?.rsi_profile_url;
      if (!rsiProfileUrl) return json(res, 400, { error: "save an RSI profile URL first" });
      try {
        const rsiProfile = await fetchRsiProfile(rsiProfileUrl);
        const updated = await pool.query("UPDATE app_users SET rsi_avatar_url=$1,rsi_handle=$2,rsi_citizen_record=$3,rsi_organization=$4,rsi_enlisted=$5,rsi_fluency=$6,rsi_profile_synced_at=now() WHERE id=$7 RETURNING id,COALESCE(verselink_name,display_name) AS display_name,verselink_name,display_name AS scmdb_display_name,rsi_profile_url,discord_name,profile_public,rsi_avatar_url,rsi_handle,rsi_citizen_record,rsi_organization,rsi_enlisted,rsi_fluency,rsi_profile_synced_at", [rsiProfile.avatarUrl, rsiProfile.handle, rsiProfile.citizenRecord, rsiProfile.organization, rsiProfile.enlisted, rsiProfile.fluency, current.id]);
        console.log(`[rsi-profile] synced; user=${current.id}`);
        return json(res, 200, { ok: true, profile: { ...updated.rows[0], public_path: `/profile/${updated.rows[0].id}` } });
      } catch (error) {
        console.warn(`[rsi-profile] sync failed; user=${current.id}; reason=${logValue(error.message)}`);
        return json(res, 502, { error: "unable to sync public RSI profile" });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/profile") {
      const current = await getCurrentAppUser(req); if (!current) return json(res, 401, { error: "login required" });
      const params = new URLSearchParams(await readBody(req));
      const name = (params.get("verselink_name") || "").trim();
      const rsiInput = (params.get("rsi_profile_url") || "").trim();
      const discordName = (params.get("discord_name") || "").trim();
      const accentInput = (params.get("accent_color") || "").trim();
      const accentColor = accentInput === "" ? null : accentInput.toUpperCase();
      const rsiProfileUrl = normalizeRsiProfileUrl(rsiInput);
      if (name && (!validText(name, 50) || !/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name))) return json(res, 400, { error: "name must be 1-50 letters, numbers, spaces, dots, hyphens or underscores" });
      if (rsiInput && !rsiProfileUrl) return json(res, 400, { error: "RSI profile URL must use https://robertsspaceindustries.com" });
      if (discordName && !validText(discordName, 80)) return json(res, 400, { error: "Discord name must be 1-80 characters" });
      if (accentInput && !/^#[0-9A-F]{6}$/i.test(accentInput)) return json(res, 400, { error: "accent color must be a 6-digit hex value" });
      try {
        const updated = await pool.query("UPDATE app_users SET verselink_name=$1,rsi_profile_url=$2,discord_name=$3,profile_public=$4,accent_color=$5,rsi_avatar_url=CASE WHEN rsi_profile_url IS DISTINCT FROM $2 THEN NULL ELSE rsi_avatar_url END,rsi_handle=CASE WHEN rsi_profile_url IS DISTINCT FROM $2 THEN NULL ELSE rsi_handle END,rsi_citizen_record=CASE WHEN rsi_profile_url IS DISTINCT FROM $2 THEN NULL ELSE rsi_citizen_record END,rsi_organization=CASE WHEN rsi_profile_url IS DISTINCT FROM $2 THEN NULL ELSE rsi_organization END,rsi_enlisted=CASE WHEN rsi_profile_url IS DISTINCT FROM $2 THEN NULL ELSE rsi_enlisted END,rsi_fluency=CASE WHEN rsi_profile_url IS DISTINCT FROM $2 THEN NULL ELSE rsi_fluency END,rsi_profile_synced_at=CASE WHEN rsi_profile_url IS DISTINCT FROM $2 THEN NULL ELSE rsi_profile_synced_at END WHERE id=$6 RETURNING id,COALESCE(verselink_name,display_name) AS display_name,verselink_name,display_name AS scmdb_display_name,rsi_profile_url,discord_name,profile_public,accent_color,rsi_avatar_url,rsi_handle,rsi_citizen_record,rsi_organization,rsi_enlisted,rsi_fluency,rsi_profile_synced_at", [name || null, rsiProfileUrl, discordName || null, params.get("profile_public") === "1", accentColor, current.id]);
        return json(res, 200, { ok: true, profile: { ...updated.rows[0], public_path: `/profile/${updated.rows[0].id}` } });
      } catch (error) {
        if (error.code === "23505") return json(res, 409, { error: "this VerseLink name is already in use" });
        throw error;
      }
    }

    if (req.method === "POST" && url.pathname === "/api/groups") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const params = new URLSearchParams(await readBody(req));
      const name = params.get("name")?.trim();
      if (!validText(name, 120)) return json(res, 400, { error: "invalid group name" });
      const client = await pool.connect();
      try { await client.query("BEGIN"); const group = await client.query("INSERT INTO blueprint_groups (name, created_by) VALUES ($1, $2) RETURNING id", [name, context.appUserId]); await client.query("INSERT INTO group_members (group_id, app_user_id, role) VALUES ($1, $2, 'owner')", [group.rows[0].id, context.appUserId]); await client.query("COMMIT"); return json(res, 201, { id: group.rows[0].id, name }); } catch (error) { await client.query("ROLLBACK"); return json(res, 400, { error: error.message }); } finally { client.release(); }
    }

    if (req.method === "POST" && url.pathname === "/api/groups/rename") {
      const context = await getSessionContext(req); if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const params = new URLSearchParams(await readBody(req)); const groupId = params.get("group_id"), name = params.get("name")?.trim();
      if (!/^[0-9a-f-]{36}$/i.test(groupId || "") || !validText(name, 120)) return json(res, 400, { error: "invalid group name" });
      const result = await pool.query(`UPDATE blueprint_groups SET name = $1 WHERE id = $2 AND id IN (SELECT gm.group_id FROM group_members gm WHERE gm.app_user_id = $3 AND gm.role = 'owner') RETURNING id, name`, [name, groupId, context.appUserId]);
      if (!result.rowCount) return json(res, 403, { error: "group owner required" });
      return json(res, 200, { ok: true, group: result.rows[0] });
    }

    if (req.method === "POST" && url.pathname === "/api/groups/leave") {
      const context = await getSessionContext(req); if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const params = new URLSearchParams(await readBody(req)); const groupId = params.get("group_id");
      if (!/^[0-9a-f-]{36}$/i.test(groupId || "")) return json(res, 400, { error: "invalid group" });
      await pool.query("DELETE FROM group_members WHERE group_id = $1 AND app_user_id = $2 AND role <> 'owner'", [groupId, context.appUserId]); return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/groups/transfer-owner") {
      const context = await getSessionContext(req); if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const params = new URLSearchParams(await readBody(req)); const groupId = params.get("group_id"), memberId = params.get("member_id");
      const client = await pool.connect();
      try { await client.query("BEGIN"); const owner = await client.query("SELECT 1 FROM group_members WHERE group_id = $1 AND role = 'owner' AND app_user_id = $2", [groupId, context.appUserId]); if (!owner.rowCount) throw new Error("group owner required"); const member = await client.query("SELECT 1 FROM group_members WHERE group_id = $1 AND app_user_id = $2", [groupId, memberId]); if (!member.rowCount) throw new Error("member not found"); await client.query("UPDATE group_members SET role = CASE WHEN app_user_id = $2 THEN 'owner' ELSE 'member' END WHERE group_id = $1", [groupId, memberId]); await client.query("COMMIT"); return json(res, 200, { ok: true }); } catch (error) { await client.query("ROLLBACK"); return json(res, 400, { error: error.message }); } finally { client.release(); }
    }

    if (req.method === "POST" && url.pathname === "/api/invites/revoke") {
      const context = await getSessionContext(req); if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const params = new URLSearchParams(await readBody(req)); const inviteId = params.get("invite_id");
      const current = await getCurrentAppUser(req); await pool.query(`DELETE FROM group_invites WHERE id = $1 AND ($3 OR group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.app_user_id = $2 AND gm.role = 'owner'))`, [inviteId, context.appUserId, Boolean(current?.is_admin)]); return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/groups/invites") {
      const context = await getSessionContext(req); if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const current = await getCurrentAppUser(req); const result = await pool.query(`SELECT i.id, i.group_id, g.name AS group_name, i.invite_code, i.expires_at, i.max_uses, i.use_count FROM group_invites i JOIN blueprint_groups g ON g.id = i.group_id WHERE i.accepted_at IS NULL AND i.expires_at > now() AND ($2 OR i.group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.app_user_id = $1 AND gm.role = 'owner')) ORDER BY i.expires_at`, [context.appUserId, Boolean(current?.is_admin)]); return json(res, 200, { invites: result.rows });
    }

    if (req.method === "GET" && url.pathname === "/api/sync/materials") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const current = await getCurrentAppUser(req); const owner = await pool.query("SELECT 1 FROM group_members WHERE app_user_id=$1 AND role='owner' LIMIT 1", [context.appUserId]);
      if (!owner.rowCount && !current?.is_admin) return json(res, 403, { error: "group owner or app admin required" });
      return json(res, 200, materialsSyncState);
    }

    if (req.method === "POST" && url.pathname === "/api/sync/materials") {
      const context = await getSessionContext(req);
      if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const current = await getCurrentAppUser(req); const owner = await pool.query("SELECT 1 FROM group_members WHERE app_user_id=$1 AND role='owner' LIMIT 1", [context.appUserId]);
      if (!owner.rowCount && !current?.is_admin) return json(res, 403, { error: "group owner or app admin required" });
      syncWikiMaterials();
      return json(res, 202, { ok: true, message: "Material sync started", last_sync_at: materialsSyncState.lastSyncAt });
    }

    if (req.method === "POST" && url.pathname === "/api/groups/remove-member") {
      const context = await getSessionContext(req); if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const params = new URLSearchParams(await readBody(req)); const groupId = params.get("group_id"), memberId = params.get("member_id");
      const current = await getCurrentAppUser(req); await pool.query(`DELETE FROM group_members WHERE group_id = $1 AND app_user_id = $2 AND role <> 'owner' AND ($4 OR group_id IN (SELECT gm.group_id FROM group_members gm WHERE gm.app_user_id = $3 AND gm.role = 'owner'))`, [groupId, memberId, context.appUserId, Boolean(current?.is_admin)]); return json(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/groups/delete") {
      const context = await getSessionContext(req); if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const groupId = new URLSearchParams(await readBody(req)).get("group_id");
      await pool.query(`DELETE FROM blueprint_groups WHERE id = $1 AND id IN (SELECT gm.group_id FROM group_members gm WHERE gm.app_user_id = $2 AND gm.role = 'owner')`, [groupId, context.appUserId]); return json(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/login") {
      const html = await readFile(join(publicDir, "login.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(applyVerseLinkBranding(html.toString()).replace("{{APP_VERSION}}", appVersion).replace("</head>", '<link rel="icon" href="/favicon.png"></head>'));
    }

    if (req.method === "POST" && url.pathname === "/api/groups/clear-material-inventory") {
      const context = await getSessionContext(req); if (!context?.appUserId) return json(res, 401, { error: "login required" });
      const groupId = new URLSearchParams(await readBody(req)).get("group_id");
      if (!/^[0-9a-f-]{36}$/i.test(groupId || "")) return json(res, 400, { error: "invalid group" });
      const owner = await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND role='owner' AND app_user_id=$2", [groupId, context.appUserId]);
      if (!owner.rowCount) return json(res, 403, { error: "group owner required" });
      await pool.query("BEGIN");
      try { await pool.query("DELETE FROM material_inventory_withdrawals WHERE group_id=$1", [groupId]); await pool.query("DELETE FROM material_inventory_contributions WHERE group_id=$1", [groupId]); await pool.query("COMMIT"); return json(res, 200, { ok: true }); } catch (error) { await pool.query("ROLLBACK"); return json(res, 500, { error: "material inventory could not be cleared" }); }
    }

    return json(res, 404, { error: "not found" });
  } catch (error) {
    const status = error.message === "payload too large" ? 413 : 503;
    const safePath = req.url?.split("?")[0] || "unknown";
    logger.error("http.request.failed", error, { request_id: req.requestId }, { method: req.method, path: safePath, status });
    return json(res, status, { error: status === 413 ? "payload too large" : "service unavailable" });
  }
});
ensureSchema().then(() => syncReferenceData()).then(() => {
  server.listen(port, "0.0.0.0", () => {
    logger.info("server.started", { app_environment: appEnvironment, app_version: appVersion, app_commit: appCommit, effective_log_level: logger.getState().effective_level, log_directory: logDirectory, retention_days: logger.getState().retention_days, port });
    logger.cleanupRetention();
    scheduleInviteCleanup();
    syncWikiImages();
    syncWikiMaterials();
  });
}).catch((error) => {
  logger.error("database.initialization.failed", error);
  process.exit(1);
});
