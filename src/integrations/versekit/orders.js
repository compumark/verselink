import { createHmac, timingSafeEqual } from "node:crypto";
import { sendProblem } from "./router.js";
import { sendAuthorizationFailure } from "./device-http.js";
import { rejectUnreadVersekitRequest } from "./request-form.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURSOR_CONTEXT = "verselink:versekit:orders:cursor:v1";
const CURSOR_KEY_CONTEXT = `${CURSOR_CONTEXT}:key`;
const CURSOR_MAC_CONTEXT = `${CURSOR_CONTEXT}\0`;
const MAX_CURSOR_LENGTH = 2048;
const MAX_SAFE_SIGNIFICANT_DIGITS = 15;
const MAX_NUMERIC_TEXT_LENGTH = 150_000;
const MIN_NORMAL_JSON_NUMBER = 2 ** -1022;
const ORDER_READINESS_BATCH_SIZE = 250;
const SUPPORTED_ORDER_STATUSES = new Set(["open", "claimed", "reported", "completed", "cancelled"]);
const UNIT_MAP = new Map([
  ["scu", "scu"], ["cscu", "cscu"],
  ["piece", "piece"], ["pieces", "piece"], ["pc", "piece"], ["pcs", "piece"],
  ["item", "piece"], ["items", "piece"], ["unit", "piece"], ["units", "piece"], ["qty", "piece"],
  ["stk", "piece"], ["stück", "piece"], ["stueck", "piece"]
]);

const ORDER_PROJECTION = `
  SELECT o.id, o.order_number, o.material_name, o.required_quantity::text AS required_quantity,
    o.quantity_unit, o.status,
    to_char(o.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
    CASE WHEN COUNT(d.id) > 0 THEN SUM(d.delivered_quantity)::text ELSE COALESCE(o.delivered_quantity, 0)::text END AS delivered_quantity
  FROM material_orders o
  LEFT JOIN material_order_deliveries d ON d.order_id=o.id`;

export class OrdersCompatibilityError extends Error {
  constructor(reason) {
    super("VerseKit orders contain data that cannot be represented safely");
    this.name = "OrdersCompatibilityError";
    this.code = "VERSEKIT_ORDERS_INCOMPATIBLE_DATA";
    this.reason = reason;
  }
}

export class OrdersReadinessError extends Error {
  constructor(reason) {
    super("VerseKit orders are not ready for v1 discovery");
    this.name = "OrdersReadinessError";
    this.code = "VERSEKIT_ORDERS_NOT_READY";
    this.reason = reason;
  }
}

