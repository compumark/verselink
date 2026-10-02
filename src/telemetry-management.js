import { normalizeDeviceName } from "./telemetry-pairing.js";
import { resolveLocation } from "./telemetry-location-catalog.js";

export const TELEMETRY_HISTORY_RETENTION_DAYS = 90;
export const TELEMETRY_HISTORY_PAGE_SIZE = 50;
export const TELEMETRY_HISTORY_MAX_PAGE_SIZE = 100;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const receivedAtPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const validReceivedAt = (value) => receivedAtPattern.test(value)
  && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === `${value.slice(0, 23)}Z`;

const encodeCursor = (receivedAt, id) => Buffer.from(JSON.stringify({ received_at: receivedAt, id }), "utf8").toString("base64url");
const decodeCursor = (value) => {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || !validReceivedAt(parsed.received_at) || !uuidPattern.test(parsed.id)) return null;
    if (Buffer.from(value, "base64url").toString("base64url") !== value) return null;
    return parsed;
  } catch { return null; }
};

const apiError = (res, status, error, retryAfter) => {
  if (retryAfter !== undefined) res.setHeader("Retry-After", String(Math.max(0, Math.ceil(retryAfter))));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error }));
};

const consume = (limiter, key) => limiter.consume(key);

export const insertAcceptedPresenceHistory = async (db, { deviceId, revision, snapshot, receivedAt }) => db.query(
  `INSERT INTO telemetry_presence_history
     (device_id,revision,location_raw,location_observed_at,jurisdiction,ship_name,received_at)
   SELECT $1,$2,$3,$4,$5,$6,$7::timestamptz
   WHERE NOT EXISTS (
     SELECT 1 FROM (
       SELECT previous.location_raw,previous.location_observed_at,previous.jurisdiction,previous.ship_name
       FROM telemetry_presence_history previous
       WHERE previous.device_id=$1
       ORDER BY previous.revision DESC
       LIMIT 1
     ) latest
     WHERE (latest.location_raw,latest.location_observed_at,latest.jurisdiction,latest.ship_name)
           IS NOT DISTINCT FROM ($3::text,$4::text,$5::text,$6::text)
   )
   ON CONFLICT (device_id,revision) DO NOTHING`,
  [deviceId, revision, snapshot.location_raw, snapshot.location_observed_at, snapshot.jurisdiction, snapshot.ship_name, receivedAt]
);

const historyRow = (row) => ({
  id: row.id,
  device_id: row.device_id,
  device_name: row.device_name,
  received_at: row.received_at,
  observed_at: row.location_observed_at,
  time_source: row.location_observed_at ? "observed" : "received",
  location_raw: row.location_raw,
  jurisdiction: row.jurisdiction,
  ship_name: row.ship_name,
  ...resolveLocation(row.location_raw, row.jurisdiction, row.catalog_location_raw ? {
    location_raw: row.catalog_location_raw,
    display_name: row.catalog_display_name,
    system_name: row.catalog_system_name,
    jurisdiction: row.catalog_jurisdiction,
    affiliation: row.catalog_affiliation,
    status: "verified"
  } : null)
});

