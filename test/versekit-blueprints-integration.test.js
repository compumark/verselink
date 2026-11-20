import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTokenCodec } from "../src/integrations/versekit/tokens.js";
import { apiRequest, startMissionTestServer, stopMissionTestServer, createTestPool, VERSEKIT_TEST_TOKEN_PEPPER } from "./helpers/mission-integration.js";
import { resolveC6TestDatabaseUrl } from "./helpers/c6-test-database.js";

const databaseUrl = resolveC6TestDatabaseUrl(process.env.TEST_DATABASE_URL);
const pepper = "vk08-blueprints-schema-test-sink-pepper";
const accessCodec = createTokenCodec(VERSEKIT_TEST_TOKEN_PEPPER);
const schemaPattern = /^vk08_blueprints_[a-f0-9]{32}$/;
const groupId = randomUUID();

const createSchema = async (pool, schema) => {
  if (!schemaPattern.test(schema)) throw new Error("refusing database operation outside an owned VK-08 test schema");
  await pool.query(`CREATE SCHEMA "${schema}"`);
};
const dropSchema = async (pool, schema) => {
  if (!schemaPattern.test(schema)) throw new Error("refusing database operation outside an owned VK-08 test schema");
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
};
const authRequest = async (url, token) => {
  const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: response.status, body: await response.json(), headers: response.headers };
};

