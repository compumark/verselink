import { createHash } from "node:crypto";

export const LOCATION_CATALOG_TTL_SECONDS = 86400;
export const LOCATION_CATALOG_MAX_ROWS = 4000;
export const LOCATION_CATALOG_MAX_KEY_BYTES = 256;

const clean = (value, max) => typeof value === "string" && value.trim() && Buffer.byteLength(value.trim(), "utf8") <= max ? value.trim() : null;
const externalText = value => typeof value === "string" ? value : value && typeof value === "object" && typeof value.name === "string" ? value.name : null;

const readBoundedJson = async (response, maxBytes) => {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("empty reference response");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error("reference response too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { payload: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), bytes: total };
};

export const normalizeLocationEntry = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const rawKey = clean(body.location_raw, LOCATION_CATALOG_MAX_KEY_BYTES);
  const displayName = clean(body.display_name, 256);
  if (!rawKey || !displayName) return null;
  const fields = {
    location_raw: rawKey,
    display_name: displayName,
    system_name: clean(body.system_name, 128),
    parent_name: clean(body.parent_name, 256),
    jurisdiction: clean(body.jurisdiction, 128),
    affiliation: clean(body.affiliation, 128),
    source: clean(body.source, 128) || "admin",
    match_type: body.match_type === "exact" ? "exact" : "manual",
    status: body.status === "verified" ? "verified" : "suggested"
  };
  return fields;
};

export const locationCatalogETag = (version, rows) => `"loc-${version}-${createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16)}"`;

export const resolveLocation = (raw, storedJurisdiction, entry) => {
  if (!raw || !entry || entry.status !== "verified" || entry.location_raw !== raw) {
    return { locationDisplay: raw || "Unknown", systemDisplay: "Unknown", jurisdictionDisplay: "Unknown", affiliationDisplay: "Unknown", resolutionStatus: "unknown" };
  }
  const conflict = Boolean(storedJurisdiction && entry.jurisdiction && storedJurisdiction.trim().toLowerCase() !== entry.jurisdiction.trim().toLowerCase());
  return {
    locationDisplay: entry.display_name,
    systemDisplay: entry.system_name || "Unknown",
    jurisdictionDisplay: conflict ? "Unknown" : entry.jurisdiction || "Unknown",
    affiliationDisplay: entry.affiliation || "Unknown",
    resolutionStatus: conflict ? "conflict" : "resolved"
  };
};

