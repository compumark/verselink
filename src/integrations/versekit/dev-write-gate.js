// A second exact opt-in is required for DEV write testing. Production images
// report APP_ENVIRONMENT=Production, so a stray flag alone is not sufficient.
// The entire VerseKit adapter remains optional under VERSEKIT_ENABLED=true.
export const versekitBootstrapCapabilities = (env) => Object.freeze(
  env?.VERSEKIT_ENABLED === "true"
    && env?.APP_ENVIRONMENT === "DEV"
    && env?.VERSEKIT_DEV_ORDERS_WRITE === "true"
      ? ["orders:read", "orders:write"]
      : ["orders:read"]
);
