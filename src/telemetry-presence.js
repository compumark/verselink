import { clientKey } from "./rate-limit.js";
import { hashDeviceCredential } from "./telemetry-pairing.js";
import { deviceAuthHttpMetadata, parseDeviceAuthorization } from "./telemetry-device-auth.js";

export const PRESENCE_BODY_LIMIT = 16 * 1024;
export const PRESENCE_REQUEST_LIMIT = 120;
export const PRESENCE_REQUEST_WINDOW_MS = 60_000;

const has = (value, key) => Object.hasOwn(value, key);
const objectValue = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const boundedText = (value, maximum, minimum = 0) => typeof value === "string"
  && (typeof value.isWellFormed !== "function" || value.isWellFormed())
  && Buffer.byteLength(value, "utf8") >= minimum
  && Buffer.byteLength(value, "utf8") <= maximum;

const validRFC3339Nano = (value) => {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , offsetHourText, offsetMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]) return false;
  if (hour > 23 || minute > 59 || second > 60) return false;
  if (zone !== "Z" && (Number(offsetHourText) > 23 || Number(offsetMinuteText) > 59)) return false;
  return true;
};

const nullableText = (body, key, maximum) => has(body, key)
  && (body[key] === null || boundedText(body[key], maximum));

// Only this explicit projection is persisted and compared. shard and
// party_count are intentionally validated by the C1 request contract but are
// discarded here before either database writes or revision comparisons.
export const projectPresence = (body) => ({
  schema_version: 1,
  session_active: body.session_active,
  location_raw: body.location === null ? null : body.location.raw,
  location_observed_at: body.location === null ? null : body.location.observed_at,
  jurisdiction: body.jurisdiction,
  ship_name: body.ship === null ? null : body.ship.name,
  quantum_destination: body.quantum === null ? null : body.quantum.destination,
  quantum_state: body.quantum === null ? null : body.quantum.state,
  last_event_at: body.last_event_at
});

export const validatePresencePayload = (body) => {
  if (!objectValue(body)) return { error: "invalid_payload" };
  if (!has(body, "schema")) return { error: "invalid_payload" };
  if (body.schema !== 1) return { error: "unsupported_schema" };
  if (!Number.isSafeInteger(body.revision) || body.revision < 1) return { error: "invalid_payload" };
  if (!has(body, "session_active") || !(body.session_active === null || typeof body.session_active === "boolean")) return { error: "invalid_payload" };
  if (!nullableText(body, "shard", 128)) return { error: "invalid_payload" };
  if (!has(body, "location")) return { error: "invalid_payload" };
  if (body.location !== null) {
    if (!objectValue(body.location) || !has(body.location, "raw") || !boundedText(body.location.raw, 256, 1)
      || !has(body.location, "observed_at") || !validRFC3339Nano(body.location.observed_at)) return { error: "invalid_payload" };
  }
  if (!nullableText(body, "jurisdiction", 128)) return { error: "invalid_payload" };
  if (!has(body, "ship")) return { error: "invalid_payload" };
  if (body.ship !== null && (!objectValue(body.ship) || !has(body.ship, "name") || !boundedText(body.ship.name, 128, 1))) return { error: "invalid_payload" };
  if (!has(body, "quantum")) return { error: "invalid_payload" };
  if (body.quantum !== null) {
    if (!objectValue(body.quantum) || !nullableText(body.quantum, "destination", 256)
      || !has(body.quantum, "state")
      || !["target_selected", "fuel_requested", "arrived"].includes(body.quantum.state)) return { error: "invalid_payload" };
  }
  if (!has(body, "party_count") || !(body.party_count === null || Number.isInteger(body.party_count) && body.party_count >= 0 && body.party_count <= 100)) return { error: "invalid_payload" };
  if (!has(body, "last_event_at") || !(body.last_event_at === null || validRFC3339Nano(body.last_event_at))) return { error: "invalid_payload" };
  return { snapshot: projectPresence(body), revision: body.revision };
};

const rowMatchesProjection = (row, projection) => row != null
  && row.schema_version === projection.schema_version
  && row.session_active === projection.session_active
  && row.location_raw === projection.location_raw
  && row.location_observed_at === projection.location_observed_at
  && row.jurisdiction === projection.jurisdiction
  && row.ship_name === projection.ship_name
  && row.quantum_destination === projection.quantum_destination
  && row.quantum_state === projection.quantum_state
  && row.last_event_at === projection.last_event_at;

const authResponse = (res, auth, sendError) => {
  const metadata = deviceAuthHttpMetadata(auth);
  if (!metadata) return false;
  for (const [name, value] of Object.entries(metadata.headers)) res.setHeader(name, value);
  sendError(res, metadata.status, metadata.body.error);
  return true;
};

