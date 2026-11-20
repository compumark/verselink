import { createHmac, timingSafeEqual } from "node:crypto";
import { sendProblem } from "./router.js";
import { sendAuthorizationFailure } from "./device-http.js";
import { rejectUnreadVersekitRequest } from "./request-form.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTEXT = "verselink:versekit:blueprints:cursor:v1";
const MAX_CURSOR_LENGTH = 2048;
const MAX_NAME_LENGTH = 200;

const exactKeys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
const decodeBase64url = (value) => {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? bytes : null;
};
const compareKeys = (left, right) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
const validCursor = (value) => exactKeys(value, ["v", "scope", "s", "l"])
  && value.v === 1 && value.scope === "blueprints:read"
  && typeof value.s === "string" && value.s.length > 0 && value.s.length <= MAX_NAME_LENGTH
  && typeof value.l === "string" && value.l.length > 0 && value.l.length <= MAX_NAME_LENGTH
  && compareKeys(value.l, value.s) <= 0;

export const createBlueprintCursorCodec = (pepper) => {
  if (typeof pepper !== "string" || Buffer.byteLength(pepper, "utf8") < 32) throw new Error("VerseKit cursor signing requires the configured secret pepper");
  const keyFor = (groupId, userId) => createHmac("sha256", Buffer.from(pepper, "utf8"))
    .update(`${CONTEXT}:key\0${groupId}\0${userId}`, "utf8").digest();
  const mac = (payload, groupId, userId) => createHmac("sha256", keyFor(groupId, userId))
    .update(`${CONTEXT}\0`, "utf8").update(payload, "ascii").digest();
  const encode = (value, groupId, userId) => {
    if (!UUID.test(groupId) || !UUID.test(userId) || !validCursor(value)) throw new Error("Cannot encode an invalid VerseKit blueprint cursor");
    const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    return `${payload}.${mac(payload, groupId, userId).toString("base64url")}`;
  };
  const decode = (value, groupId, userId) => {
    if (typeof value !== "string" || value.length > MAX_CURSOR_LENGTH) return null;
    const parts = value.split(".");
    if (parts.length !== 2) return null;
    const bytes = decodeBase64url(parts[0]);
    const received = decodeBase64url(parts[1]);
    if (!UUID.test(groupId) || !UUID.test(userId) || !bytes || !received || received.length !== 32
        || !timingSafeEqual(received, mac(parts[0], groupId, userId))) return null;
    try {
      const json = bytes.toString("utf8");
      const result = JSON.parse(json);
      return JSON.stringify(result) === json && validCursor(result) ? result : null;
    } catch { return null; }
  };
  return Object.freeze({ encode, decode });
};

