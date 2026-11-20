import { recordOrderDelivery, OrderDeliveryError } from "../../orders/delivery.js";
import { canonicalizeVersekitDeliveryQuantity, mapVersekitOrder, sumVersekitDeliveryQuantities } from "./orders.js";
import { sendAuthorizationFailure } from "./device-http.js";
import { sendProblem } from "./router.js";
import { readVersekitJson, rejectUnreadVersekitRequest } from "./request-form.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sendJson = (res, status, body) => {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

const problemForDeliveryError = (error) => {
  switch (error.reason) {
    case "not_found": return [404, "NOT_FOUND"];
    case "closed":
    case "legacy_progress": return [409, "ORDER_CLOSED"];
    case "item_not_in_order": return [422, "ITEM_NOT_IN_ORDER"];
    case "exceeds_remaining": return [400, "INVALID_REQUEST"];
    default: return null;
  }
};

const parseItems = (body) => {
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.items) || body.items.length < 1) return null;
  try {
    const items = body.items.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.item !== "string" || !Object.hasOwn(item, "quantity")) throw new Error("invalid item");
      return { item: item.item, quantity: canonicalizeVersekitDeliveryQuantity(item.quantity) };
    });
    return { items, quantity: sumVersekitDeliveryQuantities(items.map((item) => item.quantity)) };
  } catch { return null; }
};

const idempotencyHeader = (req) => {
  const values = req.headersDistinct?.["idempotency-key"];
  if (Array.isArray(values)) return values.length === 1 ? values[0] : null;
  const value = req.headers?.["idempotency-key"];
  return typeof value === "string" ? value : null;
};

export const createOrdersWriteHandler = ({ db, groupId, tokenStore, limiter }) => async (req, res, url, orderId) => {
  const rate = limiter.consume(req.socket?.remoteAddress || "unknown");
  if (!rate.allowed) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 429, "RATE_LIMITED", { "retry-after": String(Math.max(1, rate.retryAfter)) }));
  if (url.search || !UUID.test(orderId || "")) {
    return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "INVALID_REQUEST"));
  }

  const authorization = /^Bearer (vka_[A-Za-z0-9_-]{43})$/i.exec(String(req.headers?.authorization || ""));
  if (!authorization) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 401, "UNAUTHORIZED", { "www-authenticate": 'Bearer error="invalid_token"' }));

  const key = idempotencyHeader(req);
  if (key === null) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "IDEMPOTENCY_KEY_MISSING"));
  const keyLength = [...key].length;
  if (keyLength < 1 || keyLength > 200) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "INVALID_BODY"));

  const input = await readVersekitJson(req, res);
  if (input.responded || input.error) return;
  let body;
  try { body = JSON.parse(input.body); } catch {
    return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "INVALID_BODY"));
  }
  const parsed = parseItems(body);
  if (!parsed) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "INVALID_BODY"));

  const canonicalOrderId = orderId.toLowerCase();
  const canonicalBody = { items: parsed.items };
  const fingerprint = tokenStore.codec.hash("orders_delivery_fingerprint", JSON.stringify({ orderId: canonicalOrderId, body: canonicalBody }));
  const keyHash = tokenStore.codec.hash("orders_delivery_idempotency_key", key);
  let client;
  try {
    client = await db.connect();
    await client.query("BEGIN");
    const auth = await tokenStore.authorizeAccess(authorization[1], { operation: "orders:write", client });
    if (!auth.allowed) {
      await client.query("ROLLBACK");
      return rejectUnreadVersekitRequest(req, res, () => sendAuthorizationFailure(res, auth));
    }

    const reservation = await client.query(`
      INSERT INTO versekit_order_delivery_idempotency(group_id,app_user_id,key_hash,request_fingerprint)
      VALUES($1,$2,$3,$4)
      ON CONFLICT(group_id,app_user_id,key_hash) DO NOTHING
      RETURNING key_hash`, [groupId, auth.member.app_user_id || auth.member.id, keyHash, fingerprint]);
    if (!reservation.rowCount) {
      const existing = await client.query(`
        SELECT request_fingerprint,response_status,response_body
        FROM versekit_order_delivery_idempotency
        WHERE group_id=$1 AND app_user_id=$2 AND key_hash=$3
        FOR UPDATE`, [groupId, auth.member.app_user_id || auth.member.id, keyHash]);
      if (!existing.rowCount || existing.rows[0].request_fingerprint !== fingerprint) {
        await client.query("ROLLBACK");
        return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "INVALID_REQUEST"));
      }
      if (!existing.rows[0].response_status || !existing.rows[0].response_body) throw new Error("incomplete VerseKit idempotency record");
      await client.query("COMMIT");
      return sendJson(res, existing.rows[0].response_status, existing.rows[0].response_body);
    }

    const result = await recordOrderDelivery(client, {
      orderId: canonicalOrderId, deliveredBy: auth.member.app_user_id || auth.member.id,
      quantity: parsed.quantity, items: parsed.items.map((item) => item.item), groupId, visibleOnly: true
    });
    const response = { delivery_id: result.deliveryId, order: mapVersekitOrder(result.order) };
    await client.query(`
      UPDATE versekit_order_delivery_idempotency
      SET response_status=201,response_body=$4::jsonb
      WHERE group_id=$1 AND app_user_id=$2 AND key_hash=$3`,
    [groupId, auth.member.app_user_id || auth.member.id, keyHash, JSON.stringify(response)]);
    await client.query("COMMIT");
    return sendJson(res, 201, response);
  } catch (error) {
    await client?.query("ROLLBACK").catch(() => {});
    if (error instanceof OrderDeliveryError) {
      const problem = problemForDeliveryError(error);
      if (problem) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, problem[0], problem[1]));
    }
    return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 503, "MAINTENANCE", { "retry-after": "30" }));
  } finally { client?.release(); }
};
