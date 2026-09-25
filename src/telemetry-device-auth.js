import { hashDeviceCredential } from "./telemetry-pairing.js";

const credentialPattern = /^vlt_[A-Za-z0-9_-]{43}$/;
const bearerPattern = /^Bearer (vlt_[A-Za-z0-9_-]{43})$/;

const authorizationValue = (request) => {
  if (Array.isArray(request?.rawHeaders)) {
    if (request.rawHeaders.length % 2 !== 0) return null;
    const values = [];
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
      if (String(request.rawHeaders[index]).toLowerCase() === "authorization") values.push(request.rawHeaders[index + 1]);
    }
    return values.length === 1 ? values[0] : null;
  }

  const headersDistinct = request?.headersDistinct?.authorization;
  if (headersDistinct !== undefined) return Array.isArray(headersDistinct) && headersDistinct.length === 1 ? headersDistinct[0] : null;

  const headers = request?.headers || request;
  const value = headers?.authorization;
  return typeof value === "string" ? value : null;
};

export const parseDeviceAuthorization = (request) => {
  const value = authorizationValue(request);
  if (typeof value !== "string") return null;
  const match = bearerPattern.exec(value);
  return match && credentialPattern.test(match[1]) ? match[1] : null;
};

export const deviceAuthHttpMetadata = (result) => {
  if (result?.kind === "invalid_device_credential") {
    return { status: 401, body: { error: "invalid_device_credential" }, headers: { "WWW-Authenticate": "Bearer" } };
  }
  if (result?.kind === "device_revoked") {
    return { status: 401, body: { error: "device_revoked" }, headers: { "WWW-Authenticate": "Bearer" } };
  }
  if (result?.kind === "account_inactive") {
    return { status: 403, body: { error: "account_inactive" }, headers: {} };
  }
  return null;
};

const invalidCredential = Object.freeze({ kind: "invalid_device_credential" });
const revokedDevice = Object.freeze({ kind: "device_revoked" });
const inactiveAccount = Object.freeze({ kind: "account_inactive" });

export const authenticateTelemetryDevice = async ({ request, pool, pepper }) => {
  const credential = parseDeviceAuthorization(request);
  if (!credential) return invalidCredential;

  const credentialHash = hashDeviceCredential(pepper, credential);
  const lookup = await pool.query(
    `SELECT d.id AS device_id, d.app_user_id, d.revoked_at, u.account_status
     FROM telemetry_devices d
     JOIN app_users u ON u.id = d.app_user_id
     WHERE d.credential_hash = $1`,
    [credentialHash]
  );
  if (!lookup.rowCount) return invalidCredential;

  const row = lookup.rows[0];
  if (row.revoked_at !== null) return revokedDevice;
  if (row.account_status !== "active") return inactiveAccount;
  return { kind: "authenticated", context: { deviceId: row.device_id, appUserId: row.app_user_id } };
};
