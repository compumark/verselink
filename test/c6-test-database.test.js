import assert from "node:assert/strict";
import test from "node:test";
import { createC6TestPool, createC6TestSchema, createC7TestSchema, createC8TestSchema, dropC6TestSchema, dropC7TestSchema, dropC8TestSchema, resolveC6TestDatabaseUrl } from "./helpers/c6-test-database.js";

test("C6 database guard accepts only PostgreSQL verselink_test on loopback", async () => {
  for (const value of [
    "postgres://verselink:secret@localhost:5432/verselink_test",
    "postgresql://verselink:secret@127.0.0.1:5432/verselink_test",
    "postgres://verselink:secret@[::1]:5432/verselink_test"
  ]) {
    assert.equal(resolveC6TestDatabaseUrl(value), value);
  }
  assert.equal(resolveC6TestDatabaseUrl(undefined), null);
});

test("C6 database guard rejects unsafe URLs before invoking the pool factory", async () => {
  let connections = 0;
  const poolFactory = async () => { connections += 1; return {}; };
  const rejected = [
    undefined,
    "not a URL",
    "postgres://user:credential-secret@localhost:5432/production",
    "postgres://user:credential-secret@db.example.test:5432/verselink_test",
    "https://localhost/verselink_test"
  ];
  for (const value of rejected) {
    await assert.rejects(createC6TestPool(value, poolFactory));
    assert.equal(connections, 0);
  }
});

test("C6 database guard errors never echo URL credentials", async () => {
  const secret = "credential-secret-marker";
  for (const value of [
    `invalid://${secret}`,
    `postgres://user:${secret}@localhost:5432/production`,
    `postgres://user:${secret}@external.example.test:5432/verselink_test`
  ]) {
    assert.throws(() => resolveC6TestDatabaseUrl(value), (error) => !error.message.includes(secret));
  }
});

test("C6 cleanup and schema creation are confined to the generated C6 schema", async () => {
  const calls = [];
  const pool = { query: async (sql) => { calls.push(sql); } };
  const ownedSchema = `c6_heartbeat_${"a".repeat(32)}`;
  await createC6TestSchema(pool, ownedSchema);
  await dropC6TestSchema(pool, ownedSchema);
  assert.deepEqual(calls, [
    `CREATE SCHEMA "${ownedSchema}"`,
    `DROP SCHEMA IF EXISTS "${ownedSchema}" CASCADE`
  ]);
  for (const unsafe of ["public", "app", "c6_heartbeat_not-a-uuid"]) {
    await assert.rejects(dropC6TestSchema(pool, unsafe));
    await assert.rejects(createC6TestSchema(pool, unsafe));
  }
  assert.equal(calls.length, 2);
});

test("C7 schema creation and cleanup are confined to a generated presence schema", async () => {
  const calls = [];
  const pool = { query: async (sql) => { calls.push(sql); } };
  const ownedSchema = `c7_presence_${"b".repeat(32)}`;
  await createC7TestSchema(pool, ownedSchema);
  await dropC7TestSchema(pool, ownedSchema);
  assert.deepEqual(calls, [
    `CREATE SCHEMA "${ownedSchema}"`,
    `DROP SCHEMA IF EXISTS "${ownedSchema}" CASCADE`
  ]);
  for (const unsafe of ["public", "app", "c7_presence_not-a-uuid", `c6_heartbeat_${"a".repeat(32)}`]) {
    await assert.rejects(dropC7TestSchema(pool, unsafe));
    await assert.rejects(createC7TestSchema(pool, unsafe));
  }
  assert.equal(calls.length, 2);
});

test("C8 and C9 schema creation and cleanup accept only their generated owned schemas", async () => {
  const calls = [];
  const pool = { query: async (sql) => { calls.push(sql); } };
  const c8Schema = `c8_history_${"a".repeat(32)}`;
  const c9Schema = `c9_e2e_${"b".repeat(32)}`;
  await createC8TestSchema(pool, c8Schema);
  await dropC8TestSchema(pool, c8Schema);
  await createC8TestSchema(pool, c9Schema);
  await dropC8TestSchema(pool, c9Schema);
  assert.deepEqual(calls, [
    `CREATE SCHEMA "${c8Schema}"`,
    `DROP SCHEMA IF EXISTS "${c8Schema}" CASCADE`,
    `CREATE SCHEMA "${c9Schema}"`,
    `DROP SCHEMA IF EXISTS "${c9Schema}" CASCADE`
  ]);

  for (const unsafe of [
    "public",
    "c8_history_not-a-uuid",
    `c8_history_${"A".repeat(32)}`,
    `c9_e2e_${"b".repeat(31)}`,
    `c9_e2e_${"b".repeat(32)}x`,
    `c9_history_${"b".repeat(32)}`,
    `c8_e2e_${"a".repeat(32)}`
  ]) {
    await assert.rejects(createC8TestSchema(pool, unsafe));
    await assert.rejects(dropC8TestSchema(pool, unsafe));
  }
  assert.equal(calls.length, 4, "rejected schemas must not issue SQL");
});