export const createTelemetryManagementHandlers = ({
  pool,
  getAccount,
  readJson,
  logger,
  listRateLimit,
  mutationRateLimit,
  historyRateLimit,
  sendJson = (res, status, body) => { res.writeHead(status, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); },
  sendError = apiError,
  sendRateLimited = (res, route, rate) => sendError(res, 429, "rate_limited", rate.retryAfter)
}) => {
  const accountFor = async (req, res, limiter, route) => {
    const account = await getAccount(req);
    if (!account?.id || account.account_status !== "active") {
      sendError(res, 401, "login required");
      return null;
    }
    const rate = consume(limiter, account.id);
    if (!rate.allowed) {
      logger?.warn("telemetry.management.rate_limited", { route, status: 429 }, { request_id: req.requestId });
      sendRateLimited(res, route, rate);
      return null;
    }
    return account;
  };

  const listDevices = async (req, res) => {
    const account = await accountFor(req, res, listRateLimit, "/api/me/telemetry/devices");
    if (!account) return;
    try {
      const result = await pool.query(
        `SELECT d.id,d.name,d.created_at,d.last_seen_at,d.revoked_at,
                COALESCE(d.revoked_at IS NULL AND d.last_seen_at >= clock_timestamp() - interval '90 seconds',false) AS online
         FROM telemetry_devices d WHERE d.app_user_id=$1 ORDER BY d.created_at DESC,d.id DESC`,
        [account.id]
      );
      return sendJson(res, 200, { schema: 1, devices: result.rows });
    } catch {
      logger?.warn("telemetry.management.failed", { route: "/api/me/telemetry/devices", reason: "database_unavailable" }, { request_id: req.requestId });
      return sendError(res, 503, "server_unavailable");
    }
  };

  const renameDevice = async (req, res, deviceId) => {
    const account = await accountFor(req, res, mutationRateLimit, "/api/me/telemetry/devices/:id");
    if (!account) return;
    if (!uuidPattern.test(deviceId)) return sendError(res, 404, "not_found");
    const parsed = await readJson(req, 4 * 1024);
    if (parsed.error) return sendError(res, parsed.status, parsed.error === "unsupported_schema" ? parsed.error : "invalid_payload");
    const body = parsed.body;
    if (!Object.hasOwn(body, "schema")) return sendError(res, 400, "invalid_payload");
    if (body.schema !== 1) return sendError(res, 400, "unsupported_schema");
    if (Object.keys(body).some((key) => !["schema", "name"].includes(key)) || !Object.hasOwn(body, "name")) return sendError(res, 400, "invalid_payload");
    const name = normalizeDeviceName(body.name);
    if (name === null) return sendError(res, 400, "invalid_payload");
    try {
      const result = await pool.query(
        `UPDATE telemetry_devices d SET name=$3
         WHERE d.id=$1 AND d.app_user_id=$2
         RETURNING d.id,d.name,d.created_at,d.last_seen_at,d.revoked_at,
                   COALESCE(d.revoked_at IS NULL AND d.last_seen_at >= clock_timestamp() - interval '90 seconds',false) AS online`,
        [deviceId, account.id, name]
      );
      if (!result.rowCount) return sendError(res, 404, "not_found");
      return sendJson(res, 200, { schema: 1, device: result.rows[0] });
    } catch {
      logger?.warn("telemetry.management.failed", { route: "/api/me/telemetry/devices/:id", reason: "database_unavailable" }, { request_id: req.requestId });
      return sendError(res, 503, "server_unavailable");
    }
  };

  const revokeDevice = async (req, res, deviceId) => {
    const account = await accountFor(req, res, mutationRateLimit, "/api/me/telemetry/devices/:id");
    if (!account) return;
    if (!uuidPattern.test(deviceId)) return sendError(res, 404, "not_found");
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      const owned = await client.query("SELECT id FROM telemetry_devices WHERE id=$1 AND app_user_id=$2 FOR UPDATE", [deviceId, account.id]);
      if (!owned.rowCount) {
        await client.query("ROLLBACK");
        return sendError(res, 404, "not_found");
      }
      await client.query("UPDATE telemetry_devices SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND app_user_id=$2", [deviceId, account.id]);
      await client.query("DELETE FROM telemetry_presence WHERE device_id=$1", [deviceId]);
      await client.query("COMMIT");
      res.writeHead(204);
      return res.end();
    } catch {
      if (client) await client.query("ROLLBACK").catch(() => {});
      logger?.warn("telemetry.management.failed", { route: "/api/me/telemetry/devices/:id", reason: "database_unavailable" }, { request_id: req.requestId });
      return sendError(res, 503, "server_unavailable");
    } finally { client?.release(); }
  };

  const listHistory = async (req, res, url) => {
    const account = await accountFor(req, res, historyRateLimit, "/api/me/telemetry/history");
    if (!account) return;
    const requestedLimit = url.searchParams.get("limit");
    const limit = requestedLimit === null ? TELEMETRY_HISTORY_PAGE_SIZE : Number(requestedLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > TELEMETRY_HISTORY_MAX_PAGE_SIZE) return sendError(res, 400, "invalid_payload");
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor === null ? null : decodeCursor(rawCursor);
    if (rawCursor !== null && !cursor) return sendError(res, 400, "invalid_payload");
    try {
      const result = await pool.query(
        `SELECT h.id,h.device_id,d.name AS device_name,h.location_raw,h.location_observed_at,
                h.jurisdiction,h.ship_name,c.location_raw AS catalog_location_raw,c.display_name AS catalog_display_name,
                c.system_name AS catalog_system_name,c.jurisdiction AS catalog_jurisdiction,c.affiliation AS catalog_affiliation,
                to_char(h.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_at
         FROM telemetry_presence_history h
         JOIN telemetry_devices d ON d.id=h.device_id
         LEFT JOIN telemetry_location_catalog c ON c.location_raw=h.location_raw AND c.status='verified'
         WHERE d.app_user_id=$1
           AND h.received_at >= clock_timestamp() - interval '90 days'
           AND ($2::timestamptz IS NULL OR (h.received_at,h.id)<($2::timestamptz,$3::uuid))
         ORDER BY h.received_at DESC,h.id DESC
         LIMIT $4`,
        [account.id, cursor?.received_at ?? null, cursor?.id ?? null, limit + 1]
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      return sendJson(res, 200, {
        schema: 1,
        entries: rows.map(historyRow),
        next_cursor: hasMore && last ? encodeCursor(last.received_at, last.id) : null
      });
    } catch {
      logger?.warn("telemetry.history.failed", { route: "/api/me/telemetry/history", reason: "database_unavailable" }, { request_id: req.requestId });
      return sendError(res, 503, "server_unavailable");
    }
  };

  const deleteHistory = async (req, res) => {
    const account = await accountFor(req, res, mutationRateLimit, "/api/me/telemetry/history");
    if (!account) return;
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      await client.query("SELECT id FROM telemetry_devices WHERE app_user_id=$1 ORDER BY id FOR UPDATE", [account.id]);
      const deleted = await client.query(
        `DELETE FROM telemetry_presence_history h USING telemetry_devices d
         WHERE h.device_id=d.id AND d.app_user_id=$1`,
        [account.id]
      );
      await client.query("COMMIT");
      return sendJson(res, 200, { schema: 1, deleted: deleted.rowCount });
    } catch {
      if (client) await client.query("ROLLBACK").catch(() => {});
      logger?.warn("telemetry.history.delete.failed", { route: "/api/me/telemetry/history", reason: "database_unavailable" }, { request_id: req.requestId });
      return sendError(res, 503, "server_unavailable");
    } finally { client?.release(); }
  };

  return { listDevices, renameDevice, revokeDevice, listHistory, deleteHistory };
};
