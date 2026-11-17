import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseVersekitConfig } from "../src/integrations/versekit/config.js";
import { buildDiscovery } from "../src/integrations/versekit/discovery.js";
import { createVersekitAdapter } from "../src/integrations/versekit/index.js";
import { createVersekitRouter } from "../src/integrations/versekit/router.js";
import { resolveC6TestDatabaseUrl } from "./helpers/c6-test-database.js";
import { createTestPool, startMissionTestServer, stopMissionTestServer } from "./helpers/mission-integration.js";

const groupId = "01234567-89ab-4cde-8fab-0123456789ab";
const enabled = { VERSEKIT_ENABLED: "true", VERSEKIT_GROUP_ID: groupId, VERSEKIT_PUBLIC_URL: "https://verse.example.org/" };
const response = () => ({
  headersSent: false, writableEnded: false, status: null, headers: null, body: "",
  writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
  end(body = "") { this.body = body; this.writableEnded = true; }
});
const call = async (router, method, path) => {
  const res = response();
  const handled = await router({ method }, res, new URL(path, "http://internal.invalid"));
  return { handled, res };
};

test("VerseKit is disabled unless the flag is exactly true", async () => {
  for (const value of [undefined, "", "false", "TRUE", "1", " true ", "malformed"]) {
    const env = { ...enabled, VERSEKIT_ENABLED: value };
    assert.equal(parseVersekitConfig(env), null);
    const adapter = await createVersekitAdapter({ env, db: { query() { throw new Error("disabled mode touched DB"); } } });
    assert.equal(adapter, null);
  }
  assert.equal(parseVersekitConfig(enabled).groupId, groupId);
});

test("enabled configuration requires one UUID and a strict HTTPS origin", () => {
  for (const value of [undefined, "", "not-a-uuid", `${groupId},${groupId}`, ` ${groupId}`]) {
    assert.throws(() => parseVersekitConfig({ ...enabled, VERSEKIT_GROUP_ID: value }), /VERSEKIT_GROUP_ID/);
  }
  for (const value of [undefined, "", "http://verse.example.org", "https://user@verse.example.org", "https://verse.example.org/x", "https://verse.example.org/?q=1", "https://verse.example.org/#x", "https://verse.example.org\\evil.test", "https://verse.example.org.evil.test/%2e%2e", "https://bad_host/", "https://example.org:", "https://example.org:/", "https://example.org:0/", "https://example.org:65536/", "https://127.1/", "https://0x7f000001/", "https://0177.0.0.1/", "https://127.0.0.01/", "https://[::1]:/", "https://[::1", "https://example..org/", "https://example.org%2f.evil/"]) {
    assert.throws(() => parseVersekitConfig({ ...enabled, VERSEKIT_PUBLIC_URL: value }), /VERSEKIT_PUBLIC_URL/, String(value));
  }
  assert.deepEqual(parseVersekitConfig(enabled), { groupId, publicOrigin: "https://verse.example.org" });
  assert.equal(parseVersekitConfig({ ...enabled, VERSEKIT_PUBLIC_URL: "https://VERSE.example.org:443" }).publicOrigin, "https://verse.example.org");
  for (const [input, expected] of [
    ["https://127.0.0.1/", "https://127.0.0.1"],
    ["https://example.org:443/", "https://example.org"],
    ["https://example.org:8443/", "https://example.org:8443"],
    ["https://[::1]/", "https://[::1]"],
    ["https://[2001:db8::1]:8443/", "https://[2001:db8::1]:8443"],
    ["https://bücher.example/", "https://xn--bcher-kva.example"]
  ]) assert.equal(parseVersekitConfig({ ...enabled, VERSEKIT_PUBLIC_URL: input }).publicOrigin, expected);
});

test("enabled adapter resolves exactly the configured existing group", async () => {
  const queries = [];
  const db = { async query(sql, params) { queries.push({ sql, params }); return { rows: [{ id: groupId, name: "Example Org" }] }; } };
  const router = await createVersekitAdapter({ env: enabled, db });
  assert.equal(typeof router, "function");
  assert.deepEqual(queries[0].params, [groupId]);
  assert.match(queries[0].sql, /FROM blueprint_groups WHERE id = \$1/);
  assert.equal((await call(router, "GET", "/.well-known/versekit-org.json")).res.status, 404);
  assert.equal((await call(router, "GET", "/device")).res.status, 404);
  assert.equal((await call(router, "POST", "/versekit/v1/token")).res.status, 404);
  assert.equal((await call(router, "GET", "/versekit/v1/orders?group_id=another")).res.status, 404);
  assert.equal(queries.length, 1);
  await assert.rejects(createVersekitAdapter({ env: enabled, db: { query: async () => ({ rows: [] }) } }), /existing group/);
  await assert.rejects(createVersekitAdapter({ env: enabled, db: { query: async () => ({ rows: [{ name: "x".repeat(81) }] }) } }), /group name/);
});

