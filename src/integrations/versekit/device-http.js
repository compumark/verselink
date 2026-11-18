import { STANDARD_SCOPES } from "./discovery.js";
import { oauthJson } from "./tokens.js";
import { sendProblem } from "./router.js";
import { parseVersekitForm, readVersekitForm, rejectUnreadVersekitRequest } from "./request-form.js";

const CLIENT_ID = "versekit";
const oauthError = (res, status, error, retryAfter) => oauthJson(res, status, { error }, retryAfter ? { "retry-after": String(retryAfter) } : {});
const parseForm = async (req, res, deadlineMs) => {
  const result = await readVersekitForm(req, res, { deadlineMs, mode: "oauth" });
  if (result.responded || result.error) return result;
  const values = parseVersekitForm(result.body);
  return values ? { values } : { error: "invalid_request" };
};
const scopeSet = (raw, operationalScopes) => {
  const known = new Set(STANDARD_SCOPES);
  return [...new Set(String(raw || "").trim().split(/\s+/).filter((s) => s && known.has(s) && operationalScopes.includes(s)))];
};

export const createDeviceAuthorizationHandlers = ({
  tokenStore, publicOrigin, context, operationalScopes = [], deviceCodeLimiter, tokenLimiter, revokeLimiter, meLimiter,
  requestBodyDeadlineMs
}) => {
  const deviceCode = async (req, res) => {
    const rate = deviceCodeLimiter.consume(req.socket?.remoteAddress || "unknown");
    if (!rate.allowed) return rejectUnreadVersekitRequest(req, res, () => oauthError(res, 429, "temporarily_unavailable", rate.retryAfter));
    const form = await parseForm(req, res, requestBodyDeadlineMs);
    if (form.responded) return;
    if (form.error) return oauthError(res, 400, form.error);
    const clientId = form.values.get("client_id");
    if (clientId !== CLIENT_ID) return oauthError(res, 400, "invalid_request");
    if (!form.values.has("scope")) return oauthError(res, 400, "invalid_request");
    const scopes = scopeSet(form.values.get("scope"), operationalScopes);
    if (!scopes.length) return oauthError(res, 400, "invalid_scope");
    try {
      const grant = await tokenStore.createDeviceGrant({ clientId, scopes, expiresIn: 600, interval: 5 });
      return oauthJson(res, 200, {
        device_code: grant.deviceCode,
        user_code: grant.userCode,
        verification_uri: publicOrigin + "/device",
        expires_in: 600,
        interval: 5
      });
    } catch (error) {
      if (error.code === "VERSEKIT_GRANT_CAPACITY") return oauthError(res, 429, "temporarily_unavailable", error.retryAfter || 900);
      return oauthError(res, 503, "temporarily_unavailable", 30);
    }
  };

  const token = async (req, res) => {
    const rate = tokenLimiter.consume(req.socket?.remoteAddress || "unknown");
    if (!rate.allowed) return rejectUnreadVersekitRequest(req, res, () => oauthError(res, 429, "temporarily_unavailable", rate.retryAfter));
    const form = await parseForm(req, res, requestBodyDeadlineMs);
    if (form.responded) return;
    if (form.error) return oauthError(res, 400, form.error);
    const fields = form.values;
    const clientId = fields.get("client_id");
    if (clientId !== CLIENT_ID) return oauthError(res, 400, "invalid_request");
    try {
      const grantType = fields.get("grant_type");
      if (!grantType) return oauthError(res, 400, "invalid_request");
      let result;
      if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
        const deviceCode = fields.get("device_code");
        if (!deviceCode || deviceCode.length > 256) return oauthError(res, 400, "invalid_grant");
        result = await tokenStore.exchangeDeviceCode({ deviceCode, clientId });
      } else if (grantType === "refresh_token") {
        const refreshToken = fields.get("refresh_token");
        if (!refreshToken || refreshToken.length > 512) return oauthError(res, 400, "invalid_request");
        result = await tokenStore.refresh({ refreshToken, clientId });
      } else return oauthError(res, 400, "unsupported_grant_type");
      if (result.error) {
        const retryAfter = result.error === "slow_down" ? (result.interval || 10) : undefined;
        return oauthError(res, 400, result.error, retryAfter);
      }
      return oauthJson(res, 200, result.tokens);
    } catch {
      return oauthError(res, 503, "temporarily_unavailable", 30);
    }
  };

  const revoke = async (req, res) => {
    const rate = revokeLimiter.consume(req.socket?.remoteAddress || "unknown");
    if (!rate.allowed) return rejectUnreadVersekitRequest(req, res, () => oauthError(res, 429, "temporarily_unavailable", rate.retryAfter));
    const form = await parseForm(req, res, requestBodyDeadlineMs);
    if (form.responded) return;
    if (form.error) return oauthError(res, 400, form.error);
    const fields = form.values;
    if (!fields.get("token") || fields.get("token").length > 512) return oauthError(res, 400, "invalid_request");
    if (fields.has("client_id") && fields.get("client_id") !== CLIENT_ID) return oauthError(res, 400, "invalid_request");
    // RFC 7009 treats token_type_hint as advisory. Unknown hints do not affect lookup.
    try { await tokenStore.revoke(fields.get("token")); }
    catch { return oauthError(res, 503, "temporarily_unavailable", 30); }
    res.writeHead(200, { "cache-control": "no-store", pragma: "no-cache" });
    res.end();
  };

  const me = async (req, res, url) => {
    const rate = meLimiter.consume(req.socket?.remoteAddress || "unknown");
    if (!rate.allowed) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 429, "RATE_LIMITED", { "retry-after": String(Math.max(1, rate.retryAfter)) }));
    if (url.search) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "INVALID_REQUEST"));
    const authorization = String(req.headers?.authorization || "");
    const match = /^Bearer (vka_[A-Za-z0-9_-]{43})$/i.exec(authorization);
    if (!match) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 401, "UNAUTHORIZED", { "www-authenticate": 'Bearer error="invalid_token"' }));
    try {
      const member = await tokenStore.authenticateAccess(match[1]);
      if (!member) return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 401, "UNAUTHORIZED", { "www-authenticate": 'Bearer error="invalid_token"' }));
      return oauthJson(res, 200, {
        member: { id: member.app_user_id, name: member.verselink_name || member.display_name },
        org: { name: context.groupName },
        scopes: member.scopes
      });
    } catch { return rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 503, "MAINTENANCE", { "retry-after": "30" })); }
  };

  return Object.freeze({ deviceCode, token, revoke, me });
};

export const mountDeviceAuthorization = (router, handlers) => {
  const original = router;
  return async (req, res, url) => {
    if (["/versekit/v1/device/code", "/versekit/v1/token", "/versekit/v1/revoke"].includes(url.pathname)) {
      if (req.method !== "POST" || url.search) {
        rejectUnreadVersekitRequest(req, res, () => oauthJson(res, 400, { error: "invalid_request" }));
        return true;
      }
      if (url.pathname === "/versekit/v1/device/code") await handlers.deviceCode(req, res);
      else if (url.pathname === "/versekit/v1/token") await handlers.token(req, res);
      else await handlers.revoke(req, res);
      return true;
    }
    if (url.pathname === "/versekit/v1/me") {
      if (req.method !== "GET") {
        rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 405, "METHOD_NOT_ALLOWED", { allow: "GET" }));
        return true;
      }
      await handlers.me(req, res, url);
      return true;
    }
    return original(req, res, url);
  };
};
