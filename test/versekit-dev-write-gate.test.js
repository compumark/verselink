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