export const createLocationCatalogHandlers = ({ pool, authenticateDevice, consumeDeviceLimit = () => ({ allowed: true }), sendJson, sendError, fetchImpl = fetch, wikiImportEnabled = false }) => {
  const listBundle = async (req, res) => {
    try {
      const [versionResult, rowsResult] = await Promise.all([
        pool.query("SELECT version FROM telemetry_location_catalog_version WHERE id=true"),
        pool.query("SELECT location_raw,display_name,system_name,parent_name,jurisdiction,affiliation,source,match_type,status,updated_at FROM telemetry_location_catalog WHERE status='verified' ORDER BY location_raw LIMIT $1", [LOCATION_CATALOG_MAX_ROWS])
      ]);
      const version = Number(versionResult.rows[0]?.version || 1);
      const rows = rowsResult.rows;
      const etag = locationCatalogETag(version, rows);
      if (req.headers?.["if-none-match"] === etag) {
        res.writeHead(304, { etag, "cache-control": `private, max-age=${LOCATION_CATALOG_TTL_SECONDS}` });
        return res.end();
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", etag, "cache-control": `private, max-age=${LOCATION_CATALOG_TTL_SECONDS}` });
      return res.end(JSON.stringify({ schema: 1, version, generated_at: new Date().toISOString(), ttl_seconds: LOCATION_CATALOG_TTL_SECONDS, entries: rows }));
    } catch {
      return sendError(res, 503, "server_unavailable");
    }
  };

  const deviceBundle = async (req, res) => {
    const auth = await authenticateDevice(req);
    if (auth?.kind !== "authenticated") {
      const metadata = auth?.http || { status: auth?.kind === "account_inactive" ? 403 : 401, body: { error: auth?.kind || "invalid_device_credential" }, headers: auth?.kind === "account_inactive" ? {} : { "WWW-Authenticate": "Bearer" } };
      for (const [name, value] of Object.entries(metadata.headers || {})) res.setHeader(name, value);
      return sendJson(res, metadata.status, metadata.body);
    }
    const rate = consumeDeviceLimit(auth.context.deviceId);
    if (!rate.allowed) return sendError(res, 429, "rate_limited", rate.retryAfter);
    return listBundle(req, res);
  };

  const adminList = async (current, res, url) => {
    if (!current?.is_admin) return sendError(res, 403, "admin required");
    const needle = String(url.searchParams.get("q") || "").trim().slice(0, 128);
    try {
      const result = await pool.query(
        `SELECT location_raw,display_name,system_name,parent_name,jurisdiction,affiliation,source,match_type,status,updated_at,verified_at
         FROM telemetry_location_catalog
         WHERE $1='' OR concat_ws(' ',location_raw,display_name,system_name,parent_name,jurisdiction,affiliation,source,match_type,status) ILIKE '%' || $1 || '%'
         ORDER BY status,location_raw LIMIT 500`, [needle]
      );
      const version = await pool.query("SELECT version FROM telemetry_location_catalog_version WHERE id=true");
      return sendJson(res, 200, { schema: 1, version: Number(version.rows[0]?.version || 1), entries: result.rows });
    } catch { return sendError(res, 503, "server_unavailable"); }
  };

  const saveEntry = async (current, res, body) => {
    if (!current?.is_admin) return sendError(res, 403, "admin required");
    const entry = normalizeLocationEntry(body);
    if (!entry) return sendError(res, 400, "invalid_payload");
    const verified = entry.status === "verified" && entry.match_type !== "suggestion";
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO telemetry_location_catalog
         (location_raw,display_name,system_name,parent_name,jurisdiction,affiliation,source,match_type,status,verified_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,CASE WHEN $9='verified' THEN now() ELSE NULL END,now())
         ON CONFLICT(location_raw) DO UPDATE SET display_name=EXCLUDED.display_name,system_name=EXCLUDED.system_name,parent_name=EXCLUDED.parent_name,
           jurisdiction=EXCLUDED.jurisdiction,affiliation=EXCLUDED.affiliation,source=EXCLUDED.source,match_type=EXCLUDED.match_type,status=EXCLUDED.status,
           verified_at=CASE WHEN EXCLUDED.status='verified' THEN now() ELSE NULL END,updated_at=now()`,
        [entry.location_raw, entry.display_name, entry.system_name, entry.parent_name, entry.jurisdiction, entry.affiliation, entry.source, entry.match_type, verified ? "verified" : "suggested"]
      );
      await client.query("UPDATE telemetry_location_catalog_version SET version=version+1,updated_at=now() WHERE id=true");
      await client.query("COMMIT");
      return sendJson(res, 200, { ok: true });
    } catch { await client.query("ROLLBACK").catch(() => {}); return sendError(res, 503, "server_unavailable"); }
    finally { client.release(); }
  };

  const importCandidates = async (current, res, source) => {
    if (!current?.is_admin) return sendError(res, 403, "admin required");
    const config = source === "wiki"
      ? { url: "https://api.star-citizen.wiki/api/locations", label: "Star Citizen Wiki API" }
      : source === "uex" ? { url: "https://api.uexcorp.uk/2.0/terminals", label: "UEX API" } : null;
    if (source === "wiki" && !wikiImportEnabled) return sendError(res, 400, "source_unavailable");
    if (!config || (source === "uex" && !process.env.UEX_API_TOKEN)) return sendError(res, 400, "source_unavailable");
    const abort = AbortSignal.timeout(8000);
    try {
      const sourceURL = new URL(config.url);
      const sourceHeaders = { Accept: "application/json", ...(source === "uex" ? { Authorization: `Bearer ${process.env.UEX_API_TOKEN}` } : {}) };
      const rows = [];
      let pageURL = sourceURL;
      let pages = 0, totalBytes = 0;
      while (pageURL && pages < 5 && rows.length < 1000) {
        if (pageURL.origin !== sourceURL.origin || pageURL.pathname !== sourceURL.pathname || pageURL.protocol !== "https:") throw new Error("reference pagination URL rejected");
        const response = await fetchImpl(pageURL, { headers: sourceHeaders, signal: abort, redirect: "error" });
        if (!response.ok) throw new Error("reference source unavailable");
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > 2 * 1024 * 1024) throw new Error("reference response too large");
        const { payload, bytes } = await readBoundedJson(response, 2 * 1024 * 1024);
        totalBytes += bytes;
        if (totalBytes > 4 * 1024 * 1024) throw new Error("reference import too large");
        const pageRows = source === "wiki" ? (Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : []) : (Array.isArray(payload.data) ? payload.data : []);
        rows.push(...pageRows.slice(0, 1000 - rows.length));
        const next = payload?.next || payload?.links?.next || payload?.meta?.pagination?.next;
        if (!next || typeof next !== "string") { pageURL = null; continue; }
        const nextURL = new URL(next, pageURL);
        if (nextURL.origin !== sourceURL.origin || nextURL.pathname !== sourceURL.pathname || nextURL.protocol !== "https:") throw new Error("reference pagination URL rejected");
        pageURL = nextURL;
        pages++;
      }
      const client = await pool.connect();
      let imported = 0;
      try {
        await client.query("BEGIN");
        for (const row of rows.slice(0, 1000)) {
          const displayName = clean(externalText(row.name) || externalText(row.terminal_name), 256);
          if (!displayName) continue;
          const externalId = clean(row.uuid || row.id || row.slug || row.terminal_id, 128) || displayName;
          const system = externalText(row.star) || externalText(row.system) || externalText(row.star_system_name);
          const parent = externalText(row.parent) || externalText(row.parent_name);
          await client.query(
            `INSERT INTO telemetry_location_suggestions(source,external_id,display_name,system_name,parent_name,jurisdiction,affiliation,match_type,updated_at)
             VALUES($1,$2,$3,$4,$5,$6,$7,'suggestion',now()) ON CONFLICT(source,external_id) DO UPDATE SET
             display_name=EXCLUDED.display_name,system_name=EXCLUDED.system_name,parent_name=EXCLUDED.parent_name,
             jurisdiction=EXCLUDED.jurisdiction,affiliation=EXCLUDED.affiliation,updated_at=now()`,
            [config.label, externalId, displayName, clean(system?.replace(/\s+System$/i, ""), 128), clean(parent, 256), clean(externalText(row.jurisdiction), 128), clean(externalText(row.affiliation), 128)]
          );
          imported++;
        }
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
      finally { client.release(); }
      return sendJson(res, 200, { ok: true, source: config.label, proposals: imported, exact_key_matches: 0 });
    } catch { return sendError(res, 502, "reference_source_unavailable"); }
  };

  const listSuggestions = async (current, res, needle = "") => {
    if (!current?.is_admin) return sendError(res, 403, "admin required");
    try {
      const result = await pool.query(
        `SELECT source,external_id,display_name,system_name,parent_name,jurisdiction,affiliation,match_type,updated_at
         FROM telemetry_location_suggestions
         WHERE $1='' OR concat_ws(' ',source,external_id,display_name,system_name,parent_name,jurisdiction,affiliation) ILIKE '%' || $1 || '%'
         ORDER BY updated_at DESC LIMIT 500`, [String(needle).slice(0, 128)]
      );
      return sendJson(res, 200, { schema: 1, proposals: result.rows });
    } catch { return sendError(res, 503, "server_unavailable"); }
  };

  return { deviceBundle, adminList, saveEntry, importCandidates, listSuggestions };
};
