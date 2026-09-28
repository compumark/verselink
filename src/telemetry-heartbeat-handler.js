import { clientKey } from "./rate-limit.js";
import { hashDeviceCredential } from "./telemetry-pairing.js";
import { deviceAuthHttpMetadata, parseDeviceAuthorization } from "./telemetry-device-auth.js";

export const createTelemetryHeartbeatHandler = ({
  pool,
  pepper,
  requestRateLimit,
  authInFlight,
  authenticate,
  readJson,
  sendJson,
  sendError,
  sendRateLimited,
  logger,
  getClientKey = clientKey,
  parseAuthorization = parseDeviceAuthorization,
  hashCredential = hashDeviceCredential
}) => async (req, res) => {
  const peer = getClientKey(req);
  const credential = parseAuthorization(req);
  // This domain-separated HMAC is only a bounded, pre-authentication limiter
  // identity. C4 still performs a fresh database lookup on every admitted request.
  const rateKey = credential
    ? `credential:${hashCredential(pepper, credential)}`
    : `peer:${peer}`;
  const requestRate = requestRateLimit.consume(rateKey);
  if (!requestRate.allowed) {
    req.resume?.();
    return sendRateLimited(res, req, "/api/telemetry/heartbeat", requestRate);
  }

  const parsed = await readJson(req);
  const admitted = await authInFlight.run(peer, async () => {
    let auth;
    try {
      auth = await authenticate({ request: req, pool, pepper });
    } catch {
      logger.warn("telemetry.heartbeat.failed", { route: "/api/telemetry/heartbeat", reason: "database_unavailable" }, { request_id: req.requestId });
      sendError(res, 503, "server_unavailable");
      return { response: true };
    }
    const authMetadata = deviceAuthHttpMetadata(auth);
    if (authMetadata) {
      for (const [name, value] of Object.entries(authMetadata.headers)) res.setHeader(name, value);
      sendError(res, authMetadata.status, authMetadata.body.error);
      return { response: true };
    }
    return { auth };
  }, () => {
    logger.warn("telemetry.heartbeat.saturated", { route: "/api/telemetry/heartbeat", status: 429 }, { request_id: req.requestId });
    sendError(res, 429, "rate_limited", 1);
    return { response: true };
  });
  if (admitted.response) return;
  const { auth } = admitted;
  if (parsed.error) return sendError(res, parsed.status, parsed.error);
  if (!Object.hasOwn(parsed.body, "schema")) return sendError(res, 400, "invalid_payload");
  if (parsed.body.schema !== 1) return sendError(res, 400, "unsupported_schema");
  if (Object.keys(parsed.body).some((key) => key !== "schema")) return sendError(res, 400, "invalid_payload");

  try {
    const updated = await pool.query(
      `UPDATE telemetry_devices d
       SET last_seen_at=clock_timestamp()
       FROM app_users u
       WHERE d.id=$1 AND d.app_user_id=$2 AND d.revoked_at IS NULL
         AND u.id=d.app_user_id AND u.account_status='active'
       RETURNING d.last_seen_at`,
      [auth.context.deviceId, auth.context.appUserId]
    );
    if (!updated.rowCount) {
      // Re-check C4 for a concurrent block/revocation. This request already
      // consumed its single rate-limit unit before the initial auth lookup.
      const currentResult = await authInFlight.run(peer, async () => {
        try {
          return { auth: await authenticate({ request: req, pool, pepper }) };
        } catch {
          logger.warn("telemetry.heartbeat.failed", { route: "/api/telemetry/heartbeat", reason: "database_unavailable" }, { request_id: req.requestId });
          sendError(res, 503, "server_unavailable");
          return { response: true };
        }
      }, () => {
        logger.warn("telemetry.heartbeat.saturated", { route: "/api/telemetry/heartbeat", status: 429 }, { request_id: req.requestId });
        sendError(res, 429, "rate_limited", 1);
        return { response: true };
      });
      if (currentResult.response) return;
      const currentMetadata = deviceAuthHttpMetadata(currentResult.auth);
      if (currentMetadata) {
        for (const [name, value] of Object.entries(currentMetadata.headers)) res.setHeader(name, value);
        return sendError(res, currentMetadata.status, currentMetadata.body.error);
      }
      return sendError(res, 401, "invalid_device_credential");
    }
    return sendJson(res, 200, { schema: 1, ok: true, received_at: updated.rows[0].last_seen_at.toISOString() });
  } catch {
    logger.warn("telemetry.heartbeat.failed", { route: "/api/telemetry/heartbeat", reason: "database_unavailable" }, { request_id: req.requestId });
    return sendError(res, 503, "server_unavailable");
  }
};
