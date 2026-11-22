// orders:read is the adapter's baseline. Additional implemented capabilities
// require their own exact opt-in; legacy DEV names remain DEV-only fallbacks.
const enabled = (env, name, legacyName) => {
  if (Object.hasOwn(env, name)) return env[name] === "true";
  return env.APP_ENVIRONMENT === "DEV" && env[legacyName] === "true";
};

export const versekitCapabilities = (env = {}) => Object.freeze(
  env?.VERSEKIT_ENABLED !== "true" ? ["orders:read"] : [
    "orders:read",
    ...(enabled(env, "VERSEKIT_BLUEPRINTS_READ", "VERSEKIT_DEV_BLUEPRINTS_READ") ? ["blueprints:read"] : []),
    ...(enabled(env, "VERSEKIT_ORDERS_WRITE", "VERSEKIT_DEV_ORDERS_WRITE") ? ["orders:write"] : [])
  ]
);
