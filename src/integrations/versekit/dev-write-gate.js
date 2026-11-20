// Data capabilities beyond orders:read require exact DEV-only opt-ins.
// Production images report APP_ENVIRONMENT=Production, so stray flags alone
// cannot advertise unreviewed scopes. The adapter remains optional.
export const versekitBootstrapCapabilities = (env) => Object.freeze(
  env?.VERSEKIT_ENABLED !== "true" ? ["orders:read"] : [
    "orders:read",
    ...(env?.APP_ENVIRONMENT === "DEV" && env?.VERSEKIT_DEV_BLUEPRINTS_READ === "true" ? ["blueprints:read"] : []),
    ...(env?.APP_ENVIRONMENT === "DEV" && env?.VERSEKIT_DEV_ORDERS_WRITE === "true" ? ["orders:write"] : [])
  ]
);