const parseDecimal = (text, { allowExponent = false } = {}) => {
  if (typeof text !== "string" || text.length > MAX_NUMERIC_TEXT_LENGTH) return null;
  const pattern = allowExponent
    ? /^(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/
    : /^(0|[1-9]\d*)(?:\.(\d+))?$/;
  const match = pattern.exec(text);
  if (!match) return null;
  const fraction = match[2] || "";
  const exponentPart = allowExponent ? Number(match[3] || 0) : 0;
  if (!Number.isSafeInteger(exponentPart) || Math.abs(exponentPart) > MAX_NUMERIC_TEXT_LENGTH) return null;
  let digits = `${match[1]}${fraction}`.replace(/^0+/, "");
  if (!digits) return { coefficient: 0n, exponent: 0, significantDigits: 0 };
  let exponent = exponentPart - fraction.length;
  const trailingZeros = /0+$/.exec(digits)?.[0].length || 0;
  if (trailingZeros) {
    digits = digits.slice(0, -trailingZeros);
    exponent += trailingZeros;
  }
  if (Math.abs(exponent) > MAX_NUMERIC_TEXT_LENGTH) return null;
  return { coefficient: BigInt(digits), exponent, significantDigits: digits.length };
};

// Compare nonnegative decimals exactly. The coefficient stays integral and
// powers of ten align only the scales; no binary floating-point arithmetic is
// involved in order-completion decisions.
const compareDecimals = (left, right) => {
  if (left.coefficient === 0n) return right.coefficient === 0n ? 0 : -1;
  if (right.coefficient === 0n) return 1;
  const leftDigits = left.coefficient.toString().length;
  const rightDigits = right.coefficient.toString().length;
  const leftMagnitude = leftDigits + left.exponent;
  const rightMagnitude = rightDigits + right.exponent;
  if (leftMagnitude !== rightMagnitude) return leftMagnitude < rightMagnitude ? -1 : 1;
  const commonExponent = Math.min(left.exponent, right.exponent);
  const scaledLeft = left.coefficient * (10n ** BigInt(left.exponent - commonExponent));
  const scaledRight = right.coefficient * (10n ** BigInt(right.exponent - commonExponent));
  return scaledLeft < scaledRight ? -1 : scaledLeft > scaledRight ? 1 : 0;
};

const jsonQuantity = (value, field) => {
  const text = String(value);
  const decimal = parseDecimal(text);
  if (!decimal) throw new OrdersCompatibilityError(`${field}_INVALID`);
  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) throw new OrdersCompatibilityError(`${field}_INVALID`);
  if (number === 0 && decimal.coefficient !== 0n) throw new OrdersCompatibilityError(`${field}_PRECISION_UNDERFLOW`);
  if (number > 0 && number < MIN_NORMAL_JSON_NUMBER) throw new OrdersCompatibilityError(`${field}_PRECISION_UNSUPPORTED`);
  // JSON numbers are binary doubles. Accept ordinary decimals such as 0.1
  // when Number#toString preserves their source decimal, but reject values
  // whose shortest round-trip decimal materially differs from PostgreSQL.
  const roundTrip = parseDecimal(number.toString(), { allowExponent: true });
  if (!roundTrip || compareDecimals(decimal, roundTrip) !== 0) {
    throw new OrdersCompatibilityError(`${field}_PRECISION_UNSUPPORTED`);
  }
  if (decimal.significantDigits > MAX_SAFE_SIGNIFICANT_DIGITS || (Number.isInteger(number) && !Number.isSafeInteger(number))) {
    throw new OrdersCompatibilityError(`${field}_PRECISION_UNSUPPORTED`);
  }
  return { number, decimal };
};

const timestampIsCanonical = (value) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString().slice(0, 19) === `${value.slice(0, 19)}`;

const cursorKeyCompare = (left, right) => {
  if (left.created < right.created) return -1;
  if (left.created > right.created) return 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
};

const exactKeys = (value, expected) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));

const validCursorPayload = (payload, groupId) => {
  if (!exactKeys(payload, ["v", "g", "scope", "s", "l"]) || payload.v !== 1 || payload.g !== groupId || payload.scope !== "orders:read") return false;
  const validTuple = (tuple) => exactKeys(tuple, ["created", "id"]) && timestampIsCanonical(tuple.created) &&
    typeof tuple.id === "string" && UUID.test(tuple.id);
  if (!validTuple(payload.s) || !validTuple(payload.l)) return false;
  // Rows are ordered newest-first. Every continuation boundary must be older
  // than the original high-water row, including UUID tie-breaking.
  return cursorKeyCompare(payload.l, payload.s) <= 0;
};

const decodeCanonicalBase64url = (value) => {
  if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? bytes : null;
};

