import test from "node:test";
import assert from "node:assert/strict";
import { versekitBootstrapCapabilities } from "../src/integrations/versekit/dev-write-gate.js";

test("VerseKit write permission is opt-in only for an enabled DEV runtime", () => {
  const base = { VERSEKIT_ENABLED: "true", APP_ENVIRONMENT: "DEV", VERSEKIT_DEV_ORDERS_WRITE: "true" };
  assert.deepEqual(versekitBootstrapCapabilities(base), ["orders:read", "orders:write"]);
  for (const changes of [
    { VERSEKIT_ENABLED: "false" },
    { VERSEKIT_ENABLED: "TRUE" },
    { VERSEKIT_ENABLED: undefined },
    { APP_ENVIRONMENT: "Production" },
    { APP_ENVIRONMENT: "Production UI" },
    { APP_ENVIRONMENT: "dev" },
    { APP_ENVIRONMENT: undefined },
    { VERSEKIT_DEV_ORDERS_WRITE: "false" },
    { VERSEKIT_DEV_ORDERS_WRITE: "TRUE" },
    { VERSEKIT_DEV_ORDERS_WRITE: "1" },
    { VERSEKIT_DEV_ORDERS_WRITE: undefined }
  ]) {
    assert.deepEqual(versekitBootstrapCapabilities({ ...base, ...changes }), ["orders:read"]);
  }
  assert.deepEqual(versekitBootstrapCapabilities({}), ["orders:read"]);
  assert.deepEqual(versekitBootstrapCapabilities(undefined), ["orders:read"]);
});

test("blueprints:read has an independent exact DEV-only opt-in", () => {
  const base = { VERSEKIT_ENABLED: "true", APP_ENVIRONMENT: "DEV", VERSEKIT_DEV_BLUEPRINTS_READ: "true" };
  assert.deepEqual(versekitBootstrapCapabilities(base), ["orders:read", "blueprints:read"]);
  for (const changes of [
    { VERSEKIT_ENABLED: "false" }, { VERSEKIT_ENABLED: "TRUE" }, { APP_ENVIRONMENT: "Production" },
    { APP_ENVIRONMENT: "dev" }, { VERSEKIT_DEV_BLUEPRINTS_READ: "false" },
    { VERSEKIT_DEV_BLUEPRINTS_READ: "TRUE" }, { VERSEKIT_DEV_BLUEPRINTS_READ: "1" },
    { VERSEKIT_DEV_BLUEPRINTS_READ: undefined }
  ]) assert.deepEqual(versekitBootstrapCapabilities({ ...base, ...changes }), ["orders:read"]);
  assert.deepEqual(versekitBootstrapCapabilities({ ...base, VERSEKIT_DEV_ORDERS_WRITE: "true" }),
    ["orders:read", "blueprints:read", "orders:write"]);
  assert.deepEqual(versekitBootstrapCapabilities({ ...base, VERSEKIT_DEV_ORDERS_WRITE: "true", VERSEKIT_DEV_BLUEPRINTS_READ: "false" }),
    ["orders:read", "orders:write"]);
});