test("VK-08 reads only active fixed-group SCMDB holdings with authenticated stable pagination", { skip: !databaseUrl }, async (t) => {
  const adminPool = await createTestPool(databaseUrl);
  const schema = `vk08_blueprints_${randomUUID().replaceAll("-", "")}`;
  let runtime, pool;
  const logDirectory = join(tmpdir(), `verselink-vk08-${process.pid}-${randomUUID()}`);
  const ids = { first: randomUUID(), second: randomUUID(), outside: randomUUID(), inactive: randomUUID(), removed: randomUUID() };
  const otherGroup = randomUUID();
  const seedUser = async (target, id, display, verselink, status = "active") => target.query(
    "INSERT INTO app_users(id,email,display_name,verselink_name,account_status,is_admin) VALUES($1,$2,$3,$4,$5,false)",
    [id, `${id}@vk08.test`, display, verselink, status]);
  const tokenFor = async (userId, scopes) => {
    const grantId = randomUUID(), familyId = randomUUID();
    const token = accessCodec.issue("vka");
    await pool.query("INSERT INTO versekit_device_grants(id,device_code_hash,user_code_hash,client_id,app_user_id,group_id,requested_scopes,approved_scopes,status,expires_at,consented_at) VALUES($1,$2,$3,'versekit',$4,$5,$6,$6,'consumed',now()+interval '1 day',now())",
      [grantId, createHash("sha256").update(randomUUID()).digest("hex"), createHash("sha256").update(randomUUID()).digest("hex"), userId, groupId, scopes]);
    await pool.query("INSERT INTO versekit_token_families(id,grant_id,client_id,app_user_id,group_id,scopes,absolute_expires_at) VALUES($1,$2,'versekit',$3,$4,$5,now()+interval '1 day')",
      [familyId, grantId, userId, groupId, scopes]);
    await pool.query("INSERT INTO versekit_tokens(family_id,token_hash,token_type,expires_at) VALUES($1,$2,'access',now()+interval '1 hour')",
      [familyId, accessCodec.hash("access", token)]);
    return token;
  };

  try {
    await createSchema(adminPool, schema);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const schemaUrl = scoped.toString();
    const bootstrap = await startMissionTestServer({ databaseUrl: schemaUrl, pepper, logDirectory,
      extraEnv: { VERSEKIT_ENABLED: "false" } });
    await stopMissionTestServer(bootstrap);
    pool = await createTestPool(schemaUrl);
    const version = await pool.query("SHOW server_version_num");
    assert.equal(Number(version.rows[0].server_version_num) >= 160000 && Number(version.rows[0].server_version_num) < 170000, true,
      "VK-08 PostgreSQL integration tests require PostgreSQL 16");
    await pool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,'Configured group'),($2,'Unrelated group')", [groupId, otherGroup]);
    await seedUser(pool, ids.first, "Shared Name", "Shared Name");
    await seedUser(pool, ids.second, "Shared Name", "");
    await seedUser(pool, ids.outside, "Outside Holder", null);
    await seedUser(pool, ids.inactive, "Inactive Holder", null, "blocked");
    await seedUser(pool, ids.removed, "Removed Holder", null);
    await pool.query("INSERT INTO group_members(group_id,app_user_id) VALUES($1,$2),($1,$3),($4,$2),($4,$5),($1,$6)",
      [groupId, ids.first, ids.second, otherGroup, ids.outside, ids.inactive]);
    const connection = async (hash, user, status = "connected", revoked = false) => pool.query(
      "INSERT INTO scmdb_connections(token_hash,app_user_id,connection_status,revoked_at) VALUES($1,$2,$3,CASE WHEN $4 THEN now() ELSE NULL END)",
      [hash, user, status, revoked]);
    const hashes = {
      first1: "1".repeat(64), first2: "2".repeat(64), second: "3".repeat(64), outside: "4".repeat(64),
      inactive: "5".repeat(64), removed: "6".repeat(64), revoked: "7".repeat(64), disconnected: "8".repeat(64)
    };
    await connection(hashes.first1, ids.first);
    await connection(hashes.first2, ids.first);
    await connection(hashes.second, ids.second);
    await connection(hashes.outside, ids.outside);
    await connection(hashes.inactive, ids.inactive);
    await connection(hashes.removed, ids.removed);
    await connection(hashes.revoked, ids.first, "revoked", true);
    await connection(hashes.disconnected, ids.first, "disconnected");
    await pool.query("INSERT INTO reference_blueprints(tag,product_name) VALUES('alpha-tag','Alpha'),('name-a','Shared Blueprint'),('name-b','Shared Blueprint'),('catalog-only','Catalog Only')");
    await pool.query(`INSERT INTO member_blueprints(token_hash,tag,product_name,owned_at) VALUES
      ($1,'alpha-tag','alpha snapshot',1),($1,'name-a','Snapshot A',1),($2,'name-a','Snapshot A duplicate token',2),
      ($3,'name-b','Snapshot B',3),($1,'name-b','Snapshot B',3),($1,'tag-z','   ',4),
      ($4,'outside-tag','Outside only',1),($5,'inactive-tag','Inactive only',1),($6,'removed-tag','Removed only',1),
      ($7,'revoked-tag','Revoked only',1),($8,'disconnected-tag','Disconnected only',1)`,
      [hashes.first1, hashes.first2, hashes.second, hashes.outside, hashes.inactive, hashes.removed, hashes.revoked, hashes.disconnected]);

    runtime = await startMissionTestServer({ databaseUrl: schemaUrl, pepper, logDirectory,
      extraEnv: { APP_ENVIRONMENT: "DEV", VERSEKIT_ENABLED: "true", VERSEKIT_GROUP_ID: groupId,
        VERSEKIT_PUBLIC_URL: "https://verse.example.test", VERSEKIT_TOKEN_PEPPER: VERSEKIT_TEST_TOKEN_PEPPER,
        VERSEKIT_DEV_BLUEPRINTS_READ: "true" } });
    const discover = await apiRequest(runtime.baseUrl, "/.well-known/versekit-org.json");
    assert.deepEqual(discover.body.versions["1"].scopes_supported, ["orders:read", "blueprints:read"]);
    const readToken = await tokenFor(ids.first, ["blueprints:read"]);
    const wrongScope = await tokenFor(ids.first, ["orders:read"]);

    await t.test("authentication and scope enforcement use standard problem responses", async () => {
      const noAuth = await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints`);
      assert.deepEqual([noAuth.status, noAuth.body.code, noAuth.headers.get("content-type")], [401, "UNAUTHORIZED", "application/problem+json; charset=utf-8"]);
      const bad = await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints`, "vka_invalid");
      assert.equal(bad.status, 401);
      const missingScope = await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints`, wrongScope);
      assert.deepEqual([missingScope.status, missingScope.body.code], [403, "SCOPE_MISSING"]);
      assert.equal((await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints`, readToken)).status, 200);
    });

    await t.test("fixed group, active ownership, duplicate names and deterministic fallbacks", async () => {
      const result = await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints`, readToken);
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.blueprints, [
        { name: "Alpha", holders: ["Shared Name"] },
        { name: "Shared Blueprint", holders: ["Shared Name"] },
        { name: "tag-z", holders: ["Shared Name"] }
      ]);
      assert.equal(result.body.next_cursor, null);
      const serialized = JSON.stringify(result.body);
      for (const value of [ids.first, ids.second, ids.outside, "@vk08.test", hashes.first1, "catalog-only", "private profile"]) {
        assert.equal(serialized.includes(value), false, `response must not expose ${value}`);
      }
    });

    await t.test("limit validation, stable pagination and cursor integrity", async () => {
      for (const limit of ["0", "1001", "1.5", "-1"]) {
        const result = await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints?limit=${limit}`, readToken);
        assert.deepEqual([result.status, result.body.code], [400, "INVALID_REQUEST"]);
      }
      const firstPage = await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints?limit=1`, readToken);
      assert.deepEqual(firstPage.body.blueprints.map((x) => x.name), ["Alpha"]);
      assert.equal(typeof firstPage.body.next_cursor, "string");
      const secondPage = await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints?limit=1&cursor=${encodeURIComponent(firstPage.body.next_cursor)}`, readToken);
      assert.deepEqual(secondPage.body.blueprints.map((x) => x.name), ["Shared Blueprint"]);
      const thirdPage = await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints?limit=1&cursor=${encodeURIComponent(secondPage.body.next_cursor)}`, readToken);
      assert.deepEqual(thirdPage.body.blueprints.map((x) => x.name), ["tag-z"]);
      assert.equal(thirdPage.body.next_cursor, null);
      const modified = `${firstPage.body.next_cursor.slice(0, -1)}${firstPage.body.next_cursor.endsWith("A") ? "B" : "A"}`;
      const badCursor = await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints?cursor=${encodeURIComponent(modified)}`, readToken);
      assert.deepEqual([badCursor.status, badCursor.body.code], [400, "INVALID_CURSOR"]);
      const otherMemberToken = await tokenFor(ids.second, ["blueprints:read"]);
      const boundCursor = await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints?cursor=${encodeURIComponent(firstPage.body.next_cursor)}`, otherMemberToken);
      assert.deepEqual([boundCursor.status, boundCursor.body.code], [400, "INVALID_CURSOR"]);
      const duplicate = await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints?limit=1&limit=2`, readToken);
      assert.deepEqual([duplicate.status, duplicate.body.code], [400, "INVALID_REQUEST"]);
    });

    await t.test("membership removal and token revocation take effect immediately", async () => {
      await pool.query("DELETE FROM group_members WHERE group_id=$1 AND app_user_id=$2", [groupId, ids.first]);
      const removed = await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints`, readToken);
      assert.deepEqual([removed.status, removed.body.code], [401, "UNAUTHORIZED"]);
      await pool.query("INSERT INTO group_members(group_id,app_user_id) VALUES($1,$2)", [groupId, ids.first]);
      const family = await pool.query("SELECT family_id FROM versekit_tokens WHERE token_hash=$1", [accessCodec.hash("access", readToken)]);
      await pool.query("UPDATE versekit_tokens SET revoked_at=now() WHERE family_id=$1", [family.rows[0].family_id]);
      const revoked = await authRequest(`${runtime.baseUrl}/versekit/v1/blueprints`, readToken);
      assert.deepEqual([revoked.status, revoked.body.code], [401, "UNAUTHORIZED"]);
    });
  } finally {
    await stopMissionTestServer(runtime);
    await pool?.end();
    await dropSchema(adminPool, schema);
    await adminPool.end();
  }
});

test("VerseKit remains disabled by default and does not serve blueprints routes", { skip: !databaseUrl }, async (t) => {
  const adminPool = await createTestPool(databaseUrl);
  const schema = `vk08_blueprints_${randomUUID().replaceAll("-", "")}`;
  let runtime;
  const logDirectory = join(tmpdir(), `verselink-vk08-disabled-${process.pid}-${randomUUID()}`);
  try {
    await createSchema(adminPool, schema);
    const scoped = new URL(databaseUrl);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    runtime = await startMissionTestServer({ databaseUrl: scoped.toString(), pepper, logDirectory,
      extraEnv: { VERSEKIT_ENABLED: "false", VERSEKIT_DEV_BLUEPRINTS_READ: "true" } });
    const response = await apiRequest(runtime.baseUrl, "/versekit/v1/blueprints");
    assert.deepEqual([response.status, response.body.code], [404, "NOT_FOUND"]);
    assert.equal((await apiRequest(runtime.baseUrl, "/healthz")).status, 200);
  } finally {
    await stopMissionTestServer(runtime);
    await dropSchema(adminPool, schema);
    await adminPool.end();
  }
});
