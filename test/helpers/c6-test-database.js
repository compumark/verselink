import { isIP } from "node:net";
import { createTestPool } from "./mission-integration.js";

const schemaPattern = /^c6_heartbeat_[a-f0-9]{32}$/;

const loopbackHost = (hostname) => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) return Number(host.split(".")[0]) === 127;
  return false;
};

export const resolveC6TestDatabaseUrl = (value) => {
  if (value == null || value === "") return null;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid local PostgreSQL test URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must use PostgreSQL and target the C6 test database");
  }
  let databaseName;
  try {
    databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  } catch {
    throw new Error("TEST_DATABASE_URL must target the C6 test database");
  }
  if (databaseName !== "verselink_test") {
    throw new Error("TEST_DATABASE_URL must target the local verselink_test database");
  }
  if (!loopbackHost(parsed.hostname)) {
    throw new Error("TEST_DATABASE_URL must use a loopback host for the C6 test database");
  }
  return value;
};

export const createC6TestPool = async (value, poolFactory = createTestPool) => {
  const safeUrl = resolveC6TestDatabaseUrl(value);
  if (!safeUrl) throw new Error("TEST_DATABASE_URL is required for C6 database operations");
  return poolFactory(safeUrl);
};

const assertC6SchemaName = (schemaName) => {
  if (typeof schemaName !== "string" || !schemaPattern.test(schemaName)) {
    throw new Error("refusing database operation outside an owned C6 test schema");
  }
};

export const createC6TestSchema = async (pool, schemaName) => {
  assertC6SchemaName(schemaName);
  return pool.query(`CREATE SCHEMA "${schemaName}"`);
};

export const dropC6TestSchema = async (pool, schemaName) => {
  assertC6SchemaName(schemaName);
  return pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
};