export const createTelemetryPresenceHandler = ({
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
  onAcceptedSnapshot = async () => {},
  getClientKey = clientKey,
  parseAuthorization = parseDeviceAuthorization,
  hashCredential = hashDeviceCredential
}) => async (req, res) => {
  const peer = getClientKey(req);
  const credential = parseAuthorization(req);
  const rateKey = credential ? `credential:${hashCredential(pepper, credential)}` : `peer:${peer}`;
  const rate = requestRateLimit.consume(rateKey);
  if (!rate.allowed) {
    req.resume?.();
    return sendRateLimited(res, req, "/api/telemetry/presence", rate);
  }

  const parsed = await readJson(req, PRESENCE_BODY_LIMIT);
  const admitted = await authInFlight.run(peer, async () => {
    try {
      return { auth: await authenticate({ request: req, pool, pepper }) };
    } catch {
      logger.warn("telemetry.presence.failed", { route: "/api/telemetry/presence", reason: "database_unavailable" }, { request_id: req.requestId });
      sendError(res, 503, "server_unavailable");
      return { response: true };
    }
  }, () => {
    logger.warn("telemetry.presence.saturated", { route: "/api/telemetry/presence", status: 429 }, { request_id: req.requestId });
    sendError(res, 429, "rate_limited", 1);
    return { response: true };
  });
  if (admitted.response) return;
  if (authResponse(res, admitted.auth, sendError)) return;
  if (parsed.error) return sendError(res, parsed.status, parsed.error);

  const validated = validatePresencePayload(parsed.body);
  if (validated.error === "unsupported_schema") return sendError(res, 400, validated.error);
  if (validated.error) return sendError(res, 400, "invalid_payload");

  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const owner = await client.query(
      `SELECT d.last_presence_revision
       FROM telemetry_devices d
       JOIN app_users u ON u.id=d.app_user_id
       WHERE d.id=$1 AND d.app_user_id=$2 AND d.revoked_at IS NULL AND u.account_status='active'
       FOR UPDATE OF d,u`,
      [admitted.auth.context.deviceId, admitted.auth.context.appUserId]
    );
    if (!owner.rowCount) {
      await client.query("ROLLBACK");
      const current = await authenticate({ request: req, pool, pepper });
      if (authResponse(res, current, sendError)) return;
      return sendError(res, 401, "invalid_device_credential");
    }
    const currentRevision = Number(owner.rows[0].last_presence_revision);
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) throw new Error("invalid presence high-water mark");
    if (validated.revision < currentRevision) {
      await client.query("ROLLBACK");
      return sendJson(res, 409, { error: "stale_revision", current_revision: currentRevision });
    }

    if (validated.revision === currentRevision) {
      const existing = await client.query(
        `SELECT schema_version,session_active,location_raw,location_observed_at,jurisdiction,
                ship_name,quantum_destination,quantum_state,last_event_at
         FROM telemetry_presence WHERE device_id=$1`,
        [admitted.auth.context.deviceId]
      );
      const row = existing.rows[0];
      if (rowMatchesProjection(row, validated.snapshot)) {
        await client.query("COMMIT");
        return sendJson(res, 200, { schema: 1, accepted: false, revision: currentRevision });
      }
      await client.query("ROLLBACK");
      return sendJson(res, 409, { error: "revision_conflict", current_revision: currentRevision });
    }

    const advanced = await client.query(
      "UPDATE telemetry_devices SET last_presence_revision=$2 WHERE id=$1 AND last_presence_revision < $2",
      [admitted.auth.context.deviceId, validated.revision]
    );
    if (advanced.rowCount !== 1) throw new Error("presence revision changed while locked");
    const snapshot = validated.snapshot;
    const saved = await client.query(
      `INSERT INTO telemetry_presence (
         device_id,schema_version,revision,session_active,location_raw,location_observed_at,
         jurisdiction,ship_name,quantum_destination,quantum_state,last_event_at,received_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp())
       ON CONFLICT (device_id) DO UPDATE SET
         schema_version=EXCLUDED.schema_version,revision=EXCLUDED.revision,
         session_active=EXCLUDED.session_active,location_raw=EXCLUDED.location_raw,
         location_observed_at=EXCLUDED.location_observed_at,jurisdiction=EXCLUDED.jurisdiction,
         ship_name=EXCLUDED.ship_name,quantum_destination=EXCLUDED.quantum_destination,
         quantum_state=EXCLUDED.quantum_state,last_event_at=EXCLUDED.last_event_at,
         received_at=EXCLUDED.received_at
       RETURNING to_char(received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_at`,
      [admitted.auth.context.deviceId, snapshot.schema_version, validated.revision, snapshot.session_active,
        snapshot.location_raw, snapshot.location_observed_at, snapshot.jurisdiction, snapshot.ship_name,
        snapshot.quantum_destination, snapshot.quantum_state, snapshot.last_event_at]
    );
    await onAcceptedSnapshot(client, {
      deviceId: admitted.auth.context.deviceId,
      revision: validated.revision,
      snapshot,
      receivedAt: saved.rows[0].received_at
    });
    await client.query("COMMIT");
    return sendJson(res, 200, { schema: 1, accepted: true, revision: validated.revision, received_at: saved.rows[0].received_at });
  } catch {
    if (client) await client.query("ROLLBACK").catch(() => {});
    logger.warn("telemetry.presence.failed", { route: "/api/telemetry/presence", reason: "database_unavailable" }, { request_id: req.requestId });
    return sendError(res, 503, "server_unavailable");
  } finally {
    client?.release();
  }
};