const parseLimit = (params) => {
  const values = params.getAll("limit");
  if (!values.length) return { value: 500 };
  if (values.length !== 1 || !/^\d+$/.test(values[0])) return { error: true };
  const value = Number(values[0]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 1000 ? { value } : { error: true };
};

// SCMDB ownership is authoritative. Reference rows supply labels only; the
// fallback order is member snapshot name, public SCMDB blueprint tag, then a
// stable generic label. Name normalization and the final grouping intentionally
// merge labels which collide because the v1 response has no blueprint ID.
const BLUEPRINT_ROWS = `
  WITH owned AS (
    SELECT
      lower(regexp_replace(COALESCE(NULLIF(btrim(r.product_name), ''), NULLIF(btrim(m.product_name), ''), NULLIF(btrim(m.tag), ''), 'Unknown blueprint'), '\\s+', ' ', 'g')) AS name_key,
      regexp_replace(COALESCE(NULLIF(btrim(r.product_name), ''), NULLIF(btrim(m.product_name), ''), NULLIF(btrim(m.tag), ''), 'Unknown blueprint'), '\\s+', ' ', 'g') AS name,
      COALESCE(NULLIF(regexp_replace(btrim(u.verselink_name), '\\s+', ' ', 'g'), ''),
               NULLIF(regexp_replace(btrim(u.display_name), '\\s+', ' ', 'g'), ''), 'Member') AS holder
    FROM member_blueprints m
    JOIN scmdb_connections c ON c.token_hash=m.token_hash
      AND c.connection_status='connected' AND c.revoked_at IS NULL
    JOIN app_users u ON u.id=c.app_user_id AND u.account_status='active'
    JOIN group_members gm ON gm.group_id=$1 AND gm.app_user_id=u.id
    LEFT JOIN reference_blueprints r ON r.tag=m.tag
  ), grouped AS (
    SELECT name_key, min(name COLLATE "C") AS name,
      array_agg(DISTINCT holder ORDER BY holder) AS holders
    FROM owned
    WHERE name_key <> ''
    GROUP BY name_key
  )
  SELECT name_key,name,holders FROM grouped`;

export const createBlueprintsHandler = ({ db, groupId, tokenStore, cursorCodec, limiter }) => async (req, res, url) => {
  const rate = limiter.consume(req.socket?.remoteAddress || "unknown");
  if (!rate.allowed) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 429, "RATE_LIMITED", { "retry-after": String(Math.max(1, rate.retryAfter)) }));
  if (url.searchParams.getAll("cursor").length > 1 || url.searchParams.getAll("limit").length > 1) {
    return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "INVALID_REQUEST"));
  }
  const parsedLimit = parseLimit(url.searchParams);
  if (parsedLimit.error) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "INVALID_REQUEST"));
  const bearer = /^Bearer (vka_[A-Za-z0-9_-]{43})$/i.exec(String(req.headers?.authorization || ""));
  if (!bearer) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 401, "UNAUTHORIZED", { "www-authenticate": 'Bearer error="invalid_token"' }));
  try {
    const client = await db.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const auth = await tokenStore.authorizeAccess(bearer[1], { operation: "blueprints:read", client });
      if (!auth.allowed) {
        await client.query("ROLLBACK");
        return rejectUnreadVersekitRequest(req, res, () => sendAuthorizationFailure(res, auth));
      }
      const userId = auth.member.app_user_id || auth.member.id;
      if (typeof userId !== "string" || !UUID.test(userId)) throw new Error("Authorized VerseKit member has no valid internal identity");
      const rawCursor = url.searchParams.get("cursor");
      const cursor = rawCursor === null ? null : cursorCodec.decode(rawCursor, groupId, userId);
      if (rawCursor !== null && !cursor) {
        await client.query("ROLLBACK");
        return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "INVALID_CURSOR"));
      }
      let snapshot = cursor?.s;
      if (!snapshot) {
        const top = await client.query(`${BLUEPRINT_ROWS} ORDER BY name_key COLLATE "C" DESC LIMIT 1`, [groupId]);
        snapshot = top.rows[0]?.name_key || null;
      }
      if (!snapshot) {
        await client.query("COMMIT");
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        return res.end(JSON.stringify({ blueprints: [], next_cursor: null }));
      }
      const page = await client.query(`${BLUEPRINT_ROWS}
        WHERE name_key COLLATE "C" <= $2 COLLATE "C"
          AND ($3::text IS NULL OR name_key COLLATE "C" > $3 COLLATE "C")
        ORDER BY name_key COLLATE "C" LIMIT $4`, [groupId, snapshot, cursor?.l || null, parsedLimit.value + 1]);
      const hasMore = page.rows.length > parsedLimit.value;
      const rows = page.rows.slice(0, parsedLimit.value);
      for (const row of rows) {
        if (typeof row.name !== "string" || !row.name.trim() || row.name.length > MAX_NAME_LENGTH
            || !Array.isArray(row.holders) || row.holders.some((holder) => typeof holder !== "string" || !holder.trim() || holder.length > 200)) {
          throw new Error("SCMDB blueprint name or holder cannot be represented by VerseKit v1");
        }
      }
      const last = rows.at(-1)?.name_key;
      const nextCursor = hasMore && last ? cursorCodec.encode({ v: 1, scope: "blueprints:read", s: snapshot, l: last }, groupId, userId) : null;
      await client.query("COMMIT");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ blueprints: rows.map(({ name, holders }) => ({ name, holders })), next_cursor: nextCursor }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  } catch {
    if (res.headersSent) return res.destroy?.();
    return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 503, "MAINTENANCE", { "retry-after": "30" }));
  }
};
