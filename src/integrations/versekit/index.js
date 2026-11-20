import { parseVersekitConfig } from "./config.js";
import { createVersekitRouter } from "./router.js";
import { activateVersekitAuthorizationGroup, initializeVersekitSchema } from "./schema.js";
import { createTokenCodec } from "./tokens.js";
import { VersekitTokenStore } from "./store.js";
import { createRequestRateLimiter } from "../../rate-limit.js";
import { STANDARD_SCOPES, buildDiscovery } from "./discovery.js";
import { createDeviceAuthorizationHandlers, mountDeviceAuthorization } from "./device-http.js";
import { createConsentHandlers } from "./consent-http.js";
import { VERSEKIT_FORM_BODY_DEADLINE_MS } from "./request-form.js";
import { VERSEKIT_MAX_RETAINED_GRANTS } from "./store.js";
import { assertOrdersReadiness, createOrdersCursorCodec, createOrdersHandler } from "./orders.js";
import { createOrdersWriteHandler } from "./orders-write.js";
import { createBlueprintCursorCodec, createBlueprintsHandler } from "./blueprints.js";

const implementedScopes = Object.freeze(["orders:read", "orders:write", "blueprints:read"]);

export const createVersekitAdapter = async ({ env, db, tokenPepper, capabilities = [], deviceCodeLimiter, tokenLimiter,
  getSessionContext = async () => null, getCurrentAppUser = async () => null, getSessionToken = () => null, sameOrigin = () => false,
  consentLimiter, revokeLimiter, meLimiter, ordersLimiter, ordersWriteLimiter, blueprintsLimiter, requestBodyDeadlineMs = VERSEKIT_FORM_BODY_DEADLINE_MS,
  maxRetainedGrants = VERSEKIT_MAX_RETAINED_GRANTS, quotaPolicy }) => {
  const config = parseVersekitConfig(env);
  if (!config) return null;
  if (typeof tokenPepper !== "string" || Buffer.byteLength(tokenPepper, "utf8") < 32) {
    throw new Error("VERSEKIT_TOKEN_PEPPER must provide at least 32 UTF-8 bytes when VerseKit is enabled");
  }
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
      || capabilities.some((scope) => !STANDARD_SCOPES.includes(scope) || !implementedScopes.includes(scope))) {
    throw new Error("VerseKit capabilities must be a unique subset of the standard scopes");
  }
  const activeScopes = Object.freeze([...capabilities]);
  if (activeScopes.includes("orders:read")) await assertOrdersReadiness({ db, groupId: context.groupId });
  await initializeVersekitSchema(db, quotaPolicy);
  await activateVersekitAuthorizationGroup(db, context.groupId);
  const tokenStore = new VersekitTokenStore({ db, codec: createTokenCodec(tokenPepper), groupId: context.groupId, operationalScopes: activeScopes, maxRetainedGrants });
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
  const codec = createTokenCodec(tokenPepper);
  const cursorCodec = createOrdersCursorCodec(tokenPepper);
  const blueprintCursorCodec = createBlueprintCursorCodec(tokenPepper);
  const discovery = buildDiscovery({ publicOrigin: context.publicOrigin, groupName: context.groupName, operationalScopes: activeScopes });
  const incompatibleDiagnostics = new Map();
  const onOrdersIncompatible = (reason) => {
    const now = Date.now();
    if (now - (incompatibleDiagnostics.get(reason) || 0) < 60_000) return;
    incompatibleDiagnostics.set(reason, now);
    console.warn("versekit.orders.read.incompatible", { reason });
  };
  const orders = createOrdersHandler({ db, groupId: context.groupId, tokenStore, cursorCodec, onIncompatible: onOrdersIncompatible,
    limiter: ordersLimiter || createRequestRateLimiter({ limit: 120, windowMs: 60_000 }) });
  const blueprints = activeScopes.includes("blueprints:read") ? createBlueprintsHandler({ db, groupId: context.groupId,
    tokenStore, cursorCodec: blueprintCursorCodec, limiter: blueprintsLimiter || createRequestRateLimiter({ limit: 120, windowMs: 60_000 }) }) : null;
  const ordersWrite = activeScopes.includes("orders:write") ? createOrdersWriteHandler({ db, groupId: context.groupId, tokenStore,
    limiter: ordersWriteLimiter || createRequestRateLimiter({ limit: 60, windowMs: 60_000 }) }) : null;
  const router = createVersekitRouter({ context, tokenStore, discovery, orders, ordersWrite, blueprints });
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
