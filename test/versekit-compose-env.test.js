import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const composeAvailable = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
const capabilityNames = ["VERSEKIT_ORDERS_WRITE", "VERSEKIT_BLUEPRINTS_READ"];
const legacyNames = ["VERSEKIT_DEV_ORDERS_WRITE", "VERSEKIT_DEV_BLUEPRINTS_READ"];

const resolveAppEnvironment = (composeFile, overrides) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    ![...capabilityNames, ...legacyNames, "POSTGRES_PASSWORD", "SINK_TOKEN_PEPPER"].includes(key)));
  Object.assign(env, {
    POSTGRES_PASSWORD: "compose-test-password",
    SINK_TOKEN_PEPPER: "compose-test-sink-pepper",
    APP_LOG_PATH: "./compose-test-logs",
    POSTGRES_DATA_PATH: "./compose-test-postgres",
    ...overrides
  });
  const result = spawnSync("docker", ["compose", "-f", composeFile, "config", "--format", "json"], {
    cwd: repoRoot,
    env,
    encoding: "utf8"
  });
  assert.equal(result.status, 0, `docker compose config failed for ${composeFile}: ${result.stderr}`);
  return JSON.parse(result.stdout).services.app.environment;
};

test("Compose forwards capability values without collapsing unset and empty flags", { skip: !composeAvailable }, () => {
  for (const composeFile of ["docker-compose.yml", "docker-compose.bind.yml"]) {
    const legacyFallback = resolveAppEnvironment(composeFile, {
      VERSEKIT_DEV_ORDERS_WRITE: "true",
      VERSEKIT_DEV_BLUEPRINTS_READ: "true"
    });
    assert.equal(legacyFallback.VERSEKIT_DEV_ORDERS_WRITE, "true");
    assert.equal(legacyFallback.VERSEKIT_DEV_BLUEPRINTS_READ, "true");
    for (const name of capabilityNames) {
      assert.ok(legacyFallback[name] == null, `${composeFile} must leave unset ${name} unset for DEV fallback`);
    }

    const explicitEmpty = resolveAppEnvironment(composeFile, {
      VERSEKIT_ORDERS_WRITE: "",
      VERSEKIT_BLUEPRINTS_READ: "",
      VERSEKIT_DEV_ORDERS_WRITE: "true",
      VERSEKIT_DEV_BLUEPRINTS_READ: "true"
    });
    assert.equal(explicitEmpty.VERSEKIT_ORDERS_WRITE, "", `${composeFile} must preserve explicit empty orders flag`);
    assert.equal(explicitEmpty.VERSEKIT_BLUEPRINTS_READ, "", `${composeFile} must preserve explicit empty blueprints flag`);

    const explicitFalse = resolveAppEnvironment(composeFile, {
      VERSEKIT_ORDERS_WRITE: "false",
      VERSEKIT_BLUEPRINTS_READ: "false"
    });
    assert.equal(explicitFalse.VERSEKIT_ORDERS_WRITE, "false");
    assert.equal(explicitFalse.VERSEKIT_BLUEPRINTS_READ, "false");

    const explicitTrue = resolveAppEnvironment(composeFile, {
      VERSEKIT_ORDERS_WRITE: "true",
      VERSEKIT_BLUEPRINTS_READ: "true"
    });
    assert.equal(explicitTrue.VERSEKIT_ORDERS_WRITE, "true");
    assert.equal(explicitTrue.VERSEKIT_BLUEPRINTS_READ, "true");
  }
});