export const createOrdersCursorCodec = (pepper) => {
  if (typeof pepper !== "string" || Buffer.byteLength(pepper) < 32) throw new Error("VerseKit cursor signing requires the configured secret pepper");
  // HMAC with a distinct context derives an orders-cursor-only key. OAuth token
  // hashes and raw credentials are never used as cursor signing material.
  const signingKey = createHmac("sha256", Buffer.from(pepper, "utf8")).update(CURSOR_KEY_CONTEXT, "utf8").digest();
  const signatureFor = (encodedPayload) => createHmac("sha256", signingKey)
    .update(CURSOR_MAC_CONTEXT, "utf8").update(encodedPayload, "ascii").digest();
  const encode = (payload, groupId) => {
    if (!validCursorPayload(payload, groupId)) throw new Error("Cannot encode an invalid VerseKit orders cursor");
    const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${encodedPayload}.${signatureFor(encodedPayload).toString("base64url")}`;
  };
  const decode = (value, groupId) => {
    if (typeof value !== "string" || value.length > MAX_CURSOR_LENGTH) return null;
    const parts = value.split(".");
    if (parts.length !== 2) return null;
    const payloadBytes = decodeCanonicalBase64url(parts[0]);
    const receivedMac = decodeCanonicalBase64url(parts[1]);
    if (!payloadBytes || !receivedMac || receivedMac.length !== 32) return null;
    const expectedMac = signatureFor(parts[0]);
    if (!timingSafeEqual(receivedMac, expectedMac)) return null;
    try {
      const json = payloadBytes.toString("utf8");
      const payload = JSON.parse(json);
      if (JSON.stringify(payload) !== json || !validCursorPayload(payload, groupId)) return null;
      return payload;
    } catch { return null; }
  };
  return Object.freeze({ encode, decode });
};

const v1Status = (status, required, delivered) => {
  if (status === "cancelled") return "cancelled";
  if (required.coefficient > 0n && compareDecimals(delivered, required) >= 0) return "done";
  return "open";
};

const assertSupportedOrderStatus = (status) => {
  if (typeof status !== "string" || !SUPPORTED_ORDER_STATUSES.has(status)) {
    throw new OrdersCompatibilityError("ORDER_SOURCE_INVALID");
  }
  return status;
};

export const mapVersekitOrder = (row) => {
  assertSupportedOrderStatus(row.status);
  if (typeof row.id !== "string" || !UUID.test(row.id) || typeof row.order_number !== "string" || !row.order_number.trim() ||
      typeof row.material_name !== "string" || !row.material_name.trim()) {
    throw new OrdersCompatibilityError("ORDER_SOURCE_INVALID");
  }
  const required = jsonQuantity(row.required_quantity, "REQUIRED_QUANTITY");
  const delivered = jsonQuantity(row.delivered_quantity, "DELIVERED_QUANTITY");
  const sourceUnit = typeof row.quantity_unit === "string" ? row.quantity_unit.trim().toLowerCase() : "";
  const unit = UNIT_MAP.get(sourceUnit);
  if (!unit) throw new OrdersCompatibilityError("UNIT_UNSUPPORTED");
  if (!timestampIsCanonical(row.cursor_created_at)) throw new OrdersCompatibilityError("ORDER_TIMESTAMP_INVALID");
  return {
    id: row.id,
    title: `${row.order_number} — ${row.material_name}`,
    status: v1Status(row.status, required.decimal, delivered.decimal),
    items: [{ item: row.material_name, quantity: required.number, delivered: delivered.number, unit }]
  };
};

export const normalizeVersekitOrderStatus = (status, required, delivered) => {
  assertSupportedOrderStatus(status);
  const sourceDecimal = (value, field) => {
    if (typeof value !== "string") throw new OrdersCompatibilityError(`${field}_INVALID`);
    const decimal = parseDecimal(value);
    if (!decimal) throw new OrdersCompatibilityError(`${field}_INVALID`);
    return decimal;
  };
  return v1Status(status, sourceDecimal(required, "REQUIRED_QUANTITY"), sourceDecimal(delivered, "DELIVERED_QUANTITY"));
};

export const assertOrdersReadiness = async ({ db, groupId }) => {
  const client = await db.connect();
  let committed = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    // Parent-first row locking matches VK-04 authorization and group deletion.
    // FOR UPDATE also serializes FK-backed order inserts during this startup scan.
    const group = await client.query("SELECT id FROM blueprint_groups WHERE id=$1 FOR UPDATE", [groupId]);
    if (!group.rowCount) throw new Error("VerseKit configured group disappeared during orders readiness check");
    let afterId = null;
    for (;;) {
      const rows = await client.query(`${ORDER_PROJECTION}
        WHERE o.group_id=$1 AND o.hidden_at IS NULL AND ($2::uuid IS NULL OR o.id>$2::uuid)
        GROUP BY o.id ORDER BY o.id LIMIT $3`, [groupId, afterId, ORDER_READINESS_BATCH_SIZE]);
      for (const row of rows.rows) {
        try { mapVersekitOrder(row); }
        catch (error) {
          if (error instanceof OrdersCompatibilityError) throw new OrdersReadinessError(error.reason);
          throw error;
        }
      }
      if (rows.rows.length < ORDER_READINESS_BATCH_SIZE) break;
      afterId = rows.rows.at(-1).id;
    }
    await client.query("COMMIT");
    committed = true;
  } finally {
    if (!committed) await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
};

const parseLimit = (params) => {
  const values = params.getAll("limit");
  if (!values.length) return { value: 500 };
  if (values.length !== 1 || !/^\d+$/.test(values[0])) return { error: true };
  const value = Number(values[0]);
  return Number.isSafeInteger(value) && value >= 1 && value <= 1000 ? { value } : { error: true };
};

const cursorTuple = (row) => ({ created: row.cursor_created_at, id: row.id });

export const createOrdersHandler = ({ db, groupId, tokenStore, limiter, cursorCodec, onIncompatible = () => {} }) => async (req, res, url) => {
  const rate = limiter.consume(req.socket?.remoteAddress || "unknown");
  if (!rate.allowed) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 429, "RATE_LIMITED", { "retry-after": String(Math.max(1, rate.retryAfter)) }));
  if (url.searchParams.getAll("cursor").length > 1 || url.searchParams.getAll("limit").length > 1) {
    return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "INVALID_REQUEST"));
  }
  const parsedLimit = parseLimit(url.searchParams);
  if (parsedLimit.error) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "INVALID_REQUEST"));
  const rawCursor = url.searchParams.get("cursor");
  const cursor = rawCursor === null ? null : cursorCodec.decode(rawCursor, groupId);
  if (rawCursor !== null && !cursor) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "INVALID_CURSOR"));
  const authorization = /^Bearer (vka_[A-Za-z0-9_-]{43})$/i.exec(String(req.headers?.authorization || ""));
  if (!authorization) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 401, "UNAUTHORIZED", { "www-authenticate": 'Bearer error="invalid_token"' }));
  try {
    const client = await db.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const auth = await tokenStore.authorizeAccess(authorization[1], { operation: "orders:read", client });
      if (!auth.allowed) {
        await client.query("ROLLBACK");
        return rejectUnreadVersekitRequest(req, res, () => sendAuthorizationFailure(res, auth));
      }
      let snapshot = cursor?.s;
      if (!snapshot) {
        const latest = await client.query(`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at, id
          FROM material_orders WHERE group_id=$1 AND hidden_at IS NULL ORDER BY created_at DESC, id DESC LIMIT 1`, [groupId]);
        if (!latest.rowCount) {
          await client.query("COMMIT");
          res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          return res.end(JSON.stringify({ orders: [], next_cursor: null }));
        }
        snapshot = cursorTuple(latest.rows[0]);
      }
      const rows = await client.query(`${ORDER_PROJECTION}
        WHERE o.group_id=$1 AND o.hidden_at IS NULL
          AND (o.created_at, o.id) <= ($2::timestamptz, $3::uuid)
          AND ($4::timestamptz IS NULL OR (o.created_at, o.id) < ($4::timestamptz, $5::uuid))
        GROUP BY o.id ORDER BY o.created_at DESC, o.id DESC LIMIT $6`,
      [groupId, snapshot.created, snapshot.id, cursor?.l?.created || null, cursor?.l?.id || null, parsedLimit.value + 1]);
      const hasMore = rows.rows.length > parsedLimit.value;
      const pageRows = rows.rows.slice(0, parsedLimit.value);
      const orders = pageRows.map(mapVersekitOrder);
      let nextCursor = null;
      if (hasMore && pageRows.length) {
        const last = cursorTuple(pageRows.at(-1));
        nextCursor = cursorCodec.encode({ v: 1, g: groupId, scope: "orders:read", s: snapshot, l: last }, groupId);
      }
      await client.query("COMMIT");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ orders, next_cursor: nextCursor }));
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  } catch (error) {
    if (res.headersSent) return res.destroy?.();
    if (error instanceof OrdersCompatibilityError) onIncompatible(error.reason);
    return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 503, "MAINTENANCE", { "retry-after": "30" }));
  }
};