test("discovery builder emits the exact root-host v1 shape for tested future scopes", () => {
  const document = buildDiscovery({ publicOrigin: "https://verse.example.org", groupName: "Example Org", operationalScopes: ["orders:read"] });
  assert.equal(document.standard, "versekit-org");
  assert.deepEqual(document.org, { name: "Example Org" });
  assert.deepEqual(document.versions["1"], {
    api_base: "https://verse.example.org/versekit/v1",
    device_authorization_endpoint: "https://verse.example.org/versekit/v1/device/code",
    token_endpoint: "https://verse.example.org/versekit/v1/token",
    revocation_endpoint: "https://verse.example.org/versekit/v1/revoke",
    verification_uri: "https://verse.example.org/device",
    scopes_supported: ["orders:read"]
  });
  assert.ok(!JSON.stringify(document).includes(groupId));
  assert.equal(buildDiscovery({ publicOrigin: "https://verse.example.org", groupName: "Org", operationalScopes: ["stock:read"], tag: "EX" }).org.tag, "EX");
  for (const scopes of [[], ["invented:read"], ["orders:read", "orders:read"]]) {
    assert.throws(() => buildDiscovery({ publicOrigin: "https://verse.example.org", groupName: "Org", operationalScopes: scopes }), /operational/);
  }
  assert.throws(() => buildDiscovery({ publicOrigin: "https://verse.example.org", groupName: "x".repeat(81), operationalScopes: ["orders:read"] }), /group name/);
  assert.throws(() => buildDiscovery({ publicOrigin: "https://verse.example.org/other", groupName: "Org", operationalScopes: ["orders:read"] }), /validated HTTPS origin/);
});

test("router reserves only VerseKit paths and never serves incomplete capabilities", async () => {
  const router = createVersekitRouter();
  for (const path of ["/api/orders", "/healthz", "/login", "/versekit/v1x", "/groups/123"]) {
    const { handled, res } = await call(router, "GET", path);
    assert.equal(handled, false);
    assert.equal(res.status, null);
  }
  for (const path of ["/.well-known/versekit-org.json", "/device", "/versekit/v1", "/versekit/v1/stock"]) {
    const { handled, res } = await call(router, "GET", path);
    assert.equal(handled, true);
    assert.equal(res.status, 404);
    assert.equal(res.headers["content-type"], "application/problem+json; charset=utf-8");
    assert.deepEqual(JSON.parse(res.body), { type: "about:blank", status: 404, code: "NOT_FOUND" });
  }
});

test("future ready discovery has strict method and query handling", async () => {
  const discovery = buildDiscovery({ publicOrigin: "https://verse.example.org", groupName: "Org", operationalScopes: ["orders:read"] });
  const router = createVersekitRouter({ discovery });
  const ok = (await call(router, "GET", "/.well-known/versekit-org.json")).res;
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), discovery);
  assert.equal((await call(router, "POST", "/.well-known/versekit-org.json")).res.status, 405);
  assert.equal((await call(router, "GET", "/.well-known/versekit-org.json?group_id=other")).res.status, 400);
  assert.equal((await call(router, "GET", "/device")).res.status, 404);
});

test("recoverable discovery errors return a bounded maintenance response", async () => {
  const broken = { toJSON() { throw new Error("private failure"); } };
  const res = (await call(createVersekitRouter({ discovery: broken }), "GET", "/.well-known/versekit-org.json")).res;
  assert.equal(res.status, 503);
  assert.equal(res.headers["retry-after"], "30");
  assert.deepEqual(JSON.parse(res.body), { type: "about:blank", status: 503, code: "MAINTENANCE" });
  assert.ok(!res.body.includes("private failure"));
});

