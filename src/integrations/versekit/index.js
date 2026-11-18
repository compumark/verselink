import { parseVersekitConfig } from "./config.js";
import { createVersekitRouter } from "./router.js";
import { initializeVersekitSchema } from "./schema.js";
import { createTokenCodec } from "./tokens.js";
import { VersekitTokenStore } from "./store.js";
import { createRequestRateLimiter } from "../../rate-limit.js";
import { STANDARD_SCOPES } from "./discovery.js";
import { createDeviceAuthorizationHandlers, mountDeviceAuthorization } from "./device-http.js";
import { createConsentHandlers } from "./consent-http.js";
import { VERSEKIT_FORM_BODY_DEADLINE_MS } from "./request-form.js";
import { VERSEKIT_MAX_RETAINED_GRANTS } from "./store.js";

// No OAuth or data handlers exist in VK-02. Environment variables cannot enable scopes.
const operationalScopes = Object.freeze([]);

export const createVersekitAdapter = async ({ env, db, pepper, capabilities = [], deviceCodeLimiter, tokenLimiter,
  getSessionContext = async () => null, getCurrentAppUser = async () => null, getSessionToken = () => null, sameOrigin = () => false,
  consentLimiter, revokeLimiter, meLimiter, requestBodyDeadlineMs = VERSEKIT_FORM_BODY_DEADLINE_MS,
  maxRetainedGrants = VERSEKIT_MAX_RETAINED_GRANTS, quotaPolicy }) => {
  const config = parseVersekitConfig(env);
  if (!config) return null;
  let result;
  try { result = await db.query("SELECT id, name FROM blueprint_groups WHERE id = $1", [config.groupId]); }
  catch { throw new Error("VERSEKIT_GROUP_ID lookup failed"); }
  const group = result.rows[0];
  if (!group) throw new Error("VERSEKIT_GROUP_ID does not identify an existing group");
  if (typeof group.name !== "string" || !group.name.trim() || group.name.length > 80) {
    throw new Error("VERSEKIT_GROUP_ID group name must contain 1–80 characters");
  }
  // The context is immutable and never derived from a request.
  const context = Object.freeze({ ...config, groupName: group.name.trim() });
  if (!Array.isArray(capabilities) || new Set(capabilities).size !== capabilities.length
      || capabilities.some((scope) => !STANDARD_SCOPES.includes(scope))) {
    throw new Error("VerseKit capabilities must be a unique subset of the standard scopes");
  }
  if (operationalScopes.length !== 0) throw new Error("VK-02 cannot advertise operational scopes");
  if (typeof pepper !== "string" || Buffer.byteLength(pepper) < 32) {
    throw new Error("SINK_TOKEN_PEPPER must provide at least 32 bytes when VerseKit is enabled");
  }
  await initializeVersekitSchema(db, quotaPolicy);
  const activeScopes = Object.freeze([...capabilities]);
  const tokenStore = new VersekitTokenStore({ db, codec: createTokenCodec(pepper), groupId: context.groupId, operationalScopes: activeScopes, maxRetainedGrants });
  let cleanupRunning = false;
  const cleanupTimer = setInterval(async () => {
    if (cleanupRunning) return;
    cleanupRunning = true;
    const startedAt = Date.now();
    try {
      const counts = await tokenStore.cleanupCredentials({ batchSize: 200 });
      if (Object.values(counts).some((count) => count > 0)) console.info("versekit.credentials.cleanup", { ...counts, duration_ms: Date.now() - startedAt });
    } catch (error) {
      console.warn("versekit.credentials.cleanup.failed", { reason: error.code || "database_error", duration_ms: Date.now() - startedAt });
    } finally { cleanupRunning = false; }
  }, 15 * 60_000);
  cleanupTimer.unref?.();
  const codec = createTokenCodec(pepper);
  const router = createVersekitRouter({ context, tokenStore });
  const oauthHandlers = createDeviceAuthorizationHandlers({
    tokenStore,
    publicOrigin: context.publicOrigin,
    operationalScopes: activeScopes,
    deviceCodeLimiter: deviceCodeLimiter || createRequestRateLimiter({ limit: 10, windowMs: 10 * 60_000 }),
    tokenLimiter: tokenLimiter || createRequestRateLimiter({ limit: 60, windowMs: 60_000 }),
    revokeLimiter: revokeLimiter || createRequestRateLimiter({ limit: 30, windowMs: 60_000 }),
    meLimiter: meLimiter || createRequestRateLimiter({ limit: 120, windowMs: 60_000 }),
    requestBodyDeadlineMs,
    context
  });
  const oauthRouter = mountDeviceAuthorization(router, oauthHandlers);
  const consentHandler = createConsentHandlers({ context, tokenStore, codec, getSessionContext, getCurrentAppUser, getSessionToken, sameOrigin,
    lookupLimiter: consentLimiter || createRequestRateLimiter({ limit: 20, windowMs: 10 * 60_000 }), requestBodyDeadlineMs });
  return async (req, res, url) => (await consentHandler(req, res, url)) || oauthRouter(req, res, url);
};
