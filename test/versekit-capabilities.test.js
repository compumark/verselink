import test from "node:test";
import assert from "node:assert/strict";
import { versekitCapabilities } from "../src/integrations/versekit/capabilities.js";

const baseline = { VERSEKIT_ENABLED: "true" };

test("new capability flags opt in exactly in DEV and Production", () => {
  for (const APP_ENVIRONMENT of ["DEV", "Production"]) {
    assert.deepEqual(versekitCapabilities({ ...baseline, APP_ENVIRONMENT, VERSEKIT_ORDERS_WRITE: "true" }),
      ["orders:read", "orders:write"]);
    assert.deepEqual(versekitCapabilities({ ...baseline, APP_ENVIRONMENT, VERSEKIT_BLUEPRINTS_READ: "true" }),
      ["orders:read", "blueprints:read"]);
    assert.deepEqual(versekitCapabilities({ ...baseline, APP_ENVIRONMENT, VERSEKIT_ORDERS_WRITE: "true", VERSEKIT_BLUEPRINTS_READ: "true" }),
      ["orders:read", "blueprints:read", "orders:write"]);
  }
});

test("only literal true enables new flags and defaults remain restrictive", () => {
  assert.deepEqual(versekitCapabilities(baseline), ["orders:read"]);
  assert.deepEqual(versekitCapabilities({ ...baseline, VERSEKIT_ORDERS_WRITE: "true" }), ["orders:read", "orders:write"]);
  for (const value of [undefined, "false", "TRUE", "1", " true", "true ", "", "yes"]) {
    assert.deepEqual(versekitCapabilities({ ...baseline, VERSEKIT_ORDERS_WRITE: value }), ["orders:read"], `orders flag ${String(value)}`);
    assert.deepEqual(versekitCapabilities({ ...baseline, VERSEKIT_BLUEPRINTS_READ: value }), ["orders:read"], `blueprints flag ${String(value)}`);
  }
  assert.deepEqual(versekitCapabilities({ VERSEKIT_ENABLED: "false", VERSEKIT_ORDERS_WRITE: "true", VERSEKIT_BLUEPRINTS_READ: "true" }), ["orders:read"]);
  assert.deepEqual(versekitCapabilities({ VERSEKIT_ENABLED: "TRUE", VERSEKIT_ORDERS_WRITE: "true" }), ["orders:read"]);
  assert.deepEqual(versekitCapabilities(), ["orders:read"]);
  assert.deepEqual(versekitCapabilities(undefined), ["orders:read"]);
});

test("legacy flags are exact DEV-only fallbacks", () => {
  assert.deepEqual(versekitCapabilities({ ...baseline, APP_ENVIRONMENT: "DEV", VERSEKIT_DEV_ORDERS_WRITE: "true" }),
    ["orders:read", "orders:write"]);
  assert.deepEqual(versekitCapabilities({ ...baseline, APP_ENVIRONMENT: "DEV", VERSEKIT_DEV_BLUEPRINTS_READ: "true" }),
    ["orders:read", "blueprints:read"]);
  assert.deepEqual(versekitCapabilities({ ...baseline, APP_ENVIRONMENT: "DEV", VERSEKIT_DEV_ORDERS_WRITE: "true", VERSEKIT_DEV_BLUEPRINTS_READ: "true" }),
    ["orders:read", "blueprints:read", "orders:write"]);
  for (const APP_ENVIRONMENT of ["Production", "production", "dev", undefined]) {
    assert.deepEqual(versekitCapabilities({ ...baseline, APP_ENVIRONMENT, VERSEKIT_DEV_ORDERS_WRITE: "true", VERSEKIT_DEV_BLUEPRINTS_READ: "true" }),
      ["orders:read"], `legacy flags ignored in ${String(APP_ENVIRONMENT)}`);
  }
  for (const value of [undefined, "false", "TRUE", "1", ""]) {
    assert.deepEqual(versekitCapabilities({ ...baseline, APP_ENVIRONMENT: "DEV", VERSEKIT_DEV_ORDERS_WRITE: value }), ["orders:read"]);
    assert.deepEqual(versekitCapabilities({ ...baseline, APP_ENVIRONMENT: "DEV", VERSEKIT_DEV_BLUEPRINTS_READ: value }), ["orders:read"]);
  }
});

test("explicit new flags override legacy DEV fallbacks, including false and malformed values", () => {
  const env = { ...baseline, APP_ENVIRONMENT: "DEV", VERSEKIT_DEV_ORDERS_WRITE: "true", VERSEKIT_DEV_BLUEPRINTS_READ: "true" };
  for (const value of ["false", "TRUE", "1", "", undefined]) {
    assert.deepEqual(versekitCapabilities({ ...env, VERSEKIT_ORDERS_WRITE: value }), ["orders:read", "blueprints:read"]);
    assert.deepEqual(versekitCapabilities({ ...env, VERSEKIT_BLUEPRINTS_READ: value }), ["orders:read", "orders:write"]);
  }
  assert.deepEqual(versekitCapabilities({ ...env, VERSEKIT_ORDERS_WRITE: "false", VERSEKIT_BLUEPRINTS_READ: "false" }), ["orders:read"]);
});