test("enabled VerseKit uses the real HTTP server and isolated blueprint_groups table", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const safeUrl = resolveC6TestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const schema = `vk02_${randomUUID().replaceAll("-", "")}`;
  const admin = await createTestPool(safeUrl);
  const scoped = new URL(safeUrl);
  scoped.searchParams.set("options", `-c search_path=${schema},public`);
  const databaseUrl = scoped.toString();
  const pepper = "vk02-integration-test-pepper";
  const realGroup = randomUUID();
  const anotherGroup = randomUUID();
  let pool;
  let runtime;
  const request = async (path, method = "GET") => {
    const result = await fetch(`${runtime.baseUrl}${path}`, { method, signal: AbortSignal.timeout(5_000) });
    return { status: result.status, headers: result.headers, body: await result.text() };
  };
  try {
    assert.match(schema, /^vk02_[a-f0-9]{32}$/);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    runtime = await startMissionTestServer({ databaseUrl, pepper, extraEnv: { VERSEKIT_ENABLED: "false", VERSEKIT_GROUP_ID: "malformed", VERSEKIT_PUBLIC_URL: "not an origin" } });
    assert.equal((await request("/healthz")).status, 200);
    assert.equal((await request("/login")).status, 200);
    assert.equal((await request("/.well-known/versekit-org.json")).status, 404);
    await stopMissionTestServer(runtime);
    runtime = null;
    pool = await createTestPool(databaseUrl);
    await pool.query("INSERT INTO blueprint_groups (id, name) VALUES ($1, $2), ($3, $4)", [realGroup, "VK02 Test Org", anotherGroup, "Other Private Org"]);
    const actual = { ...enabled, VERSEKIT_GROUP_ID: realGroup, VERSEKIT_PUBLIC_URL: "https://example.org" };
    assert.equal(typeof await createVersekitAdapter({ env: actual, db: pool }), "function");
    await assert.rejects(createVersekitAdapter({ env: { ...actual, VERSEKIT_GROUP_ID: randomUUID() }, db: pool }), /existing group/);
    assert.throws(() => parseVersekitConfig({ ...actual, VERSEKIT_GROUP_ID: "malformed" }), /VERSEKIT_GROUP_ID/);

    runtime = await startMissionTestServer({ databaseUrl, pepper, extraEnv: actual });
    for (const [path, method] of [
      ["/.well-known/versekit-org.json", "GET"], ["/.well-known/versekit-org.json", "POST"],
      ["/device", "GET"], ["/versekit/v1/orders", "GET"],
      ["/versekit/v1/unknown", "POST"]
    ]) {
      const result = await request(path, method);
      assert.equal(result.status, 404, `${method} ${path}`);
      assert.equal(result.headers.get("cache-control"), "no-store");
      assert.deepEqual(JSON.parse(result.body), { type: "about:blank", status: 404, code: "NOT_FOUND" });
      assert.ok(!result.body.includes(realGroup) && !result.body.includes(anotherGroup));
      assert.ok(!result.body.includes("Other Private Org") && !result.body.includes("scopes_supported"));
    }
    assert.equal((await request("/healthz")).status, 200);
    assert.equal((await request("/login")).status, 200);
    assert.notEqual((await request("/api/orders")).headers.get("content-type"), "application/problem+json; charset=utf-8");
    await stopMissionTestServer(runtime);
    runtime = null;

    for (const [badEnv, reason] of [
      [{ ...actual, VERSEKIT_GROUP_ID: "malformed" }, /VERSEKIT_GROUP_ID must be one existing UUID/],
      [{ ...actual, VERSEKIT_GROUP_ID: randomUUID() }, /VERSEKIT_GROUP_ID does not identify an existing group/],
      [{ ...actual, VERSEKIT_PUBLIC_URL: "https:\/\/example.org:/" }, /VERSEKIT_PUBLIC_URL must be an absolute HTTPS origin/]
    ]) {
      const failureLogDir = await mkdtemp(join(tmpdir(), "vk02-startup-"));
      try {
        await assert.rejects(startMissionTestServer({ databaseUrl, pepper, logDirectory: failureLogDir, extraEnv: badEnv }), (error) => {
          assert.match(error.message, /test server exited early/);
          return true;
        });
        const logFiles = await readdir(failureLogDir);
        const startupLog = await readFile(join(failureLogDir, logFiles.find((name) => name.endsWith("_verselink.log"))), "utf8");
        assert.match(startupLog, reason);
      } finally {
        await rm(failureLogDir, { recursive: true, force: true });
      }
    }
    // A rejected lookup follows the same fail-closed adapter path without a listener.
    await assert.rejects(createVersekitAdapter({ env: actual, db: { query: async () => { throw new Error("connection lost"); } } }), /VERSEKIT_GROUP_ID lookup failed/);
  } finally {
    await stopMissionTestServer(runtime);
    await pool?.end();
    if (/^vk02_[a-f0-9]{32}$/.test(schema)) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
