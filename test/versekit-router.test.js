import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { parseVersekitConfig } from "../src/integrations/versekit/config.js";
import { buildDiscovery } from "../src/integrations/versekit/discovery.js";
import { createVersekitAdapter } from "../src/integrations/versekit/index.js";
import { sendAuthorizationFailure } from "../src/integrations/versekit/device-http.js";
import { createConsentHandlers } from "../src/integrations/versekit/consent-http.js";
import { createVersekitRouter } from "../src/integrations/versekit/router.js";
import { activateVersekitAuthorizationGroup, initializeVersekitSchema } from "../src/integrations/versekit/schema.js";
import { createTokenCodec, newUserCode, normalizeUserCode } from "../src/integrations/versekit/tokens.js";
import { VersekitTokenStore } from "../src/integrations/versekit/store.js";
import { VERSEKIT_FORM_BODY_LIMIT } from "../src/integrations/versekit/request-form.js";
import { createRequestRateLimiter } from "../src/rate-limit.js";
import { resolveC6TestDatabaseUrl } from "./helpers/c6-test-database.js";
import { createSession, createTestPool, startMissionTestServer, stopMissionTestServer, VERSEKIT_TEST_TOKEN_PEPPER } from "./helpers/mission-integration.js";

const groupId = "01234567-89ab-4cde-8fab-0123456789ab";
const enabled = { VERSEKIT_ENABLED: "true", VERSEKIT_GROUP_ID: groupId, VERSEKIT_PUBLIC_URL: "https://verse.example.org/" };
const testPepper = VERSEKIT_TEST_TOKEN_PEPPER;
const testQuotaPolicy = Object.freeze({ capacity: 4096, refillIntervalSeconds: 3600 });
const response = () => ({
  headersSent: false, writableEnded: false, destroyed: false, status: null, headers: null, body: "", listeners: new Map(), pendingHeaders: {},
  setHeader(name, value) { this.pendingHeaders[name.toLowerCase()] = value; },
  writeHead(status, headers) { this.status = status; this.headers = { ...this.pendingHeaders, ...headers }; this.headersSent = true; },
  once(event, callback) { this.listeners.set(event, callback); return this; },
  off(event) { this.listeners.delete(event); return this; },
  end(body = "") { this.body = body; this.writableEnded = true; queueMicrotask(() => this.listeners.get("finish")?.()); }
});
const call = async (router, method, path) => {
  const res = response();
  const req = Readable.from([]);
  req.method = method;
  req.headers = {};
  req.socket = { remoteAddress: "127.0.0.1", destroyed: false, end() { this.destroyed = true; }, destroy() { this.destroyed = true; }, destroySoon() { this.destroyed = true; } };
  const handled = await router(req, res, new URL(path, "http://internal.invalid"));
  return { handled, res };
};

const callForm = async (router, fields) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
  }
  const req = Readable.from([Buffer.from(body.toString())]);
  req.method = "POST";
  req.headers = { "content-type": "application/x-www-form-urlencoded" };
  req.socket = { remoteAddress: "127.0.0.1", destroyed: false, end() { this.destroyed = true; }, destroy() { this.destroyed = true; }, destroySoon() { this.destroyed = true; } };
  const res = response();
  const handled = await router(req, res, new URL("/device", "http://internal.invalid"));
  return { handled, res };
};

test("VerseKit consent UI renders escaped standalone states and preserves native dynamic permission forms", async () => {
  const codec = createTokenCodec(testPepper);
  const sessionToken = "consent-ui-test-session-token-123456";
  const requestedScopes = ["orders:read", "blueprints:read"];
  let sameOrigin = true;
  let allowLookups = true;
  let challengeAvailable = true;
  let lastDecision;
  const tokenStore = {
    db: { async query() { return { rowCount: 1 }; } },
    operationalScopes: requestedScopes,
    async createConsentChallenge() {
      return challengeAvailable ? { challenge: "challenge-ui-test", scopes: requestedScopes } : null;
    },
    async decideConsent(decision) { lastDecision = decision; return true; }
  };
  const handler = createConsentHandlers({
    context: { groupId, groupName: '<img src=x onerror="alert(1)">' },
    tokenStore,
    codec,
    getSessionContext: async () => ({ appUserId: "ui-member" }),
    getCurrentAppUser: async () => ({ id: "ui-member", display_name: "</strong><svg onload=alert(2)>", account_status: "active" }),
    getSessionToken: async () => sessionToken,
    sameOrigin: () => sameOrigin,
    lookupLimiter: { consume: () => ({ allowed: allowLookups }) }
  });

  const codePage = (await call(handler, "GET", "/device")).res;
  assert.equal(codePage.status, 200);
  assert.match(codePage.body, /href="\/device-consent\.css"/);
  assert.equal(codePage.headers["cache-control"], "no-store");
  assert.equal(codePage.headers["x-frame-options"], "DENY");
  assert.equal(codePage.headers["x-content-type-options"], "nosniff");
  assert.equal(codePage.headers["referrer-policy"], "same-origin");
  assert.equal(codePage.headers["content-security-policy"], "default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  assert.doesNotMatch(codePage.body, /<script\b|https?:\/\//i);
  assert.match(codePage.body, /VerseLink/);
  assert.match(codePage.body, /REQUESTING APPLICATION/);
  assert.match(codePage.body, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(codePage.body, /&lt;\/strong&gt;&lt;svg onload=alert\(2\)&gt;/);
  assert.doesNotMatch(codePage.body, /<img src=x|<svg onload/);
  assert.match(codePage.body, /name="action" value="lookup"/);
  assert.match(codePage.body, /name="csrf" value="[^"]+"/);
  assert.match(codePage.body, /name="user_code"/);

  const csrf = /name="csrf" value="([^"]+)"/.exec(codePage.body)?.[1];
  const userCode = newUserCode();
  const lookup = (await callForm(handler, { action: "lookup", csrf, user_code: userCode })).res;
  assert.equal(lookup.status, 200);
  assert.match(lookup.body, /Review VerseKit access/);
  assert.match(lookup.body, /Requesting application: <strong>VerseKit<\/strong>/);
  assert.match(lookup.body, /<code>orders:read<\/code>/);
  assert.match(lookup.body, /<code>blueprints:read<\/code>/);
  assert.equal((lookup.body.match(/name="scope"/g) || []).length, requestedScopes.length);
  assert.doesNotMatch(lookup.body, /\bchecked(?:\s|=|>)/i);
  assert.match(lookup.body, /name="action" value="approve"/);
  assert.match(lookup.body, /name="action" value="deny"/);
  assert.equal((lookup.body.match(/name="challenge"/g) || []).length, 2);
  assert.equal((lookup.body.match(/name="csrf"/g) || []).length, 2);
  assert.match(lookup.body, /<fieldset class="permission-fieldset">/);
  assert.match(lookup.body, /<label class="permission-choice"><input type="checkbox" name="scope"/);

  const challenge = /name="challenge" value="([^"]+)"/.exec(lookup.body)?.[1];
  const reviewCsrf = /name="csrf" value="([^"]+)"/.exec(lookup.body)?.[1];
  const approved = (await callForm(handler, { action: "approve", challenge, csrf: reviewCsrf, scope: "orders:read" })).res;
  assert.equal(approved.status, 200);
  assert.match(approved.body, /VerseKit access approved/);
  assert.match(approved.body, /Return to the VerseKit desktop client/);
  assert.deepEqual(lastDecision.scopes, ["orders:read"]);
  assert.equal(lastDecision.approve, true);

  const secondCsrf = /name="csrf" value="([^"]+)"/.exec(codePage.body)?.[1];
  const secondReview = (await callForm(handler, { action: "lookup", csrf: secondCsrf, user_code: newUserCode() })).res;
  const denied = (await callForm(handler, {
    action: "deny",
    challenge: /name="challenge" value="([^"]+)"/.exec(secondReview.body)?.[1],
    csrf: /name="csrf" value="([^"]+)"/.exec(secondReview.body)?.[1]
  })).res;
  assert.equal(denied.status, 200);
  assert.match(denied.body, /VerseKit access denied/);
  assert.match(denied.body, /No tokens were issued/);
  assert.deepEqual(lastDecision.scopes, []);
  assert.equal(lastDecision.approve, false);

  sameOrigin = false;
  const rejectedOrigin = (await callForm(handler, { action: "lookup", csrf, user_code: userCode })).res;
  assert.equal(rejectedOrigin.status, 403);
  assert.match(rejectedOrigin.body, /could not be verified/);
  assert.equal(rejectedOrigin.headers["referrer-policy"], "same-origin");
  sameOrigin = true;

  const invalidCode = (await callForm(handler, { action: "lookup", csrf, user_code: "not-a-code" })).res;
  assert.equal(invalidCode.status, 400);
  assert.match(invalidCode.body, /code is invalid or no longer available/);
  challengeAvailable = false;
  const expiredCode = (await callForm(handler, { action: "lookup", csrf, user_code: newUserCode() })).res;
  assert.equal(expiredCode.status, 400);
  assert.match(expiredCode.body, /code is invalid or no longer available/);
  challengeAvailable = true;

  allowLookups = false;
  const limited = (await callForm(handler, { action: "lookup", csrf, user_code: userCode })).res;
  assert.equal(limited.status, 429);
  assert.match(limited.body, /Too many attempts/);
  allowLookups = true;

  const missingCsrf = (await callForm(handler, { action: "lookup", user_code: userCode })).res;
  assert.equal(missingCsrf.status, 403);
  const claims = JSON.parse(Buffer.from(csrf.split(".")[0], "base64url").toString("utf8"));
  const expiredPayload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() - 1 })).toString("base64url");
  const expiredCsrf = `${expiredPayload}.${codec.hash("csrf", expiredPayload)}`;
  const expiredForm = (await callForm(handler, { action: "lookup", csrf: expiredCsrf, user_code: userCode })).res;
  assert.equal(expiredForm.status, 403);
  const tamperedCsrf = `${csrf.slice(0, -1)}${csrf.endsWith("A") ? "B" : "A"}`;
  assert.equal((await callForm(handler, { action: "lookup", csrf: tamperedCsrf, user_code: userCode })).res.status, 403);

  const noIdentity = createConsentHandlers({
    context: { groupId, groupName: "Example Org" }, tokenStore, codec,
    getSessionContext: async () => null, getCurrentAppUser: async () => null,
    getSessionToken: async () => null, sameOrigin: () => true,
    lookupLimiter: { consume: () => ({ allowed: true }) }
  });
  const loginPage = (await call(noIdentity, "GET", "/device")).res;
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.body, /href="\/login"/);
  assert.match(loginPage.body, /active VerseLink member session/);
  const unauthPost = (await callForm(noIdentity, { action: "lookup", csrf: "x", user_code: userCode })).res;
  assert.equal(unauthPost.status, 401);
});

test("VerseKit consent body rejections return protected fixed HTML and close unread connections", async () => {
  const handler = createConsentHandlers({
    context: { groupId, groupName: "Example Org" },
    tokenStore: { db: { async query() { return { rowCount: 1 }; } }, operationalScopes: [] },
    codec: createTokenCodec(testPepper),
    getSessionContext: async () => null,
    getCurrentAppUser: async () => null,
    getSessionToken: async () => null,
    sameOrigin: () => true,
    lookupLimiter: { consume: () => ({ allowed: true }) },
    requestBodyDeadlineMs: 10
  });
  const rejectedPost = async ({ contentType = "application/x-www-form-urlencoded", contentLength, chunks = [], keepEventLoopAlive = false } = {}) => {
    const req = contentLength !== undefined && chunks.length === 0
      ? new Readable({ read() {} })
      : Readable.from(chunks.map((chunk) => Buffer.from(chunk)));
    let paused = false;
    const socket = {
      remoteAddress: "127.0.0.1", destroyed: false, ended: false,
      end() { this.ended = true; },
      destroy() { this.destroyed = true; },
      destroySoon() { this.destroyed = true; }
    };
    req.pause = () => { paused = true; return req; };
    req.method = "POST";
    req.headers = { origin: "https://verse.example.org", "content-type": contentType,
      ...(contentLength === undefined ? {} : { "content-length": String(contentLength) }) };
    req.socket = socket;
    const res = response();
    const keepAlive = keepEventLoopAlive ? setTimeout(() => {}, 100) : null;
    try {
      await handler(req, res, new URL("/device", "https://verse.example.org"));
      await new Promise((resolve) => setImmediate(resolve));
      return { req, res, socket, get paused() { return paused; } };
    } finally {
      if (keepAlive) clearTimeout(keepAlive);
    }
  };
  const expectedHeaders = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "same-origin",
    "content-security-policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    connection: "close"
  };
  const assertRejected = (result, status, safeMessage) => {
    assert.equal(result.res.status, status);
    for (const [name, value] of Object.entries(expectedHeaders)) assert.equal(result.res.headers[name], value, `${name} header`);
    assert.match(result.res.body, new RegExp(safeMessage));
    assert.match(result.res.body, /Request could not be completed/);
    assert.doesNotMatch(result.res.body, /sensitive-form-secret|private-user-code/i);
    assert.equal(result.paused, true, "unread request body is paused");
    assert.equal(result.socket.destroyed, true, "connection is closed after the response flushes");
  };

  const invalidType = await rejectedPost({
    contentType: "text/plain",
    chunks: ["sensitive-form-secret private-user-code"]
  });
  assertRejected(invalidType, 400, /The form could not be read\./);

  const timedOut = await rejectedPost({ contentLength: 64, keepEventLoopAlive: true });
  assertRejected(timedOut, 408, /The form took too long to arrive\./);

  const oversized = await rejectedPost({
    chunks: [`action=lookup&user_code=private-user-code&pad=${"x".repeat(VERSEKIT_FORM_BODY_LIMIT)}`]
  });
  assertRejected(oversized, 413, /This form is larger than expected\./);
});

test("VerseKit is disabled unless the flag is exactly true", async () => {
  for (const value of [undefined, "", "false", "TRUE", "1", " true ", "malformed"]) {
    const env = { ...enabled, VERSEKIT_ENABLED: value };
    assert.equal(parseVersekitConfig(env), null);
    const adapter = await createVersekitAdapter({ env, db: { query() { throw new Error("disabled mode touched DB"); } } });
    assert.equal(adapter, null);
  }
  assert.equal(parseVersekitConfig(enabled).groupId, groupId);
});

test("enabled VerseKit requires a valid independent UTF-8 pepper before database access", async () => {
  for (const tokenPepper of [undefined, "", "x".repeat(31), "é".repeat(15)]) {
    let touched = false;
    await assert.rejects(createVersekitAdapter({
      env: enabled,
      tokenPepper,
      db: { async query() { touched = true; throw new Error("database should not be queried"); } }
    }), /VERSEKIT_TOKEN_PEPPER must provide at least 32 UTF-8 bytes/);
    assert.equal(touched, false);
  }
  assert.equal(Buffer.byteLength("é".repeat(16), "utf8"), 32);
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
  const db = { async query(sql, params) { queries.push({ sql, params }); return /SELECT capacity,refill_interval_seconds,tokens,updated_at FROM versekit_grant_quota/.test(sql)
    ? { rowCount: 1, rows: [{ capacity: 4096, refill_interval_seconds: 3600, tokens: 4096, updated_at: new Date() }] }
    : { rowCount: 1, rows: [{ id: groupId, name: "Example Org" }] }; }, async connect() { return { async query(sql, params) {
      queries.push({ sql, params });
      if (/SELECT id FROM blueprint_groups/.test(sql)) return { rowCount: 1, rows: [{ id: groupId }] };
      if (/FROM material_orders/.test(sql)) return { rowCount: 0, rows: [] };
      return /SELECT group_id FROM versekit_authorization_config/.test(sql) ? { rowCount: 1, rows: [{ group_id: groupId }] } : { rowCount: 1, rows: [] };
    }, release() {} }; } };
  const router = await createVersekitAdapter({ env: enabled, db, tokenPepper: testPepper, quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"] });
  assert.equal(typeof router, "function");
  assert.deepEqual(queries[0].params, [groupId]);
  assert.match(queries[0].sql, /FROM blueprint_groups WHERE id = \$1/);
  const discovery = (await call(router, "GET", "/.well-known/versekit-org.json")).res;
  assert.equal(discovery.status, 200);
  assert.deepEqual(JSON.parse(discovery.body).versions["1"].scopes_supported, ["orders:read"]);
  const unadvertisedBlueprints = (await call(router, "GET", "/versekit/v1/blueprints")).res;
  assert.equal(unadvertisedBlueprints.status, 404, "blueprints:read stays unavailable until its explicit DEV capability is activated");
  const consentPage = (await call(router, "GET", "/device")).res;
  assert.equal(consentPage.status, 200);
  assert.match(consentPage.body, /href="\/login"/);
  assert.equal((await call(router, "POST", "/versekit/v1/token")).res.status, 400);
  assert.deepEqual(JSON.parse((await call(router, "POST", "/versekit/v1/token")).res.body), { error: "invalid_request" });
  assert.equal((await call(router, "GET", "/versekit/v1/orders?group_id=another")).res.status, 401);
  assert.ok(queries.some((query) => /CREATE TABLE IF NOT EXISTS versekit_device_grants/.test(query.sql)));
  assert.equal(queries.filter((q) => /SELECT id, name FROM blueprint_groups WHERE id/.test(q.sql)).length, 1);
  await assert.rejects(createVersekitAdapter({ env: enabled, tokenPepper: testPepper, db: { query: async () => ({ rows: [] }) } }), /existing group/);
  await assert.rejects(createVersekitAdapter({ env: enabled, tokenPepper: testPepper, db: { query: async () => ({ rows: [{ name: "x".repeat(81) }] }) } }), /group name/);
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

test("VerseKit token codec uses purpose-separated hashes and normalized high-entropy user codes", () => {
  const codec = createTokenCodec(testPepper);
  const access = codec.issue("vka");
  assert.match(access, /^vka_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(codec.hash("access", access), codec.hash("refresh", access));
  assert.notEqual(codec.hash("access", access), codec.hash("access", codec.issue("vka")));
  assert.equal(codec.hash("user_code", "ABCDF-GHJKM").length, 64);
  const generatedCode = newUserCode();
  assert.equal(normalizeUserCode(generatedCode), generatedCode);
  assert.equal(normalizeUserCode("bad-code"), null);
  assert.throws(() => createTokenCodec("short"), /32 bytes/);
});

test("VerseKit schema initialization is an explicit call and disabled adapters do not run it", async () => {
  const statements = [];
  const initResults = [{ rows: [], rowCount: 0 }, { rows: [{ capacity: 4096, refill_interval_seconds: 3600, tokens: 12, updated_at: new Date() }], rowCount: 1 }];
  await initializeVersekitSchema({ query: async (sql) => { statements.push(sql); return initResults.shift(); } }, testQuotaPolicy);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS versekit_device_grants/);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS versekit_token_families/);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS versekit_tokens/);
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS versekit_authorization_config/);
  const adapter = await createVersekitAdapter({ env: { VERSEKIT_ENABLED: "false" }, db: { query: async () => { throw new Error("disabled adapter touched database"); } } });
  assert.equal(adapter, null);
});

test("global token bucket coordinates concurrent grants, refills and transaction rollback", { skip: !process.env.TEST_DATABASE_URL, timeout: 60_000 }, async () => {
  const safeUrl = resolveC6TestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const databaseName = `vk03_quota_${randomUUID().replaceAll("-", "")}`;
  const databasePattern = /^vk03_quota_[a-f0-9]{32}$/;
  const adminUrl = new URL(safeUrl);
  adminUrl.pathname = "/postgres";
  const admin = await createTestPool(adminUrl.toString());
  const quotaPolicy = Object.freeze({ capacity: 3, refillIntervalSeconds: 3600 });
  const group = randomUUID();
  const pepper = "vk03-dedicated-quota-test-pepper-more-than-thirty-two-bytes";
  let databaseCreated = false;
  let databaseUrl;
  let bootstrap;
  let pool;
  let httpServer;
  let isolatedPools = [];
  try {
    assert.match(databaseName, databasePattern);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const isolatedUrl = new URL(safeUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    databaseUrl = isolatedUrl.toString();

    // Initialize the normal VerseLink tables in this database without enabling VerseKit.
    bootstrap = await startMissionTestServer({ databaseUrl, pepper, extraEnv: { VERSEKIT_ENABLED: "false" } });
    await stopMissionTestServer(bootstrap);
    bootstrap = null;

    pool = await createTestPool(databaseUrl);
    await pool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,'VK03 quota test org')", [group]);
    const adapter = await createVersekitAdapter({ env: { ...enabled, VERSEKIT_GROUP_ID: group }, db: pool,
      tokenPepper: testPepper, capabilities: ["orders:read"], quotaPolicy });
    assert.equal(typeof adapter, "function");

    const codec = createTokenCodec(testPepper);
    const store = new VersekitTokenStore({ db: pool, codec, groupId: group, operationalScopes: ["orders:read"] });
    const state = async () => {
      const [quota, grants] = await Promise.all([
        pool.query("SELECT capacity,refill_interval_seconds,tokens,updated_at FROM versekit_grant_quota WHERE id=true"),
        pool.query("SELECT count(*)::int AS count FROM versekit_device_grants")
      ]);
      assert.equal(quota.rowCount, 1, "isolated database has one persisted global quota row");
      return { capacity: Number(quota.rows[0].capacity), interval: Number(quota.rows[0].refill_interval_seconds),
        tokens: Number(quota.rows[0].tokens), updatedAt: quota.rows[0].updated_at, grants: Number(grants.rows[0].count) };
    };
    const createGrant = (target = store) => target.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    const expectQuotaRejection = (target = store) => assert.rejects(createGrant(target), (error) => error.code === "VERSEKIT_GRANT_CAPACITY");

    let current = await state();
    assert.equal(current.capacity, 3, "isolated quota uses the requested test capacity");
    assert.equal(current.interval, 3600, "isolated quota persists a one-hour refill interval");
    assert.equal(current.tokens, 3, "new quota starts at full capacity");

    await createGrant();
    await createGrant();
    current = await state();
    assert.equal(Math.floor(current.tokens), 1, "two successful grants leave exactly one whole token available");
    assert.ok(current.tokens >= 1 && current.tokens < 1.01, "only a small database-time fractional refill accrues during the test");
    assert.equal(current.grants, 2, "each successful admission inserts exactly one grant");

    // Repeated adapter initialization must validate the same test policy without resetting state.
    const beforeMatchingInit = current;
    await createVersekitAdapter({ env: { ...enabled, VERSEKIT_GROUP_ID: group }, db: pool,
      tokenPepper: testPepper, capabilities: ["orders:read"], quotaPolicy });
    current = await state();
    assert.equal(current.tokens, beforeMatchingInit.tokens, "matching initialization preserves the current balance");
    assert.equal(current.updatedAt.getTime(), beforeMatchingInit.updatedAt.getTime(), "matching initialization preserves the refill timestamp");

    // Gate all attempts so separate pools begin admission together, exercising PostgreSQL serialization.
    isolatedPools = await Promise.all(Array.from({ length: 4 }, () => createTestPool(databaseUrl)));
    let ready = 0;
    let release;
    const startTogether = new Promise((resolve) => { release = resolve; });
    const attempts = isolatedPools.map(async (separatePool) => {
      const separateStore = new VersekitTokenStore({ db: separatePool, codec, groupId: group, operationalScopes: ["orders:read"] });
      ready += 1;
      if (ready === isolatedPools.length) release();
      await startTogether;
      try { return { status: "fulfilled", value: await createGrant(separateStore) }; }
      catch (error) { return { status: "rejected", error }; }
    });
    const concurrent = await Promise.all(attempts);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1, "one remaining token admits exactly one concurrent request");
    assert.equal(concurrent.filter((result) => result.status === "rejected" && result.error.code === "VERSEKIT_GRANT_CAPACITY").length, 3,
      "all other concurrent requests are rejected by the quota");
    current = await state();
    assert.equal(Math.floor(current.tokens), 0, "concurrent admission consumes the final whole token once");
    assert.ok(current.tokens < 1, "concurrent requests cannot use the fractional refill as another whole token");
    assert.equal(current.grants, 3, "concurrent rejections insert no extra grant rows");
    for (const separatePool of isolatedPools) {
      assert.equal(separatePool.waitingCount, 0, "no concurrent connection acquisition remains queued");
      assert.equal(separatePool.idleCount, separatePool.totalCount, "every concurrent transaction returned its connection");
    }
    assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND granted")).rows[0].count), 0,
      "transaction-scoped advisory locks were released after concurrent admissions");
    await Promise.all(isolatedPools.map((separatePool) => separatePool.end()));
    isolatedPools = [];

    await expectQuotaRejection();
    assert.equal((await state()).grants, 3, "an immediate exhausted-bucket rejection inserts no grant");

    // Backdate only this disposable database's quota timestamp; the store refills using PostgreSQL time.
    await pool.query("UPDATE versekit_grant_quota SET tokens=0,updated_at=clock_timestamp()-interval '3600 seconds' WHERE id=true");
    await createGrant();
    await expectQuotaRejection();
    current = await state();
    assert.equal(Math.floor(current.tokens), 0, "one elapsed interval permits exactly one grant and leaves no whole token");
    assert.ok(current.tokens < 1, "the refilled fractional remainder cannot authorize a second grant");
    assert.equal(current.grants, 4, "refill admits one row and the next request inserts none");

    await pool.query("UPDATE versekit_grant_quota SET tokens=0,updated_at=clock_timestamp()-interval '10 hours' WHERE id=true");
    await createGrant();
    current = await state();
    assert.equal(Math.floor(current.tokens), 2, "a long elapsed period is capped at capacity before one token is consumed");
    assert.ok(current.tokens < 3, "the long-period balance never exceeds capacity");
    assert.equal(current.grants, 5);

    // A missing group triggers the real foreign-key constraint after the quota update, inside the transaction.
    const invalidGroupStore = new VersekitTokenStore({ db: pool, codec, groupId: randomUUID(), operationalScopes: ["orders:read"] });
    const beforeRollback = await state();
    await assert.rejects(createGrant(invalidGroupStore), (error) => error.code === "23503");
    const afterRollback = await state();
    assert.equal(afterRollback.tokens, beforeRollback.tokens, "failed grant insertion rolls back its quota consumption");
    assert.equal(afterRollback.updatedAt.getTime(), beforeRollback.updatedAt.getTime(), "rollback restores the prior refill timestamp");
    assert.equal(afterRollback.grants, beforeRollback.grants, "failed insertion leaves no grant row");
    await createGrant();
    current = await state();
    assert.equal(Math.floor(current.tokens), 1, "a valid grant succeeds after the controlled insertion failure");
    assert.equal(current.grants, 6);

    await createGrant();
    await expectQuotaRejection();
    current = await state();
    assert.equal(Math.floor(current.tokens), 0, "test reaches an exhausted bucket for the HTTP check");
    assert.equal(current.grants, 7, "only successful quota admissions have grant rows");

    const httpAdapter = await createVersekitAdapter({ env: { ...enabled, VERSEKIT_GROUP_ID: group }, db: pool,
      tokenPepper: testPepper, capabilities: ["orders:read"], quotaPolicy });
    httpServer = createServer((req, res) => httpAdapter(req, res, new URL(req.url, "http://127.0.0.1")));
    await new Promise((resolve, reject) => { httpServer.once("error", reject); httpServer.listen(0, "127.0.0.1", resolve); });
    const port = httpServer.address().port;
    const beforeHttp = await state();
    const response = await fetch(`http://127.0.0.1:${port}/versekit/v1/device/code`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "client_id=versekit&scope=orders%3Aread", signal: AbortSignal.timeout(5_000)
    });
    const body = await response.json();
    assert.equal(response.status, 429, "exhausted global quota returns HTTP 429");
    assert.ok(Number(response.headers.get("retry-after")) > 0, "quota rejection includes a positive Retry-After");
    assert.deepEqual(body, { error: "temporarily_unavailable" }, "HTTP response has the OAuth error shape and reveals no quota balance");
    const afterHttp = await state();
    assert.equal(afterHttp.grants, beforeHttp.grants, "HTTP rejection inserts no device grant");
    assert.ok(afterHttp.tokens < 1, "HTTP rejection preserves a balance with no usable whole token");

    // Keep unread-body connection closure covered through the real endpoint on the same isolated adapter.
    const limitedAdapter = await createVersekitAdapter({ env: { ...enabled, VERSEKIT_GROUP_ID: group }, db: pool,
      tokenPepper: testPepper, capabilities: ["orders:read"], quotaPolicy,
      deviceCodeLimiter: { consume: () => ({ allowed: false, retryAfter: 17 }) } });
    const limitedServer = createServer((req, res) => limitedAdapter(req, res, new URL(req.url, "http://127.0.0.1")));
    await new Promise((resolve, reject) => { limitedServer.once("error", reject); limitedServer.listen(0, "127.0.0.1", resolve); });
    try {
      const partial = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("unread-body rejection timed out")), 5_000);
        const request = httpRequest({ hostname: "127.0.0.1", port: limitedServer.address().port, path: "/versekit/v1/device/code",
          method: "POST", agent: false, headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "1000" } }, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }); });
        });
        request.on("error", (error) => { if (!request.res) { clearTimeout(timer); reject(error); } });
        request.write("client_id=versekit");
      });
      assert.equal(partial.status, 429, "early limiter rejection still responds before parsing the incomplete body");
      assert.equal(partial.headers.connection, "close", "unread request body cannot reuse its connection");
      assert.deepEqual(JSON.parse(partial.body), { error: "temporarily_unavailable" });
    } finally {
      limitedServer.closeAllConnections?.();
      await new Promise((resolve) => limitedServer.close(resolve));
    }
    assert.equal((await state()).grants, beforeHttp.grants, "unread-body early rejection also leaves quota and grants unchanged");
  } finally {
    await Promise.all(isolatedPools.map((separatePool) => separatePool.end().catch(() => {})));
    if (httpServer) {
      httpServer.closeAllConnections?.();
      await new Promise((resolve) => httpServer.close(resolve));
    }
    await stopMissionTestServer(bootstrap);
    await pool?.end();
    if (databaseCreated) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
    await admin.end();
  }
});

test("global token bucket and grant storage ceiling recover safely after cleanup", { skip: !process.env.TEST_DATABASE_URL, timeout: 60_000 }, async () => {
  const safeUrl = resolveC6TestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const databaseName = `vk03_quota2_${randomUUID().replaceAll("-", "")}`;
  const databasePattern = /^vk03_quota2_[a-f0-9]{32}$/;
  const adminUrl = new URL(safeUrl);
  adminUrl.pathname = "/postgres";
  const admin = await createTestPool(adminUrl.toString());
  const quotaPolicy = Object.freeze({ capacity: 5, refillIntervalSeconds: 3600 });
  const maxRetainedGrants = 3;
  const group = randomUUID();
  const userId = randomUUID();
  const pepper = "vk03-quota-cleanup-test-pepper-more-than-thirty-two-bytes";
  let databaseCreated = false;
  let databaseUrl;
  let bootstrap;
  let pool;
  let admissionPools = [];
  let databaseCreatedName;
  try {
    assert.match(databaseName, databasePattern);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    databaseCreatedName = databaseName;
    const isolatedUrl = new URL(safeUrl);
    isolatedUrl.pathname = `/${databaseName}`;
    databaseUrl = isolatedUrl.toString();

    // Bootstrap VerseLink core tables with VerseKit disabled in this dedicated database.
    bootstrap = await startMissionTestServer({ databaseUrl, pepper, extraEnv: { VERSEKIT_ENABLED: "false" } });
    await stopMissionTestServer(bootstrap);
    bootstrap = null;

    pool = await createTestPool(databaseUrl);
    await pool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,'VK03 quota cleanup test org')", [group]);
    await pool.query("INSERT INTO app_users(id,email,display_name,account_status) VALUES($1,$2,'VK03 Quota Member','active')",
      [userId, `vk03-quota-${userId}@example.test`]);
    await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'member')", [group, userId]);

    const env = { ...enabled, VERSEKIT_GROUP_ID: group };
    const adapter = await createVersekitAdapter({ env, db: pool, tokenPepper: testPepper, capabilities: ["orders:read"], quotaPolicy, maxRetainedGrants });
    assert.equal(typeof adapter, "function");
    const codec = createTokenCodec(testPepper);
    const store = new VersekitTokenStore({ db: pool, codec, groupId: group, operationalScopes: ["orders:read"], maxRetainedGrants });
    const createGrant = () => store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    const quotaState = async () => {
      const result = await pool.query("SELECT capacity,refill_interval_seconds,tokens,updated_at FROM versekit_grant_quota WHERE id=true");
      assert.equal(result.rowCount, 1, "dedicated database has a single persisted quota policy row");
      return { capacity: Number(result.rows[0].capacity), interval: Number(result.rows[0].refill_interval_seconds),
        tokens: Number(result.rows[0].tokens), updatedAt: result.rows[0].updated_at };
    };
    const grantRows = async () => (await pool.query(
      "SELECT id,status,group_id,app_user_id,requested_scopes,approved_scopes,created_at,expires_at,consented_at FROM versekit_device_grants ORDER BY id"
    )).rows;
    const grantCount = async () => Number((await pool.query("SELECT count(*)::int AS count FROM versekit_device_grants")).rows[0].count);
    const assertCapacityFailure = (promise, expectedMessage) => assert.rejects(promise, (error) =>
      error.code === "VERSEKIT_GRANT_CAPACITY" && new RegExp(expectedMessage).test(error.message));
    const postDeviceCode = async (handler) => {
      const server = createServer((req, res) => handler(req, res, new URL(req.url, "http://127.0.0.1")));
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/versekit/v1/device/code`, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "client_id=versekit&scope=orders%3Aread", signal: AbortSignal.timeout(5_000)
        });
        return { status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json() };
      } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      }
    };

    let quota = await quotaState();
    assert.equal(quota.capacity, 5);
    assert.equal(quota.interval, 3600);
    assert.equal(quota.tokens, 5, "new persistent policy starts full");

    // Two retained grants leave the storage ceiling open while we exhaust the independent token bucket.
    const orphanGrant = await createGrant();
    const familyGrant = await createGrant();
    assert.equal(await grantCount(), 2);
    const familyConsent = await store.consent({ grantId: familyGrant.id, userId, scopes: ["orders:read"], approve: true });
    assert.equal(familyConsent, true);
    const issued = await store.exchangeDeviceCode({ deviceCode: familyGrant.deviceCode, clientId: "versekit" });
    assert.ok(issued.tokens, "approved grant creates an active access/refresh family");
    quota = await quotaState();
    assert.ok(Math.floor(quota.tokens) >= 2 && Math.floor(quota.tokens) <= 3, "initial admissions consume tokens while fractional database-time refill remains bounded");
    const beforeBucketReject = await grantRows();
    await pool.query("UPDATE versekit_grant_quota SET tokens=0,updated_at=clock_timestamp() WHERE id=true");
    await assertCapacityFailure(createGrant(), "rate reached");
    assert.equal(await grantCount(), 2, "token-bucket rejection below the storage ceiling inserts no grant");
    assert.deepEqual(await grantRows(), beforeBucketReject, "token-bucket rejection preserves existing grant rows");
    quota = await quotaState();
    assert.ok(quota.tokens < 1, "token bucket remains below one usable token");
    const bucketHttp = await postDeviceCode(adapter);
    assert.equal(bucketHttp.status, 429, "token bucket rejection is HTTP 429");
    assert.ok(Number(bucketHttp.retryAfter) > 0, "token bucket HTTP rejection has a positive Retry-After");
    assert.deepEqual(bucketHttp.body, { error: "temporarily_unavailable" });
    assert.equal(await grantCount(), 2, "HTTP token-bucket rejection adds no retained grant");

    // Refill only the isolated row for the storage-ceiling phase; production policy remains untouched.
    await pool.query("UPDATE versekit_grant_quota SET tokens=capacity,updated_at=clock_timestamp() WHERE id=true");
    const activePendingGrant = await createGrant();
    assert.equal(await grantCount(), 3, "third admission fills the configured retained-grant ceiling");
    quota = await quotaState();
    assert.ok(Math.floor(quota.tokens) >= 3, "storage ceiling is reached with tokens still available");
    const beforeStorageReject = await grantRows();
    const quotaBeforeStorageReject = await quotaState();
    await assertCapacityFailure(createGrant(), "storage capacity reached");
    assert.equal(await grantCount(), 3, "storage ceiling rejects an additional retained grant");
    assert.deepEqual(await grantRows(), beforeStorageReject, "storage rejection preserves every existing grant");
    let quotaAfterStorageReject = await quotaState();
    assert.equal(quotaAfterStorageReject.tokens, quotaBeforeStorageReject.tokens, "storage failure rolls back token consumption");
    assert.equal(quotaAfterStorageReject.updatedAt.getTime(), quotaBeforeStorageReject.updatedAt.getTime(), "storage failure rolls back refill timestamp changes");

    // The second adapter requests the exact same persisted policy and reports storage capacity through HTTP.
    const storageAdapter = await createVersekitAdapter({ env, db: pool, tokenPepper: testPepper, capabilities: ["orders:read"], quotaPolicy, maxRetainedGrants });
    quotaAfterStorageReject = await quotaState();
    assert.equal(quotaAfterStorageReject.tokens, quotaBeforeStorageReject.tokens, "matching adapter initialization does not reset quota balance");
    assert.equal(quotaAfterStorageReject.updatedAt.getTime(), quotaBeforeStorageReject.updatedAt.getTime(), "matching adapter initialization does not reset refill timestamp");
    const storageHttp = await postDeviceCode(storageAdapter);
    assert.equal(storageHttp.status, 429, "storage-ceiling rejection is HTTP 429");
    assert.equal(storageHttp.retryAfter, "900", "storage rejection retains the existing Retry-After response");
    assert.deepEqual(storageHttp.body, { error: "temporarily_unavailable" }, "storage response reveals no internal counts");
    assert.equal(await grantCount(), 3, "HTTP storage rejection does not add a retained grant");
    const afterStorageHttp = await quotaState();
    assert.equal(afterStorageHttp.tokens, quotaBeforeStorageReject.tokens, "HTTP storage failure also rolls back quota consumption");
    assert.equal(afterStorageHttp.updatedAt.getTime(), quotaBeforeStorageReject.updatedAt.getTime());

    // Expire one orphan and one family-backed grant. Real bounded cleanup may delete only the orphan.
    await pool.query("UPDATE versekit_device_grants SET status='denied',app_user_id=NULL,approved_scopes='{}',consented_at=now()-interval '32 days',created_at=now()-interval '32 days',expires_at=now()-interval '31 days' WHERE id=$1", [orphanGrant.id]);
    await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '32 days',expires_at=now()-interval '31 days' WHERE id=$1", [familyGrant.id]);
    const cleanup = await store.cleanupCredentials({ batchSize: 2 });
    assert.equal(cleanup.grants, 1, "bounded cleanup removed exactly the eligible orphan grant");
    assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [orphanGrant.id])).rowCount, 0, "eligible orphan row is actually deleted");
    assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1 AND status='consumed'", [familyGrant.id])).rowCount, 1,
      "expired grant referenced by a retained token family remains stored");
    assert.equal((await pool.query("SELECT 1 FROM versekit_token_families WHERE grant_id=$1", [familyGrant.id])).rowCount, 1,
      "active token family remains attached to its grant");
    assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1 AND status='pending' AND expires_at>now()", [activePendingGrant.id])).rowCount, 1,
      "unexpired pending grant remains stored");
    assert.equal(await grantCount(), 2, "cleanup frees one retained-grant slot");
    const recoveredGrant = await createGrant();
    assert.ok(recoveredGrant.id, "issuance resumes after real cleanup frees capacity");
    assert.equal(await grantCount(), 3, "recovered admission stays within the configured ceiling");

    // Both credentials remain usable after cleanup; refresh rotates the family and access remains authenticated.
    const identity = await store.authenticateAccess(issued.tokens.access_token);
    assert.equal(identity?.app_user_id, userId, "existing access token remains valid after cleanup");
    const rotated = await store.refresh({ refreshToken: issued.tokens.refresh_token, clientId: "versekit" });
    assert.ok(rotated.tokens, "existing refresh token remains usable after cleanup");
    assert.equal((await store.authenticateAccess(rotated.tokens.access_token))?.app_user_id, userId, "rotated access token remains valid");
    const rotatedAgain = await store.refresh({ refreshToken: rotated.tokens.refresh_token, clientId: "versekit" });
    assert.ok(rotatedAgain.tokens, "new refresh credential remains usable after cleanup");

    // Independent pools cannot bypass the full retained-grant ceiling; rollback preserves the available bucket.
    const quotaBeforeConcurrentStorageCheck = await quotaState();
    assert.ok(quotaBeforeConcurrentStorageCheck.tokens >= 1, "token bucket has available quota during final storage checks");
    const grantsBeforeConcurrentStorageCheck = await grantRows();
    admissionPools = await Promise.all(Array.from({ length: 4 }, () => createTestPool(databaseUrl)));
    let ready = 0;
    let release;
    const startTogether = new Promise((resolve) => { release = resolve; });
    const attempts = admissionPools.map(async (separatePool) => {
      const separateStore = new VersekitTokenStore({ db: separatePool, codec, groupId: group,
        operationalScopes: ["orders:read"], maxRetainedGrants });
      ready += 1;
      if (ready === admissionPools.length) release();
      await startTogether;
      try { return { status: "fulfilled", grant: await separateStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] }) }; }
      catch (error) { return { status: "rejected", error }; }
    });
    const concurrent = await Promise.all(attempts);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 0, "no separate connection bypasses the full storage ceiling");
    assert.equal(concurrent.filter((result) => result.status === "rejected" && /storage capacity reached/.test(result.error.message)).length, 4,
      "each concurrent rejection is specifically caused by the storage ceiling");
    assert.equal(await grantCount(), 3, "concurrent failures never exceed or delete retained grants");
    assert.deepEqual(await grantRows(), grantsBeforeConcurrentStorageCheck, "concurrent failures preserve existing grant rows and states");
    const quotaAfterConcurrentStorageCheck = await quotaState();
    assert.equal(quotaAfterConcurrentStorageCheck.tokens, quotaBeforeConcurrentStorageCheck.tokens, "concurrent storage failures do not overspend token bucket");
    assert.equal(quotaAfterConcurrentStorageCheck.updatedAt.getTime(), quotaBeforeConcurrentStorageCheck.updatedAt.getTime(), "failed concurrent transactions roll back quota timestamps");
    for (const separatePool of admissionPools) {
      assert.equal(separatePool.waitingCount, 0, "no final admission connection remains queued");
      assert.equal(separatePool.idleCount, separatePool.totalCount, "all final admission connections are returned");
    }
    assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND granted")).rows[0].count), 0,
      "transaction-scoped advisory locks are released after final admission checks");
  } finally {
    await Promise.all(admissionPools.map((separatePool) => separatePool.end().catch(() => {})));
    await stopMissionTestServer(bootstrap);
    await pool?.end();
    if (databaseCreated && databaseCreatedName) {
      let remainingConnections = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const result = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [databaseCreatedName]);
        remainingConnections = result.rows[0].count;
        if (remainingConnections === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(remainingConnections, 0, "all dedicated database connections close before teardown");
      await admin.query(`DROP DATABASE IF EXISTS "${databaseCreatedName}"`);
    }
    await admin.end();
  }
});

test("enabled VerseKit uses the real HTTP server and isolated blueprint_groups table", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const safeUrl = resolveC6TestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const schema = `vk02_${randomUUID().replaceAll("-", "")}`;
  const admin = await createTestPool(safeUrl);
  const scoped = new URL(safeUrl);
  scoped.searchParams.set("options", `-c search_path=${schema},public`);
  const databaseUrl = scoped.toString();
  const pepper = "short-unchanged-sink-test";
  const realGroup = randomUUID();
  const anotherGroup = randomUUID();
  const startupDatabase = `vk03_start_${randomUUID().replaceAll("-", "")}`;
  let startupDatabaseCreated = false;
  let startupDatabaseUrl;
  let pool;
  let runtime;
  const request = async (path, method = "GET") => {
    const result = await fetch(`${runtime.baseUrl}${path}`, { method, signal: AbortSignal.timeout(5_000) });
    return { status: result.status, headers: result.headers, body: await result.text() };
  };
  try {
    assert.match(schema, /^vk02_[a-f0-9]{32}$/);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    runtime = await startMissionTestServer({ databaseUrl, pepper, extraEnv: { VERSEKIT_ENABLED: "false", VERSEKIT_TOKEN_PEPPER: "", VERSEKIT_GROUP_ID: "malformed", VERSEKIT_PUBLIC_URL: "not an origin" } });
    assert.equal((await request("/healthz")).status, 200);
    assert.equal((await request("/login")).status, 200);
    assert.equal((await request("/device-consent.css")).status, 404, "the consent stylesheet is unavailable when VerseKit is disabled");
    assert.equal((await request("/device-consent.css/../server.js")).status, 404, "the consent stylesheet route does not expose arbitrary files");
    assert.equal((await fetch(runtime.baseUrl + "/versekit/v1/device/code", { method: "POST", signal: AbortSignal.timeout(5_000) })).status, 404);
    assert.equal((await request("/.well-known/versekit-org.json")).status, 404);
    const absentVersekitTable = await admin.query("SELECT to_regclass($1) AS table_name", [schema + ".versekit_device_grants"]);
    assert.equal(absentVersekitTable.rows[0].table_name, null);
    const absentAuthorizationConfig = await admin.query("SELECT to_regclass($1) AS table_name", [schema + ".versekit_authorization_config"]);
    assert.equal(absentAuthorizationConfig.rows[0].table_name, null, "disabled mode does not initialize authorization configuration state");
    await stopMissionTestServer(runtime);
    runtime = null;
    pool = await createTestPool(databaseUrl);
    const userId = randomUUID();
    const otherOnlyId = randomUUID();
    await pool.query("INSERT INTO app_users (id,email,display_name,account_status) VALUES ($1,$2,$3,'active')", [userId, `vk03-${userId}@example.test`, "VK03 Test Member"]);
    await pool.query("INSERT INTO app_users (id,email,display_name,account_status) VALUES ($1,$2,$3,'active')", [otherOnlyId, `vk03-other-${otherOnlyId}@example.test`, "Other Group Member"]);
    await pool.query("INSERT INTO blueprint_groups (id, name) VALUES ($1, $2), ($3, $4)", [realGroup, "VK02 Test Org", anotherGroup, "Other Private Org"]);
    await pool.query("INSERT INTO group_members (group_id,app_user_id,role) VALUES ($1,$2,'member'),($3,$2,'member'),($4,$5,'member')", [realGroup, userId, anotherGroup, anotherGroup, otherOnlyId]);
    const otherOnlyMemberships = await pool.query("SELECT group_id FROM group_members WHERE app_user_id=$1", [otherOnlyId]);
    assert.deepEqual(otherOnlyMemberships.rows.map((row) => row.group_id), [anotherGroup]);
    await initializeVersekitSchema(pool, testQuotaPolicy);
    const actual = { ...enabled, VERSEKIT_GROUP_ID: realGroup, VERSEKIT_PUBLIC_URL: "https://example.org", VERSEKIT_TOKEN_PEPPER: testPepper };

    // The real server has no test quota injection: bootstrap and run it in its own database.
    if (!/^vk03_start_[a-f0-9]{32}$/.test(startupDatabase)) throw new Error("Invalid temporary startup database name");
    const adminUrl = new URL(safeUrl); adminUrl.pathname = "/postgres";
    const databaseAdmin = await createTestPool(adminUrl.toString());
    try {
      await databaseAdmin.query(`CREATE DATABASE "${startupDatabase}"`);
      startupDatabaseCreated = true;
      const isolatedUrl = new URL(safeUrl); isolatedUrl.pathname = "/" + startupDatabase;
      startupDatabaseUrl = isolatedUrl.toString();
    } finally { await databaseAdmin.end(); }
    let bootstrap = await startMissionTestServer({ databaseUrl: startupDatabaseUrl, pepper, extraEnv: { VERSEKIT_ENABLED: "false", VERSEKIT_TOKEN_PEPPER: "" } });
    await stopMissionTestServer(bootstrap); bootstrap = null;
    for (const tokenPepper of [undefined, "", "x".repeat(31)]) {
      await assert.rejects(startMissionTestServer({
        databaseUrl: startupDatabaseUrl,
        pepper,
        extraEnv: { ...enabled, VERSEKIT_TOKEN_PEPPER: tokenPepper }
      }));
    }
    const startupPool = await createTestPool(startupDatabaseUrl);
    try { await startupPool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,'VK02 Test Org')", [realGroup]); }
    finally { await startupPool.end(); }

    await t.test("authorization marker and credential state persist across real server restarts", { timeout: 60_000 }, async () => {
      let restartPool;
      try {
        restartPool = await createTestPool(startupDatabaseUrl);
        await restartPool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,'Restart Test Org')", [anotherGroup]);
        await restartPool.query("INSERT INTO app_users(id,email,display_name,account_status) VALUES($1,$2,'Restart Test Member','active')",
          [userId, `vk04-restart-${userId}@example.test`]);
        await restartPool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'member'),($3,$2,'member')",
          [realGroup, userId, anotherGroup]);

        runtime = await startMissionTestServer({ databaseUrl: startupDatabaseUrl, pepper, extraEnv: actual });
        assert.equal((await fetch(`${runtime.baseUrl}/healthz`)).status, 200, "Group A server initializes successfully");
        await stopMissionTestServer(runtime);
        runtime = null;

        const store = new VersekitTokenStore({ db: restartPool, codec: createTokenCodec(testPepper), groupId: realGroup, operationalScopes: ["orders:read"] });
        const issuePair = async () => {
          const grant = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
          assert.equal(await store.consent({ grantId: grant.id, userId, scopes: ["orders:read"], approve: true }), true);
          const result = await store.exchangeDeviceCode({ deviceCode: grant.deviceCode, clientId: "versekit" });
          assert.ok(result.tokens);
          return result.tokens;
        };
        const validPair = await issuePair();
        const revokedPair = await issuePair();
        await store.revoke(revokedPair.refresh_token);
        const markerA = (await restartPool.query("SELECT group_id,updated_at FROM versekit_authorization_config WHERE id=true")).rows[0];
        assert.equal(markerA.group_id, realGroup);

        runtime = await startMissionTestServer({ databaseUrl: startupDatabaseUrl, pepper, extraEnv: actual });
        await stopMissionTestServer(runtime);
        runtime = null;
        assert.deepEqual((await restartPool.query("SELECT group_id,updated_at FROM versekit_authorization_config WHERE id=true")).rows[0], markerA,
          "same-group process restart preserves the marker generation");
        assert.equal((await store.authorizeAccess(validPair.access_token, { operation: "orders:read" })).allowed, true,
          "same-group process restart preserves valid credential state");
        assert.equal(await store.authenticateAccess(revokedPair.access_token), null,
          "same-group process restart does not revive revoked credentials");

        const groupBEnv = { ...actual, VERSEKIT_GROUP_ID: anotherGroup };
        runtime = await startMissionTestServer({ databaseUrl: startupDatabaseUrl, pepper, extraEnv: groupBEnv });
        await stopMissionTestServer(runtime);
        runtime = null;
        const markerB = (await restartPool.query("SELECT group_id,updated_at FROM versekit_authorization_config WHERE id=true")).rows[0];
        assert.equal(markerB.group_id, anotherGroup, "enabled Group B initialization durably changes the marker");
        assert.equal(await store.authenticateAccess(validPair.access_token), null, "Group B initialization invalidates the old Group A credential");

        runtime = await startMissionTestServer({ databaseUrl: startupDatabaseUrl, pepper, extraEnv: actual });
        await stopMissionTestServer(runtime);
        runtime = null;
        assert.equal((await restartPool.query("SELECT group_id FROM versekit_authorization_config WHERE id=true")).rows[0].group_id, realGroup,
          "Group A can initialize after the observed Group B transition");
        assert.equal(await store.authenticateAccess(validPair.access_token), null,
          "the old Group A credential remains revoked after the further restart back to A");
        assert.equal(await store.authenticateAccess(revokedPair.access_token), null,
          "previously revoked credential state remains revoked across every process restart");
      } finally {
        await stopMissionTestServer(runtime);
        runtime = null;
        await restartPool?.end();
      }
    });

    assert.equal(typeof await createVersekitAdapter({ env: actual, db: pool, tokenPepper: testPepper, quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"] }), "function");
    await assert.rejects(createVersekitAdapter({ env: { ...actual, VERSEKIT_GROUP_ID: randomUUID() }, db: pool, tokenPepper: testPepper }), /existing group/);
    assert.throws(() => parseVersekitConfig({ ...actual, VERSEKIT_GROUP_ID: "malformed" }), /VERSEKIT_GROUP_ID/);

    const store = new VersekitTokenStore({ db: pool, codec: createTokenCodec(testPepper), groupId: realGroup, operationalScopes: ["orders:read"] });
    assert.equal(await store.eligible(pool, otherOnlyId, realGroup), false, "membership in another group alone is denied");
    const adminOnlyId = randomUUID();
    await pool.query("INSERT INTO app_users(id,email,display_name,is_admin,account_status) VALUES($1,$2,'VK03 Admin Without Membership',true,'active')",
      [adminOnlyId, `vk03-admin-${adminOnlyId}@example.test`]);
    assert.equal(await store.eligible(pool, adminOnlyId, realGroup), false, "administrator status without current membership grants no VerseKit access");
    const issueApprovedPair = async () => {
      const grant = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      assert.equal(await store.consent({ grantId: grant.id, userId, scopes: ["orders:read"], approve: true }), true);
      const result = await store.exchangeDeviceCode({ deviceCode: grant.deviceCode, clientId: "versekit" });
      assert.ok(result.tokens, "approved grant issues a token pair");
      return { grant, tokens: result.tokens };
    };
    const codec = createTokenCodec(testPepper);
    const familyFor = async (refreshToken) => {
      const found = await pool.query("SELECT family_id FROM versekit_tokens WHERE token_hash=$1 AND token_type='refresh'", [codec.hash("refresh", refreshToken)]);
      assert.equal(found.rowCount, 1, "refresh token has a persisted family row");
      return found.rows[0].family_id;
    };

    await t.test("refresh expires_in reflects the remaining absolute token-family lifetime", async () => {
      const normal = await issueApprovedPair();
      const normalFamily = await familyFor(normal.tokens.refresh_token);
      await pool.query("UPDATE versekit_token_families SET absolute_expires_at=now()+interval '2 days' WHERE id=$1", [normalFamily]);
      const normalRefresh = await store.refresh({ refreshToken: normal.tokens.refresh_token, clientId: "versekit" });
      assert.ok(normalRefresh.tokens);
      const normalAccess = await pool.query("SELECT t.expires_at,f.absolute_expires_at,FLOOR(EXTRACT(EPOCH FROM (t.expires_at-clock_timestamp())))::int AS actual_seconds FROM versekit_tokens t JOIN versekit_token_families f ON f.id=t.family_id WHERE t.token_hash=$1", [codec.hash("access", normalRefresh.tokens.access_token)]);
      assert.equal(normalAccess.rowCount, 1);
      assert.ok(normalRefresh.tokens.expires_in <= normalAccess.rows[0].actual_seconds, "normal response never overstates database remaining validity");
      assert.ok(normalRefresh.tokens.expires_in >= 3590 && normalRefresh.tokens.expires_in <= 3600, "normal access lifetime is capped near 3600 seconds");
      assert.ok(normalAccess.rows[0].expires_at < normalAccess.rows[0].absolute_expires_at);

      const nearExpiry = await issueApprovedPair();
      const nearFamily = await familyFor(nearExpiry.tokens.refresh_token);
      await pool.query("UPDATE versekit_token_families SET absolute_expires_at=clock_timestamp()+interval '5 minutes' WHERE id=$1", [nearFamily]);
      const rotated = await store.refresh({ refreshToken: nearExpiry.tokens.refresh_token, clientId: "versekit" });
      assert.ok(rotated.tokens, "refresh succeeds before family expiry");
      assert.notEqual(rotated.tokens.refresh_token, nearExpiry.tokens.refresh_token, "refresh credential rotates");
      const nearAccess = await pool.query("SELECT t.expires_at,f.absolute_expires_at,FLOOR(EXTRACT(EPOCH FROM (t.expires_at-clock_timestamp())))::int AS actual_seconds FROM versekit_tokens t JOIN versekit_token_families f ON f.id=t.family_id WHERE t.token_hash=$1", [codec.hash("access", rotated.tokens.access_token)]);
      assert.equal(nearAccess.rowCount, 1);
      assert.equal(nearAccess.rows[0].expires_at.getTime(), nearAccess.rows[0].absolute_expires_at.getTime(), "access expiry is capped at the family boundary");
      assert.ok(rotated.tokens.expires_in <= nearAccess.rows[0].actual_seconds, "five-minute response does not overstate actual validity");
      assert.ok(rotated.tokens.expires_in >= 290 && rotated.tokens.expires_in <= 300, "reported lifetime reflects about five minutes, not 3600 seconds");
      assert.equal((await pool.query("SELECT replaced_by FROM versekit_tokens WHERE token_hash=$1", [codec.hash("refresh", nearExpiry.tokens.refresh_token)])).rowCount, 1, "old refresh credential remains recorded for replay detection");

      const beforeExpiryRows = Number((await pool.query("SELECT count(*)::int AS count FROM versekit_tokens WHERE family_id=$1", [nearFamily])).rows[0].count);
      await pool.query("UPDATE versekit_token_families SET absolute_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [nearFamily]);
      assert.deepEqual(await store.refresh({ refreshToken: rotated.tokens.refresh_token, clientId: "versekit" }), { error: "invalid_grant" }, "expired family cannot be refreshed");
      assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM versekit_tokens WHERE family_id=$1", [nearFamily])).rows[0].count), beforeExpiryRows, "expired boundary issues no credentials");
      assert.ok((await pool.query("SELECT absolute_expires_at < clock_timestamp() AS expired FROM versekit_token_families WHERE id=$1", [nearFamily])).rows[0].expired, "refresh does not extend family expiry");
    });

    await t.test("absolute token-family lifetime bounds rotated credentials and rejects refresh at expiry", async () => {
      const { tokens } = await issueApprovedPair();
      const familyId = await familyFor(tokens.refresh_token);
      await pool.query("UPDATE versekit_token_families SET absolute_expires_at=now()+interval '1 hour' WHERE id=$1", [familyId]);
      const rotated = await store.refresh({ refreshToken: tokens.refresh_token, clientId: "versekit" });
      assert.ok(rotated.tokens, "refresh succeeds before absolute family expiry");
      const bounds = await pool.query(
        "SELECT f.absolute_expires_at, t.token_type,t.expires_at FROM versekit_token_families f JOIN versekit_tokens t ON t.family_id=f.id WHERE f.id=$1 AND t.token_hash=ANY($2::text[])",
        [familyId, [codec.hash("access", rotated.tokens.access_token), codec.hash("refresh", rotated.tokens.refresh_token)]]
      );
      assert.equal(bounds.rowCount, 2, "both rotated credential rows are persisted");
      for (const credential of bounds.rows) assert.ok(credential.expires_at <= bounds.rows[0].absolute_expires_at, `issued ${credential.token_type} credential cannot outlive family`);
      await pool.query("UPDATE versekit_token_families SET absolute_expires_at=now()-interval '1 second' WHERE id=$1", [familyId]);
      assert.deepEqual(await store.refresh({ refreshToken: rotated.tokens.refresh_token, clientId: "versekit" }), { error: "invalid_grant" }, "refresh at/after absolute expiry is rejected");
      const rows = await pool.query("SELECT count(*)::int AS count FROM versekit_tokens WHERE family_id=$1", [familyId]);
      assert.equal(rows.rows[0].count, 4, "expired family cannot issue another credential pair");
    });

    await t.test("token families are retained until seven days after absolute expiry, then cascade token history", async () => {
      const expired = await issueApprovedPair();
      const expiredFamily = await familyFor(expired.tokens.refresh_token);
      const active = await issueApprovedPair();
      const activeFamily = await familyFor(active.tokens.refresh_token);
      await pool.query("UPDATE versekit_token_families SET absolute_expires_at=now()-interval '6 days' WHERE id=$1", [expiredFamily]);
      await store.cleanupCredentials();
      assert.equal((await pool.query("SELECT 1 FROM versekit_token_families WHERE id=$1", [expiredFamily])).rowCount, 1, "family remains before the seven-day retention boundary");
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM versekit_tokens WHERE family_id=$1", [expiredFamily])).rows[0].count, 2, "historical token rows remain before eligibility");
      await pool.query("UPDATE versekit_token_families SET absolute_expires_at=now()-interval '8 days' WHERE id=$1", [expiredFamily]);
      await store.cleanupCredentials();
      assert.equal((await pool.query("SELECT 1 FROM versekit_token_families WHERE id=$1", [expiredFamily])).rowCount, 0, "eligible family is removed by cleanup");
      assert.equal((await pool.query("SELECT count(*)::int AS count FROM versekit_tokens WHERE family_id=$1", [expiredFamily])).rows[0].count, 0, "family deletion cascades its historical token rows");
      assert.equal((await pool.query("SELECT 1 FROM versekit_token_families WHERE id=$1", [activeFamily])).rowCount, 1, "unrelated active family remains");
      assert.equal((await store.authenticateAccess(active.tokens.access_token)).app_user_id, userId, "unrelated active access token remains usable");
    });

    await t.test("cleanup preserves refresh replay detection and family-wide revocation", async () => {
      const replayed = await issueApprovedPair();
      const replayFamily = await familyFor(replayed.tokens.refresh_token);
      const rotated = await store.refresh({ refreshToken: replayed.tokens.refresh_token, clientId: "versekit" });
      assert.ok(rotated.tokens, "first refresh rotation succeeds");
      const independent = await issueApprovedPair();
      const independentFamily = await familyFor(independent.tokens.refresh_token);
      await store.cleanupCredentials();
      assert.equal((await pool.query("SELECT 1 FROM versekit_tokens WHERE token_hash=$1", [codec.hash("refresh", replayed.tokens.refresh_token)])).rowCount, 1, "cleanup preserves consumed refresh token needed for replay detection");
      assert.deepEqual(await store.refresh({ refreshToken: replayed.tokens.refresh_token, clientId: "versekit" }), { error: "invalid_grant" }, "replay is rejected after cleanup");
      const revoked = await pool.query("SELECT f.revoked_at, count(t.id)::int AS token_count, count(t.id) FILTER (WHERE t.revoked_at IS NOT NULL)::int AS revoked_count FROM versekit_token_families f JOIN versekit_tokens t ON t.family_id=f.id WHERE f.id=$1 GROUP BY f.id", [replayFamily]);
      assert.ok(revoked.rows[0].revoked_at, "replay revokes the token family");
      assert.equal(revoked.rows[0].token_count, 4);
      assert.equal(revoked.rows[0].revoked_count, 4, "replay revokes old and newly issued family credentials");
      assert.equal(await store.authenticateAccess(rotated.tokens.access_token), null, "new access credential is unusable after replay revocation");
      assert.deepEqual(await store.refresh({ refreshToken: rotated.tokens.refresh_token, clientId: "versekit" }), { error: "invalid_grant" }, "new refresh credential is unusable after replay revocation");
      assert.equal((await pool.query("SELECT revoked_at FROM versekit_token_families WHERE id=$1", [independentFamily])).rows[0].revoked_at, null, "independent family stays active");
      assert.equal((await store.authenticateAccess(independent.tokens.access_token)).app_user_id, userId, "independent access credential remains usable");
    });

    await t.test("consent challenges are retained for one day after expiry or consumption", async () => {
      const sessionHash = codec.hash("browser_session", "consent-retention-session");
      const createChallenge = async () => {
        const grant = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
        const consent = await store.createConsentChallenge({ userCode: grant.userCode, userId, sessionHash });
        assert.ok(consent, "pending grant creates a consent challenge");
        return { grant, consent, hash: codec.hash("consent_challenge", consent.challenge) };
      };
      const expired = await createChallenge();
      const active = await createChallenge();
      const consumed = await createChallenge();
      assert.equal(await store.decideConsent({ challenge: consumed.consent.challenge, userId, sessionHash, scopes: [], approve: false }), true);
      assert.equal(await store.decideConsent({ challenge: consumed.consent.challenge, userId, sessionHash, scopes: [], approve: false }), false, "consumed challenge cannot be reused");
      await pool.query("UPDATE versekit_consent_challenges SET expires_at=now()-interval '23 hours' WHERE challenge_hash=$1", [expired.hash]);
      await pool.query("UPDATE versekit_consent_challenges SET consumed_at=now()-interval '23 hours',expires_at=now()+interval '1 hour' WHERE challenge_hash=$1", [consumed.hash]);
      await store.cleanupCredentials();
      assert.equal((await pool.query("SELECT 1 FROM versekit_consent_challenges WHERE challenge_hash=$1", [expired.hash])).rowCount, 1, "expired challenge remains before the one-day post-expiry cutoff");
      assert.equal((await pool.query("SELECT 1 FROM versekit_consent_challenges WHERE challenge_hash=$1", [consumed.hash])).rowCount, 1, "consumed challenge remains before the one-day post-consumption cutoff");
      assert.equal((await pool.query("SELECT 1 FROM versekit_consent_challenges WHERE challenge_hash=$1 AND expires_at>now() AND consumed_at IS NULL", [active.hash])).rowCount, 1, "active unexpired challenge is preserved");
      await pool.query("UPDATE versekit_consent_challenges SET expires_at=now()-interval '25 hours' WHERE challenge_hash=$1", [expired.hash]);
      await pool.query("UPDATE versekit_consent_challenges SET consumed_at=now()-interval '25 hours' WHERE challenge_hash=$1", [consumed.hash]);
      await store.cleanupCredentials();
      assert.equal((await pool.query("SELECT 1 FROM versekit_consent_challenges WHERE challenge_hash=$1", [expired.hash])).rowCount, 0, "challenge is deleted after expiry retention cutoff");
      assert.equal((await pool.query("SELECT 1 FROM versekit_consent_challenges WHERE challenge_hash=$1", [consumed.hash])).rowCount, 0, "challenge is deleted after consumption retention cutoff");
      assert.equal((await pool.query("SELECT 1 FROM versekit_consent_challenges WHERE challenge_hash=$1", [active.hash])).rowCount, 1, "active challenge remains after cleanup");
      for (const grant of [expired.grant, active.grant, consumed.grant]) assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [grant.id])).rowCount, 1, "challenge cleanup preserves its associated grant");
      assert.equal((await pool.query("SELECT status FROM versekit_device_grants WHERE id=$1", [consumed.grant.id])).rows[0].status, "denied", "challenge remains consumed and its denial remains recorded");
    });

    await t.test("cleanup deletes expired access rows while preserving active credentials and replay history", async () => {
      const { grant, tokens } = await issueApprovedPair();
      const familyId = await familyFor(tokens.refresh_token);
      const rotated = await store.refresh({ refreshToken: tokens.refresh_token, clientId: "versekit" });
      assert.ok(rotated.tokens, "refresh rotation establishes consumed-token history");
      const expiredAccess = codec.issue("vka");
      const expiredHash = codec.hash("access", expiredAccess);
      await pool.query("INSERT INTO versekit_tokens(family_id,token_hash,token_type,expires_at) VALUES($1,$2,'access',now()-interval '1 second')", [familyId, expiredHash]);
      const before = await pool.query("SELECT count(*)::int AS count FROM versekit_tokens WHERE family_id=$1 AND token_type='access' AND expires_at<now()", [familyId]);
      assert.equal(before.rows[0].count, 1, "expired access fixture exists before cleanup");
      await store.cleanupCredentials();
      assert.equal((await pool.query("SELECT 1 FROM versekit_tokens WHERE token_hash=$1", [expiredHash])).rowCount, 0, "expired access-token row is physically deleted");
      assert.equal((await pool.query("SELECT 1 FROM versekit_tokens WHERE token_hash=$1 AND expires_at>now() AND revoked_at IS NULL", [codec.hash("access", tokens.access_token)])).rowCount, 1, "active access-token row remains present");
      assert.equal((await store.authenticateAccess(tokens.access_token)).app_user_id, userId, "active access token remains usable");
      const history = await pool.query("SELECT revoked_at,replaced_by FROM versekit_tokens WHERE token_hash=$1 AND token_type='refresh'", [codec.hash("refresh", tokens.refresh_token)]);
      assert.equal(history.rowCount, 1, "consumed refresh row needed for replay detection remains stored");
      assert.ok(history.rows[0].revoked_at && history.rows[0].replaced_by, "stored refresh row retains its consumed rotation state");
      const nextRotation = await store.refresh({ refreshToken: rotated.tokens.refresh_token, clientId: "versekit" });
      assert.ok(nextRotation.tokens, "active refresh token remains usable after cleanup");
      assert.equal((await pool.query("SELECT 1 FROM versekit_token_families WHERE id=$1", [familyId])).rowCount, 1, "token family remains intact");
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [grant.id])).rowCount, 1, "originating consumed grant remains intact");
    });

    await t.test("orphanable grants are retained for 30 days and family-referenced grants are protected", async () => {
      const deniedGrant = async () => {
        const grant = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
        assert.equal(await store.consent({ grantId: grant.id, userId, scopes: [], approve: false }), true);
        return grant;
      };
      const boundaryGrant = await deniedGrant();
      const newerExpiredGrant = await deniedGrant();
      const referenced = await issueApprovedPair();
      const activePending = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      const approvedOrphan = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      assert.equal(await store.consent({ grantId: approvedOrphan.id, userId, scopes: ["orders:read"], approve: true }), true);
      const activeApproved = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      assert.equal(await store.consent({ grantId: activeApproved.id, userId, scopes: ["orders:read"], approve: true }), true);
      await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '31 days',expires_at=now()-interval '29 days' WHERE id=$1", [boundaryGrant.id]);
      await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1", [newerExpiredGrant.id]);
      await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '40 days',expires_at=now()-interval '39 days' WHERE id=$1", [referenced.grant.id]);
      await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '31 days',expires_at=now()-interval '29 days' WHERE id=$1", [approvedOrphan.id]);
      await store.cleanupCredentials();
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [boundaryGrant.id])).rowCount, 1, "orphan grant remains before 30-day post-expiry cutoff");
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1 AND status='approved'", [approvedOrphan.id])).rowCount, 1, "approved orphan grant remains before the 30-day cutoff");
      await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '32 days',expires_at=now()-interval '31 days' WHERE id=$1", [boundaryGrant.id]);
      await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '32 days',expires_at=now()-interval '31 days' WHERE id=$1", [approvedOrphan.id]);
      await store.cleanupCredentials();
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [boundaryGrant.id])).rowCount, 0, "orphan grant is deleted after 30-day post-expiry cutoff");
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [approvedOrphan.id])).rowCount, 0, "approved orphan grant is deleted after the 30-day cutoff");
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [newerExpiredGrant.id])).rowCount, 1, "newer expired grant remains within retention");
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1 AND status='pending'", [activePending.id])).rowCount, 1, "active pending grant is preserved");
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1 AND status='approved' AND expires_at>now()", [activeApproved.id])).rowCount, 1, "active approved grant is preserved");
      const referencedFamily = await familyFor(referenced.tokens.refresh_token);
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [referenced.grant.id])).rowCount, 1, "expired grant with a retained token family is not deleted");
      assert.equal((await pool.query("SELECT 1 FROM versekit_token_families WHERE id=$1", [referencedFamily])).rowCount, 1, "grant dependency remains attached to its token family");
      assert.equal((await pool.query("SELECT 1 FROM blueprint_groups WHERE id=$1", [anotherGroup])).rowCount, 1, "cleanup does not modify unrelated group records");
      assert.equal((await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND app_user_id=$2", [anotherGroup, otherOnlyId])).rowCount, 1, "cleanup does not modify unrelated member records");
    });

    await t.test("database-wide grant ceiling rejects excess and concurrent admissions, then recovers after cleanup", async () => {
      const count = async () => Number((await pool.query("SELECT count(*)::int AS n FROM versekit_device_grants")).rows[0].n);
      const base = await count();
      const limit = base + 3;
      const limited = new VersekitTokenStore({ db: pool, codec, groupId: realGroup, operationalScopes: ["orders:read"], maxRetainedGrants: limit });
      const first = await limited.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      const second = await limited.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      const third = await limited.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      await assert.rejects(limited.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] }), (error) => error.code === "VERSEKIT_GRANT_CAPACITY");
      assert.equal(await count(), limit, "the final available slot is usable and rejection inserts no grant");
      const httpAdapter = await createVersekitAdapter({ env: actual, db: pool, tokenPepper: testPepper, quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"], maxRetainedGrants: limit });
      const httpServer = createServer((req, res) => httpAdapter(req, res, new URL(req.url, "http://127.0.0.1")));
      await new Promise((resolve, reject) => { httpServer.once("error", reject); httpServer.listen(0, "127.0.0.1", resolve); });
      try {
        const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/versekit/v1/device/code`, {
          method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "client_id=versekit&scope=orders%3Aread", signal: AbortSignal.timeout(5_000)
        });
        assert.equal(response.status, 429);
        assert.equal(response.headers.get("retry-after"), "900");
        assert.deepEqual(await response.json(), { error: "temporarily_unavailable" }, "capacity response exposes no internal counts");
        assert.equal(await count(), limit, "HTTP capacity rejection does not insert a grant");
      } finally { await new Promise((resolve) => httpServer.close(resolve)); }
      await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '32 days',expires_at=now()-interval '31 days',status='denied',consented_at=now()-interval '32 days' WHERE id=$1", [first.id]);
      await limited.cleanupCredentials();
      assert.equal(await count(), limit - 1, "eligible cleanup makes exactly one slot available");
      const extraPool = await createTestPool(databaseUrl);
      try {
        const other = new VersekitTokenStore({ db: extraPool, codec, groupId: realGroup, operationalScopes: ["orders:read"], maxRetainedGrants: limit });
        const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => other.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] })));
        assert.equal(attempts.filter((x) => x.status === "fulfilled").length, 1);
        assert.equal(attempts.filter((x) => x.status === "rejected" && x.reason.code === "VERSEKIT_GRANT_CAPACITY").length, 4);
        assert.equal(await count(), limit, "concurrent admissions cannot exceed the shared limit");
        const admitted = attempts.find((x) => x.status === "fulfilled").value;
        await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '32 days',expires_at=now()-interval '31 days',status='denied',consented_at=now()-interval '32 days' WHERE id=$1", [admitted.id]);
        await other.cleanupCredentials();
        assert.equal(await count(), limit - 1, "real cleanup frees one storage slot");
        assert.ok(await limited.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] }), "admission resumes after cleanup");
        assert.equal(await count(), limit);
        assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=ANY($1::uuid[])", [[second.id, third.id]])).rowCount, 2, "existing valid grants are preserved");
      } finally { await extraPool.end(); }
    });

    await t.test("cleanup query failure rolls back, releases the connection, and recovers on retry", async () => {
      const eligible = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      assert.equal(await store.consent({ grantId: eligible.id, userId, scopes: [], approve: false }), true);
      await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '32 days',expires_at=now()-interval '31 days' WHERE id=$1", [eligible.id]);
      const valid = await issueApprovedPair();
      let injectFailure = true;
      const failingDb = {
        query: (...args) => pool.query(...args),
        async connect() {
          const client = await pool.connect();
          return {
            query(sql, params) {
              if (injectFailure && typeof sql === "string" && sql.includes("versekit_consent_challenges")) {
                injectFailure = false;
                throw Object.assign(new Error("injected cleanup query failure"), { code: "VK_TEST_FAILURE" });
              }
              return client.query(sql, params);
            },
            release: () => client.release()
          };
        }
      };
      const failingStore = new VersekitTokenStore({ db: failingDb, codec, groupId: realGroup, operationalScopes: ["orders:read"] });
      const unhandled = [];
      const onUnhandled = (reason) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        await assert.rejects(failingStore.cleanupCredentials(), /injected cleanup query failure/);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(unhandled, [], "observed cleanup rejection is not also unhandled");
      } finally { process.off("unhandledRejection", onUnhandled); }
      assert.equal((await pool.query("SELECT 1")).rowCount, 1, "database remains queryable after rollback and client release");
      assert.equal(pool.waitingCount, 0, "failed cleanup leaves no connection waiters");
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [eligible.id])).rowCount, 1, "failed transaction leaves eligible grant intact");
      const recovered = await failingStore.cleanupCredentials();
      assert.ok(recovered.grants >= 1, "subsequent cleanup retries and removes the eligible grant");
      assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [eligible.id])).rowCount, 0, "eligible grant is eventually removed");
      assert.equal((await store.authenticateAccess(valid.tokens.access_token)).app_user_id, userId, "valid unrelated access remains usable");
      assert.ok((await store.refresh({ refreshToken: valid.tokens.refresh_token, clientId: "versekit" })).tokens, "valid unrelated refresh remains usable");
    });

    await t.test("PostgreSQL cleanup overlaps safely with refresh, revocation, and authorization", { timeout: 15_000 }, async () => {
      const makeDeferred = () => {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        return { promise, resolve };
      };
      const timed = (promise, label) => {
        let timeout;
        return Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000); })])
          .finally(() => clearTimeout(timeout));
      };
      const refreshing = await issueApprovedPair();
      const refreshFamily = await familyFor(refreshing.tokens.refresh_token);
      const revoking = await issueApprovedPair();
      const revokeFamily = await familyFor(revoking.tokens.refresh_token);
      const expiredAccess = codec.issue("vka");
      const expiredHash = codec.hash("access", expiredAccess);
      await pool.query("INSERT INTO versekit_tokens(family_id,token_hash,token_type,expires_at) VALUES($1,$2,'access',now()-interval '1 second')", [refreshFamily, expiredHash]);
      const cleanupPool = await createTestPool(databaseUrl);
      const cleanupEntered = makeDeferred();
      const releaseCleanup = makeDeferred();
      let paused = false;
      const coordinatedDb = {
        query: (...args) => cleanupPool.query(...args),
        async connect() {
          const client = await cleanupPool.connect();
          return {
            async query(sql, params) {
              const result = await client.query(sql, params);
              if (!paused && typeof sql === "string" && sql.startsWith("WITH doomed AS")) {
                paused = true;
                cleanupEntered.resolve();
                await releaseCleanup.promise;
              }
              return result;
            },
            release: () => client.release()
          };
        }
      };
      const otherInstance = new VersekitTokenStore({ db: coordinatedDb, codec, groupId: realGroup, operationalScopes: ["orders:read"] });
      let cleanupPromise;
      let cleanupResult;
      let rotatedTokens;
      try {
        cleanupPromise = timed(otherInstance.cleanupCredentials(), "cleanup transaction");
        await timed(cleanupEntered.promise, "cleanup coordination");
        const [rotation] = await timed(Promise.all([
          store.refresh({ refreshToken: refreshing.tokens.refresh_token, clientId: "versekit" }),
          store.revoke(revoking.tokens.refresh_token)
        ]), "concurrent refresh and revocation");
        assert.ok(rotation.tokens, "refresh commits while cleanup transaction is open");
        rotatedTokens = rotation.tokens;
        assert.equal((await store.authenticateAccess(refreshing.tokens.access_token)).app_user_id, userId, "valid access remains usable during cleanup");
        assert.equal(await store.authenticateAccess(expiredAccess), null, "expired access remains unusable during cleanup");
        const revokeState = await pool.query("SELECT f.revoked_at,count(t.id)::int AS total,count(t.id) FILTER (WHERE t.revoked_at IS NOT NULL)::int AS revoked FROM versekit_token_families f JOIN versekit_tokens t ON t.family_id=f.id WHERE f.id=$1 GROUP BY f.id", [revokeFamily]);
        assert.ok(revokeState.rows[0].revoked_at);
        assert.equal(revokeState.rows[0].revoked, revokeState.rows[0].total, "concurrent revocation marks every family credential");
      } finally {
        releaseCleanup.resolve();
        if (cleanupPromise) {
          try { cleanupResult = await cleanupPromise; } catch { /* Preserve the original assertion while closing the test pool. */ }
        }
        await cleanupPool.end();
      }
      assert.equal((await pool.query("SELECT 1 FROM versekit_tokens WHERE token_hash=$1", [expiredHash])).rowCount, 0, "cleanup removes expired access row after concurrent operations");
      assert.equal((await pool.query("SELECT revoked_at FROM versekit_token_families WHERE id=$1", [refreshFamily])).rows[0].revoked_at, null, "cleanup does not revoke the refreshed family");
      assert.equal((await store.authenticateAccess(rotatedTokens.access_token)).app_user_id, userId, "refresh family remains authorized after cleanup");
      const familyRows = await pool.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE token_type='refresh')::int AS refreshes FROM versekit_tokens WHERE family_id=$1", [refreshFamily]);
      assert.equal(familyRows.rows[0].total, 4, "one concurrent refresh issued exactly one credential pair");
      assert.equal(familyRows.rows[0].refreshes, 2, "one consumed and one active refresh row remain for replay detection");
      assert.equal((await pool.query("SELECT 1 FROM versekit_tokens WHERE token_hash=$1 AND replaced_by IS NOT NULL", [codec.hash("refresh", refreshing.tokens.refresh_token)])).rowCount, 1, "consumed refresh history survives concurrent cleanup");
      assert.deepEqual(await store.refresh({ refreshToken: refreshing.tokens.refresh_token, clientId: "versekit" }), { error: "invalid_grant" }, "consumed credential remains replay-detectable");
      assert.equal(await store.authenticateAccess(rotatedTokens.access_token), null, "replay protection revokes credentials issued during the race");
      assert.equal(await store.authenticateAccess(revoking.tokens.access_token), null, "concurrent revocation remains effective after cleanup");
      assert.equal((await store.refresh({ refreshToken: revoking.tokens.refresh_token, clientId: "versekit" })).error, "invalid_grant");
      assert.ok(cleanupResult && typeof cleanupResult.accessTokens === "number", "cleanup transaction completed with its normal result");

      const stale = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      assert.equal(await store.consent({ grantId: stale.id, userId, scopes: [], approve: false }), true);
      await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '32 days',expires_at=now()-interval '31 days' WHERE id=$1", [stale.id]);
      const secondPool = await createTestPool(databaseUrl);
      try {
        const secondInstance = new VersekitTokenStore({ db: secondPool, codec, groupId: realGroup, operationalScopes: ["orders:read"] });
        await timed(Promise.all([store.cleanupCredentials(), secondInstance.cleanupCredentials()]), "cross-instance cleanup");
        assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [stale.id])).rowCount, 0, "independent PostgreSQL pools safely remove the eligible grant once");
        assert.equal((await store.authenticateAccess(revoking.tokens.access_token)), null, "second cleanup does not resurrect revoked credentials");
      } finally { await secondPool.end(); }
    });

    await t.test("VerseKit cleanup scheduler is enabled-only, bounded, recoverable, and non-overlapping", { timeout: 15_000 }, async () => {
      const intervals = [];
      const originalSetInterval = globalThis.setInterval;
      globalThis.setInterval = (callback, delay) => {
        const handle = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
        intervals.push(handle);
        return handle;
      };
      const disabledDb = { query() { throw new Error("disabled adapter touched database"); } };
      try {
        for (const value of [undefined, "false", "TRUE", "1", "malformed"]) {
          const env = { ...enabled };
          if (value === undefined) delete env.VERSEKIT_ENABLED;
          else env.VERSEKIT_ENABLED = value;
          assert.equal(await createVersekitAdapter({ env, db: disabledDb, tokenPepper: testPepper }), null);
        }
        assert.equal(intervals.length, 0, "disabled and invalid flag values register no cleanup timer");
        await assert.rejects(createVersekitAdapter({ env: { ...enabled, VERSEKIT_GROUP_ID: "bad" }, db: pool, tokenPepper: testPepper }), /VERSEKIT_GROUP_ID/);
        const failedInitializationDb = { query: async (sql, params) => {
          if (typeof sql === "string" && sql.includes("CREATE TABLE IF NOT EXISTS versekit_device_grants")) throw new Error("injected schema initialization failure");
          return pool.query(sql, params);
        } };
        await assert.rejects(createVersekitAdapter({ env: actual, db: failedInitializationDb, tokenPepper: testPepper }), /injected schema initialization failure/);
        assert.equal(intervals.length, 0, "invalid configuration and failed initialization leave no timer");

        let failCleanup = false;
        let pauseCleanup = false;
        let cleanupStatements = 0;
        const cleanupBatchSizes = [];
        const cleanupEntered = (() => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; })();
        const releaseCleanup = (() => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; })();
        const scheduledDb = {
          query: (...args) => pool.query(...args),
          async connect() {
            const client = await pool.connect();
            return {
              async query(sql, params) {
                if (typeof sql === "string" && sql.startsWith("WITH doomed AS")) {
                  cleanupStatements++;
                  cleanupBatchSizes.push(params?.[0]);
                  if (failCleanup) {
                    failCleanup = false;
                    throw Object.assign(new Error("injected scheduled cleanup failure"), { code: "VK_TEST_FAILURE" });
                  }
                  const result = await client.query(sql, params);
                  if (pauseCleanup) {
                    pauseCleanup = false;
                    cleanupEntered.resolve();
                    await releaseCleanup.promise;
                  }
                  return result;
                }
                return client.query(sql, params);
              },
              release: () => client.release()
            };
          }
        };
        const adapter = await createVersekitAdapter({ env: actual, db: scheduledDb, tokenPepper: testPepper, quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"] });
        assert.equal(typeof adapter, "function", "normal enabled adapter startup succeeds");
        assert.equal(intervals.length, 1, "enabled timer is registered after schema and adapter initialization");
        const timer = intervals[0];
        assert.equal(timer.delay, 15 * 60_000, "cleanup interval remains 15 minutes");
        assert.equal(timer.unrefCalled, true, "cleanup timer does not keep the server process alive");
        assert.ok((await pool.query("SELECT to_regclass('versekit_device_grants') AS table_name")).rows[0].table_name, "schema initialization succeeded before timer registration");

        const cleanupEligible = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
        assert.equal(await store.consent({ grantId: cleanupEligible.id, userId, scopes: [], approve: false }), true);
        await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '32 days',expires_at=now()-interval '31 days' WHERE id=$1", [cleanupEligible.id]);
        const unhandled = [];
        const onUnhandled = (reason) => unhandled.push(reason);
        const originalWarn = console.warn;
        process.on("unhandledRejection", onUnhandled);
        console.warn = () => {};
        try {
          failCleanup = true;
          await timer.callback();
          await new Promise((resolve) => setImmediate(resolve));
          assert.deepEqual(unhandled, [], "scheduled cleanup rejection is handled");
          assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [cleanupEligible.id])).rowCount, 1, "failed scheduled transaction leaves cleanup candidate intact");
          await timer.callback();
          assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [cleanupEligible.id])).rowCount, 0, "later timer run succeeds after failure");
          assert.ok(cleanupBatchSizes.some((size) => size === 200), "scheduled cleanup uses the required 200-row batch size");

          const overlapEligible = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
          assert.equal(await store.consent({ grantId: overlapEligible.id, userId, scopes: [], approve: false }), true);
          await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '32 days',expires_at=now()-interval '31 days' WHERE id=$1", [overlapEligible.id]);
          pauseCleanup = true;
          const before = cleanupStatements;
          const first = timer.callback();
          await cleanupEntered.promise;
          const during = cleanupStatements;
          await timer.callback();
          assert.equal(cleanupStatements, during, "overlapping timer trigger starts no second cleanup query");
          assert.ok(during > before, "first timer trigger did start cleanup");
          releaseCleanup.resolve();
          await first;
          assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [overlapEligible.id])).rowCount, 0, "the admitted cleanup run completes normally");
        } finally {
          console.warn = originalWarn;
          process.off("unhandledRejection", onUnhandled);
          releaseCleanup.resolve();
        }
      } finally { globalThis.setInterval = originalSetInterval; }
    });

    await t.test("VerseKit HTTP bodies enforce size and deadlines and abort without authorization changes", { timeout: 30_000 }, async (httpTest) => {
      let browserUserId = userId;
      let serverOrigin;
      const forcedRateRejections = { device: null, token: null, revoke: null, me: null, consent: null };
      const testLimiter = (key, options) => {
        const normal = createRequestRateLimiter(options);
        return { consume: (peer) => forcedRateRejections[key] === true ? { allowed: false, retryAfter: 17 } : forcedRateRejections[key] === "allow" ? { allowed: true } : normal.consume(peer) };
      };
      const sessionToken = "s".repeat(40);
      const adapter = await createVersekitAdapter({
        env: actual, db: pool, tokenPepper: testPepper, quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"], requestBodyDeadlineMs: 250,
        deviceCodeLimiter: testLimiter("device", { limit: 10, windowMs: 10 * 60_000 }),
        tokenLimiter: testLimiter("token", { limit: 60, windowMs: 60_000 }),
        revokeLimiter: testLimiter("revoke", { limit: 30, windowMs: 60_000 }),
        meLimiter: testLimiter("me", { limit: 120, windowMs: 60_000 }),
        consentLimiter: testLimiter("consent", { limit: 20, windowMs: 10 * 60_000 }),
        getSessionToken: () => sessionToken,
        getSessionContext: async () => ({ appUserId: browserUserId }),
        getCurrentAppUser: async () => {
          const found = await pool.query("SELECT id,display_name,verselink_name,account_status FROM app_users WHERE id=$1", [browserUserId]);
          return found.rows[0] || null;
        },
        sameOrigin: (req) => req.headers.origin === serverOrigin
      });
      let heldRejection = null;
      const server = createServer((req, res) => {
        if (heldRejection && req.method === "PUT" && req.url === "/versekit/v1/device/code") {
          const held = heldRejection;
          heldRejection = null;
          const originalEnd = res.end.bind(res);
          held.response = res;
          held.socket = res.socket;
          res.once("close", held.resolveResponseClose);
          res.socket?.once("close", held.resolveSocketClose);
          res.end = (...args) => {
            held.status = res.statusCode;
            held.connection = res.getHeader("connection");
            held.resolveAttempt();
            return held.releasePromise.then(() => {
              originalEnd(...args);
              held.resolveEndInvoked();
              return res;
            }).catch((error) => { held.endError = error; held.resolveEndInvoked(); return res; });
          };
        }
        Promise.resolve(adapter(req, res, new URL(req.url, "http://127.0.0.1"))).catch(() => {
          if (!res.headersSent && !res.destroyed) { res.writeHead(500, { connection: "close" }); res.end(); }
        });
      });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      const host = "127.0.0.1";
      const port = address.port;
      serverOrigin = `http://${host}:${port}`;
      const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const within = (promise, label, ms = 2_000) => {
        let timer;
        return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); })])
          .finally(() => clearTimeout(timer));
      };
      const callHttp = (path, { method = "GET", body, headers = {} } = {}) => new Promise((resolve, reject) => {
        const request = httpRequest({ hostname: host, port, path, method, headers, agent: false, timeout: 3_000 }, (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
        });
        request.once("error", reject);
        request.end(body);
      });
      const postForm = (path, body, extraHeaders = {}) => callHttp(path, {
        method: "POST", body,
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)), ...extraHeaders }
      });
      const grantCount = async () => Number((await pool.query("SELECT count(*)::int AS count FROM versekit_device_grants")).rows[0].count);
      const requestState = async () => ({
        grants: await grantCount(),
        families: Number((await pool.query("SELECT count(*)::int AS count FROM versekit_token_families")).rows[0].count),
        tokens: Number((await pool.query("SELECT count(*)::int AS count FROM versekit_tokens")).rows[0].count),
        challenges: Number((await pool.query("SELECT count(*)::int AS count FROM versekit_consent_challenges")).rows[0].count)
      });
      const partialUpload = async (label, path, method, headers, expectedStatus, expectedBody) => {
        let request;
        let resolveClosed;
        const closed = new Promise((resolve) => { resolveClosed = resolve; });
        try {
          const responsePromise = new Promise((resolve) => {
            request = httpRequest({ hostname: host, port, path, method, headers, agent: false }, (res) => {
              const chunks = [];
              res.on("data", (chunk) => chunks.push(chunk));
              res.once("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
            });
            request.once("socket", (socket) => socket.once("close", resolveClosed));
            request.once("error", () => {});
            request.write("partial-upload-");
          });
          const response = await within(responsePromise, label + " response", 2_000);
          assert.equal(response.status, expectedStatus, label + " preserves rejection status");
          assert.equal(response.headers.connection, "close", label + " closes the HTTP connection");
          if (expectedBody !== undefined) assert.deepEqual(JSON.parse(response.body), expectedBody, label + " preserves response body");
          await within(closed, label + " socket close", 2_000);
          assert.equal(request.socket.destroyed, true, label + " cannot transmit on a reused connection");
          return response;
        } finally {
          if (request && !request.destroyed) request.destroy();
        }
      };
      const consentSetup = async () => {
        const grant = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
        const login = await callHttp("/device");
        assert.equal(login.status, 200);
        const lookupCsrf = /name="csrf" value="([^"]+)"/.exec(login.body)?.[1];
        assert.ok(lookupCsrf, "browser form contains its session-bound CSRF token");
        const lookupBody = new URLSearchParams({ action: "lookup", csrf: lookupCsrf, user_code: grant.userCode }).toString();
        const review = await postForm("/device", lookupBody, { origin: serverOrigin });
        assert.equal(review.status, 200);
        const challenge = /name="challenge" value="([^"]+)"/.exec(review.body)?.[1];
        const csrf = /name="csrf" value="([^"]+)"/.exec(review.body)?.[1];
        assert.ok(challenge && csrf, "review page contains a one-time challenge and CSRF token");
        return { grant, challenge, csrf, challengeHash: codec.hash("consent_challenge", challenge) };
      };
      const consentBody = (setup, action = "approve", csrf = setup.csrf) => new URLSearchParams({ action, challenge: setup.challenge, csrf, ...(action === "approve" ? { scope: "orders:read" } : {}) }).toString();
      try {
        await httpTest.test("early VerseKit OAuth rejection handles client disconnect during response flush", async () => {
          const before = await requestState();
          let resolveAttempt; let resolveRelease; let resolveResponseClose; let resolveSocketClose; let resolveEndInvoked;
          const attemptPromise = new Promise((resolve) => { resolveAttempt = resolve; });
          const releasePromise = new Promise((resolve) => { resolveRelease = resolve; });
          const responseClosePromise = new Promise((resolve) => { resolveResponseClose = resolve; });
          const socketClosePromise = new Promise((resolve) => { resolveSocketClose = resolve; });
          const endInvokedPromise = new Promise((resolve) => { resolveEndInvoked = resolve; });
          const control = { attemptPromise, releasePromise, resolveAttempt, resolveResponseClose, resolveSocketClose, resolveEndInvoked, resolveRelease };
          heldRejection = control;
          let client;
          try {
            client = httpRequest({ hostname: host, port, path: "/versekit/v1/device/code", method: "PUT", agent: false,
              headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "1000" } });
            client.on("error", () => {});
            client.write("client_id=versekit&scope=orders%3Aread");
            await within(attemptPromise, "real early-rejection response attempt");
            assert.equal(control.status, 400, "real OAuth handler reached its method-rejection response");
            assert.equal(control.connection, "close", "real rejection marked the response connection for closure");

            client.destroy();
            await within(socketClosePromise, "server-side socket close after client disconnect");
            await within(responseClosePromise, "ServerResponse close after client disconnect");
            control.resolveRelease();
            await within(endInvokedPromise, "released response completion");
            assert.equal(control.endError, undefined, "delayed response completion remained safe after disconnect");
            assert.equal(await requestState().then((state) => JSON.stringify(state)), JSON.stringify(before), "early rejection and disconnect changed no credential state");
            forcedRateRejections.device = "allow";
            const valid = await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread");
            forcedRateRejections.device = null;
            assert.equal(valid.status, 200, "server handles a valid request after the disconnected rejection");
          } finally {
            control.resolveRelease();
            client?.destroy();
            if (heldRejection === control) heldRejection = null;
          }
        });
        const before = await grantCount();
        const normal = await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread");
        assert.equal(normal.status, 200, "valid below-limit form is accepted");
        const prefix = "client_id=versekit&scope=orders%3Aread&pad=";
        const exactBody = prefix + "x".repeat(VERSEKIT_FORM_BODY_LIMIT - Buffer.byteLength(prefix));
        assert.equal(Buffer.byteLength(exactBody), VERSEKIT_FORM_BODY_LIMIT);
        assert.equal((await postForm("/versekit/v1/device/code", exactBody)).status, 200, "body exactly at the limit is accepted");
        const afterValid = await grantCount();
        assert.equal(afterValid, before + 2, "valid boundary forms each create one grant");
        const duplicate = await postForm("/versekit/v1/device/code", "client_id=versekit&client_id=versekit&scope=orders%3Aread");
        assert.equal(duplicate.status, 400, "duplicate security-critical form field is rejected");
        const wrongContentType = await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread", { "content-type": "application/json" });
        assert.equal(wrongContentType.status, 400, "non-form content type is rejected");
        assert.equal(wrongContentType.headers.connection, "close", "unparsed request body cannot reuse its connection");
        const overLimit = await postForm("/versekit/v1/device/code", prefix + "x".repeat(VERSEKIT_FORM_BODY_LIMIT));
        assert.equal(overLimit.status, 413, "known oversized Content-Length is rejected with HTTP 413");
        assert.equal(overLimit.headers.connection, "close", "oversized request cannot reuse its connection");
        assert.equal(await grantCount(), afterValid, "invalid and oversized forms create no grants");

        const streamingResult = new Promise((resolve, reject) => {
          const request = httpRequest({ hostname: host, port, path: "/versekit/v1/device/code", method: "POST", agent: false,
            headers: { "content-type": "application/x-www-form-urlencoded", "transfer-encoding": "chunked" } }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString("utf8"), request }));
          });
          request.on("error", () => {});
          request.write(Buffer.alloc(4_000, 97));
          void (async () => {
            await delay(20);
            request.write(Buffer.alloc(4_000, 98));
            await delay(20);
            request.write(Buffer.alloc(512, 99)); // Cross the server limit in a later stream chunk.
            await delay(20);
            try { request.write(Buffer.alloc(4_096, 100)); } catch { /* The closed connection is the expected outcome. */ }
          })().catch(reject);
        });
        const streamed = await within(streamingResult, "streaming oversized request");
        assert.equal(streamed.status, 413, "chunked body crossing the limit receives HTTP 413");
        assert.equal(streamed.headers.connection, "close", "streaming rejection closes the connection");
        assert.equal(await grantCount(), afterValid, "streaming oversized request creates no grant");
        assert.equal((await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread")).status, 200, "server accepts a valid request after streamed rejection");

        const tokenState = await issueApprovedPair();
        const tokenFamily = await familyFor(tokenState.tokens.refresh_token);
        const tokenRowsBefore = Number((await pool.query("SELECT count(*)::int AS count FROM versekit_tokens WHERE family_id=$1", [tokenFamily])).rows[0].count);
        const oversizedToken = await postForm("/versekit/v1/token", `client_id=versekit&grant_type=refresh_token&refresh_token=${encodeURIComponent(tokenState.tokens.refresh_token)}&pad=${"x".repeat(VERSEKIT_FORM_BODY_LIMIT)}`);
        assert.equal(oversizedToken.status, 413, "oversized token request is rejected before refresh rotation");
        assert.equal(Number((await pool.query("SELECT count(*)::int AS count FROM versekit_tokens WHERE family_id=$1", [tokenFamily])).rows[0].count), tokenRowsBefore, "oversized token request issues no credentials");
        assert.equal((await store.authenticateAccess(tokenState.tokens.access_token)).app_user_id, userId, "oversized token request does not invalidate its family");

        const revokeState = await issueApprovedPair();
        const revokeFamily = await familyFor(revokeState.tokens.refresh_token);
        const oversizedRevoke = await postForm("/versekit/v1/revoke", `token=${encodeURIComponent(revokeState.tokens.refresh_token)}&pad=${"x".repeat(VERSEKIT_FORM_BODY_LIMIT)}`);
        assert.equal(oversizedRevoke.status, 413, "oversized revocation request is rejected before revocation");
        assert.equal((await pool.query("SELECT revoked_at FROM versekit_token_families WHERE id=$1", [revokeFamily])).rows[0].revoked_at, null, "oversized revoke cannot revoke the family");
        assert.equal((await store.authenticateAccess(revokeState.tokens.access_token)).app_user_id, userId, "oversized revoke leaves access usable");

        const stalledBefore = await grantCount();
        const stalledResponse = new Promise((resolve, reject) => {
          const request = httpRequest({ hostname: host, port, path: "/versekit/v1/device/code", method: "POST", agent: false,
            headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "1000" } }, (response) => {
            const chunks = [];
            response.on("data", (chunk) => chunks.push(chunk));
            response.on("end", () => resolve({ status: response.statusCode, headers: response.headers }));
          });
          request.on("error", () => {});
          request.write("client_id=versekit&scope=");
        });
        const stalled = await within(stalledResponse, "stalled body deadline");
        assert.equal(stalled.status, 408, "incomplete body is rejected at the configured deadline");
        assert.equal(stalled.headers.connection, "close");
        assert.equal(await grantCount(), stalledBefore, "stalled request creates no grant");

        const disconnectBefore = await grantCount();
        const disconnected = httpRequest({ hostname: host, port, path: "/versekit/v1/device/code", method: "POST", agent: false,
          headers: { "content-type": "application/x-www-form-urlencoded", "content-length": "1000" } });
        disconnected.on("error", () => {});
        disconnected.write("client_id=versekit&scope=orders%3Aread");
        await delay(30);
        disconnected.destroy();
        await delay(300); // Longer than the injected deadline: the aborted reader must already be settled.
        assert.equal(await grantCount(), disconnectBefore, "client disconnect cannot create a grant");
        assert.equal((await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread")).status, 200, "server remains responsive after client disconnect");

        const oversizedConsent = await consentSetup();
        const consentBefore = await pool.query("SELECT status FROM versekit_device_grants WHERE id=$1", [oversizedConsent.grant.id]);
        const paddedDecision = consentBody(oversizedConsent) + `&pad=${"x".repeat(VERSEKIT_FORM_BODY_LIMIT)}`;
        const rejectedApproval = await postForm("/device", paddedDecision, { origin: serverOrigin });
        assert.equal(rejectedApproval.status, 413, "oversized browser approval is rejected");
        const oversizedState = await pool.query("SELECT g.status,c.consumed_at FROM versekit_device_grants g JOIN versekit_consent_challenges c ON c.grant_id=g.id WHERE g.id=$1 AND c.challenge_hash=$2", [oversizedConsent.grant.id, oversizedConsent.challengeHash]);
        assert.equal(oversizedState.rows[0].status, consentBefore.rows[0].status);
        assert.equal(oversizedState.rows[0].consumed_at, null, "oversized approval does not consume challenge or change grant state");

        const stalledConsent = await consentSetup();
        const partialDecision = consentBody(stalledConsent, "deny");
        const stalledDecisionPromise = new Promise((resolve, reject) => {
          const request = httpRequest({ hostname: host, port, path: "/device", method: "POST", agent: false,
            headers: { origin: serverOrigin, "content-type": "application/x-www-form-urlencoded", "content-length": "1000" } }, (response) => {
            response.resume(); response.on("end", () => resolve(response.statusCode));
          });
          request.on("error", () => {});
          request.write(partialDecision.slice(0, Math.max(1, partialDecision.length - 5)));
        });
        const stalledDecision = await within(stalledDecisionPromise, "stalled consent decision");
        assert.equal(stalledDecision, 408, "incomplete browser denial is rejected at the deadline");
        const stalledState = await pool.query("SELECT g.status,c.consumed_at FROM versekit_device_grants g JOIN versekit_consent_challenges c ON c.grant_id=g.id WHERE g.id=$1 AND c.challenge_hash=$2", [stalledConsent.grant.id, stalledConsent.challengeHash]);
        assert.equal(stalledState.rows[0].status, "pending");
        assert.equal(stalledState.rows[0].consumed_at, null, "incomplete denial does not change authorization state");

        const disconnectedConsent = await consentSetup();
        const disconnectDecision = httpRequest({ hostname: host, port, path: "/device", method: "POST", agent: false,
          headers: { origin: serverOrigin, "content-type": "application/x-www-form-urlencoded", "content-length": "1000" } });
        disconnectDecision.on("error", () => {});
        disconnectDecision.write(consentBody(disconnectedConsent, "deny").slice(0, 30));
        await delay(30);
        disconnectDecision.destroy();
        await delay(300);
        const disconnectedState = await pool.query("SELECT g.status,c.consumed_at FROM versekit_device_grants g JOIN versekit_consent_challenges c ON c.grant_id=g.id WHERE g.id=$1 AND c.challenge_hash=$2", [disconnectedConsent.grant.id, disconnectedConsent.challengeHash]);
        assert.equal(disconnectedState.rows[0].status, "pending");
        assert.equal(disconnectedState.rows[0].consumed_at, null, "disconnected denial does not change authorization state");

        const csrfConsent = await consentSetup();
        const csrfRejected = await postForm("/device", consentBody(csrfConsent, "approve", "invalid-csrf"), { origin: serverOrigin });
        assert.equal(csrfRejected.status, 403, "body limits preserve the browser CSRF check");
        const csrfState = await pool.query("SELECT status FROM versekit_device_grants WHERE id=$1", [csrfConsent.grant.id]);
        assert.equal(csrfState.rows[0].status, "pending", "invalid CSRF does not change grant state");

        const replayConsent = await consentSetup();
        const acceptedDecision = consentBody(replayConsent);
        assert.equal((await postForm("/device", acceptedDecision, { origin: serverOrigin })).status, 200, "valid consent remains accepted");
        assert.equal((await postForm("/device", acceptedDecision, { origin: serverOrigin })).status, 400, "consumed challenge cannot be reused");
        const replayState = await pool.query("SELECT g.status,c.consumed_at FROM versekit_device_grants g JOIN versekit_consent_challenges c ON c.grant_id=g.id WHERE g.id=$1 AND c.challenge_hash=$2", [replayConsent.grant.id, replayConsent.challengeHash]);
        assert.equal(replayState.rows[0].status, "approved");
        assert.ok(replayState.rows[0].consumed_at, "challenge remains consumed after replay attempt");

        await httpTest.test("early OAuth rejections close unread uploads without changing credential state", async () => {
          const before = await requestState();
          const unchanged = async (label) => assert.deepEqual(await requestState(), before, label);
          await partialUpload("wrong OAuth method", "/versekit/v1/token", "PUT", { "content-type": "application/x-www-form-urlencoded", "content-length": "1000" }, 400, { error: "invalid_request" });
          await unchanged("wrong method changes no credential state");
          await partialUpload("OAuth query rejection", "/versekit/v1/device/code?unexpected=1", "POST", { "content-type": "application/x-www-form-urlencoded", "transfer-encoding": "chunked" }, 400, { error: "invalid_request" });
          await unchanged("unexpected query changes no credential state");
          await partialUpload("discovery rejects unread request body", "/.well-known/versekit-org.json", "GET", { "content-length": "1000" }, 200);
          await unchanged("discovery changes no credential state");
          const ordersUnauthorized = await partialUpload("Orders requires a bearer token", "/versekit/v1/orders", "GET", { "content-length": "1000" }, 401, { type: "about:blank", status: 401, code: "UNAUTHORIZED" });
          assert.equal(ordersUnauthorized.headers["www-authenticate"], 'Bearer error="invalid_token"');
          await unchanged("unauthorized Orders request changes no credential state");
          await partialUpload("/me wrong method", "/versekit/v1/me", "PUT", { "content-length": "1000" }, 405, { type: "about:blank", status: 405, code: "METHOD_NOT_ALLOWED" });
          await unchanged("/me method rejection changes no credential state");
          await partialUpload("/me query rejection", "/versekit/v1/me?unexpected=1", "GET", { "content-length": "1000" }, 400, { type: "about:blank", status: 400, code: "INVALID_REQUEST" });
          await unchanged("/me query rejection changes no credential state");
          await partialUpload("/me authorization rejection", "/versekit/v1/me", "GET", { "content-length": "1000" }, 401, { type: "about:blank", status: 401, code: "UNAUTHORIZED" });
          await unchanged("/me authorization rejection changes no credential state");
          forcedRateRejections.device = true;
          const deviceLimited = await partialUpload("device-code rate limit", "/versekit/v1/device/code", "POST", { "content-type": "application/x-www-form-urlencoded", "content-length": "1000" }, 429, { error: "temporarily_unavailable" });
          assert.equal(deviceLimited.headers["retry-after"], "17");
          await unchanged("device-code limiter changes no credential state");
          forcedRateRejections.device = null;
          forcedRateRejections.token = true;
          const tokenLimited = await partialUpload("token rate limit", "/versekit/v1/token", "POST", { "content-type": "application/x-www-form-urlencoded", "transfer-encoding": "chunked" }, 429, { error: "temporarily_unavailable" });
          assert.equal(tokenLimited.headers["retry-after"], "17");
          await unchanged("token limiter changes no credential state");
          forcedRateRejections.token = null;
          forcedRateRejections.revoke = true;
          const revokeLimited = await partialUpload("revocation rate limit", "/versekit/v1/revoke", "POST", { "content-type": "application/x-www-form-urlencoded", "content-length": "1000" }, 429, { error: "temporarily_unavailable" });
          assert.equal(revokeLimited.headers["retry-after"], "17");
          await unchanged("revocation limiter changes no credential state");
          forcedRateRejections.revoke = null;
          forcedRateRejections.me = true;
          await partialUpload("/me rate limit", "/versekit/v1/me", "GET", { "content-length": "1000" }, 429, { type: "about:blank", status: 429, code: "RATE_LIMITED" });
          await unchanged("/me rate limit changes no credential state");
          forcedRateRejections.me = null;
          assert.deepEqual(await requestState(), before, "early OAuth rejection changes no grant, token, family, or challenge rows");
          forcedRateRejections.device = "allow";
          const normal = await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread");
          forcedRateRejections.device = null;
          assert.equal(normal.status, 200, "a valid request succeeds after early rejections");
          assert.equal((await requestState()).grants, before.grants + 1);
        });

        await httpTest.test("early browser consent rejections close unread uploads without changing authorization state", async () => {
          const setup = await consentSetup();
          const stateBefore = await pool.query("SELECT g.status,c.consumed_at FROM versekit_device_grants g JOIN versekit_consent_challenges c ON c.grant_id=g.id WHERE g.id=$1 AND c.challenge_hash=$2", [setup.grant.id, setup.challengeHash]);
          assert.equal(stateBefore.rows[0].status, "pending");
          assert.equal(stateBefore.rows[0].consumed_at, null);
          await partialUpload("invalid consent Origin", "/device", "POST", { origin: "http://attacker.invalid", "content-type": "application/x-www-form-urlencoded", "content-length": "1000" }, 403);
          await partialUpload("unsupported consent method", "/device", "PUT", { origin: serverOrigin, "content-type": "application/x-www-form-urlencoded", "transfer-encoding": "chunked" }, 405);
          forcedRateRejections.consent = true;
          await partialUpload("consent rate limit", "/device", "POST", { origin: serverOrigin, "content-type": "application/x-www-form-urlencoded", "content-length": "1000" }, 429);
          forcedRateRejections.consent = null;
          const stateAfterRejects = await pool.query("SELECT g.status,c.consumed_at FROM versekit_device_grants g JOIN versekit_consent_challenges c ON c.grant_id=g.id WHERE g.id=$1 AND c.challenge_hash=$2", [setup.grant.id, setup.challengeHash]);
          assert.deepEqual(stateAfterRejects.rows[0], stateBefore.rows[0], "early rejections neither decide nor consume consent");
          const invalidCsrf = await postForm("/device", consentBody(setup, "approve", "invalid-csrf"), { origin: serverOrigin });
          assert.equal(invalidCsrf.status, 403, "CSRF protection remains effective");
          const stateAfterCsrf = await pool.query("SELECT g.status,c.consumed_at FROM versekit_device_grants g JOIN versekit_consent_challenges c ON c.grant_id=g.id WHERE g.id=$1 AND c.challenge_hash=$2", [setup.grant.id, setup.challengeHash]);
          assert.deepEqual(stateAfterCsrf.rows[0], stateBefore.rows[0]);
          forcedRateRejections.consent = "allow";
          const valid = await postForm("/device", consentBody(setup), { origin: serverOrigin });
          forcedRateRejections.consent = null;
          assert.equal(valid.status, 200, "the valid session and CSRF-bound decision still succeeds");
          const stateAfterValid = await pool.query("SELECT g.status,c.consumed_at FROM versekit_device_grants g JOIN versekit_consent_challenges c ON c.grant_id=g.id WHERE g.id=$1 AND c.challenge_hash=$2", [setup.grant.id, setup.challengeHash]);
          assert.equal(stateAfterValid.rows[0].status, "approved");
          assert.ok(stateAfterValid.rows[0].consumed_at);
        });

        const unrelated = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
        browserUserId = otherOnlyId;
        const unrelatedLookup = await postForm("/device", new URLSearchParams({ action: "lookup", csrf: "x", user_code: unrelated.userCode }).toString(), { origin: serverOrigin });
        assert.equal(unrelatedLookup.status, 401, "member outside the configured group cannot inspect another grant");
        const unrelatedState = await pool.query("SELECT status,(SELECT count(*)::int FROM versekit_consent_challenges WHERE grant_id=$1) AS challenges FROM versekit_device_grants WHERE id=$1", [unrelated.id]);
        assert.equal(unrelatedState.rows[0].status, "pending");
        assert.equal(unrelatedState.rows[0].challenges, 0, "unrelated member cannot create or alter a consent challenge");
      } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    const groupOnlyGrant = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    const sessionHashFixture = createTokenCodec(testPepper).hash("browser_session", "s".repeat(32));
    assert.equal(await store.createConsentChallenge({ userCode: groupOnlyGrant.userCode, userId: otherOnlyId, sessionHash: sessionHashFixture }), null,
      "membership in only another group cannot inspect or approve a configured-group grant");
    const unreadyStore = new VersekitTokenStore({ db: pool, codec: createTokenCodec(testPepper), groupId: realGroup });
    await assert.rejects(unreadyStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] }), /operational scope/);
    const pending = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    assert.equal((await store.findGrantByUserCode(pending.userCode)).group_id, realGroup);
    assert.equal((await store.exchangeDeviceCode({ deviceCode: pending.deviceCode, clientId: "versekit" })).error, "authorization_pending");
    assert.equal((await store.exchangeDeviceCode({ deviceCode: pending.deviceCode, clientId: "versekit" })).error, "slow_down");
    const cleanupKeep = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    const cleanupDrop = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '32 days',expires_at=now()-interval '31 days' WHERE id=$1", [cleanupDrop.id]);
    const cleanupOne = await store.cleanupCredentials({ batchSize: 1 });
    assert.ok(cleanupOne.grants <= 1, "cleanup respects the per-category batch bound");
    const cleanupTwo = await store.cleanupCredentials({ batchSize: 1 });
    assert.ok(cleanupTwo.grants <= 1);
    assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [cleanupKeep.id])).rowCount, 1, "active pending grants are preserved");
    assert.equal((await pool.query("SELECT 1 FROM versekit_device_grants WHERE id=$1", [cleanupDrop.id])).rowCount, 0, "old expired pending grants are removed");
    await Promise.all([store.cleanupCredentials({ batchSize: 1 }), store.cleanupCredentials({ batchSize: 1 })]);
    await assert.rejects(store.cleanupCredentials({ batchSize: 1001 }), /batch size/);
    assert.equal(await store.consent({ grantId: pending.id, userId, scopes: ["orders:read"], approve: true }), true);
    await pool.query("UPDATE versekit_device_grants SET last_poll_at=now()-interval '10 seconds' WHERE id=$1", [pending.id]);
    const exchanged = await store.exchangeDeviceCode({ deviceCode: pending.deviceCode, clientId: "versekit" });
    assert.ok(exchanged.tokens.access_token.startsWith("vka_"));
    assert.ok(exchanged.tokens.refresh_token.startsWith("vkr_"));
    const storedHashes = await pool.query("SELECT token_hash FROM versekit_tokens");
    assert.equal(storedHashes.rows.some((row) => row.token_hash === exchanged.tokens.access_token || row.token_hash === exchanged.tokens.refresh_token), false);
    assert.equal((await store.authenticateAccess(exchanged.tokens.access_token)).app_user_id, userId);
    assert.equal((await store.authorizeAccess(exchanged.tokens.access_token, { operation: "orders:read" })).allowed, true,
      "central guard permits an explicitly granted, enabled test capability");
    const scopedStore = new VersekitTokenStore({ db: pool, codec: createTokenCodec(testPepper), groupId: realGroup,
      operationalScopes: ["orders:read", "orders:write"] });
    assert.deepEqual(await scopedStore.authorizeAccess(exchanged.tokens.access_token, { operation: "orders:write" }),
      { allowed: false, reason: "scope_missing" }, "valid token without the operation scope is denied");
    assert.deepEqual(await scopedStore.authorizeAccess(exchanged.tokens.access_token, { operation: "stock:read" }),
      { allowed: false, reason: "unsupported_operation" }, "unimplemented capabilities are not accepted");
    assert.equal((await scopedStore.authorizeAccess("invalid", { operation: "me" })).reason, "invalid_token");
    const scopeFailure = response();
    sendAuthorizationFailure(scopeFailure, { reason: "scope_missing" });
    assert.equal(scopeFailure.status, 403);
    assert.equal(scopeFailure.headers["content-type"], "application/problem+json; charset=utf-8");
    assert.equal(scopeFailure.headers["www-authenticate"], 'Bearer error="insufficient_scope"');
    assert.deepEqual(JSON.parse(scopeFailure.body), { type: "about:blank", status: 403, code: "SCOPE_MISSING" });
    const rotated = await store.refresh({ refreshToken: exchanged.tokens.refresh_token, clientId: "versekit" });
    assert.ok(rotated.tokens);
    assert.equal((await store.refresh({ refreshToken: exchanged.tokens.refresh_token, clientId: "versekit" })).error, "invalid_grant");
    assert.equal(await store.authenticateAccess(rotated.tokens.access_token), null, "refresh replay revokes the entire family");

    const secondGrant = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    await store.consent({ grantId: secondGrant.id, userId, scopes: ["orders:read"], approve: true });
    const secondTokens = (await store.exchangeDeviceCode({ deviceCode: secondGrant.deviceCode, clientId: "versekit" })).tokens;
    const changedStore = new VersekitTokenStore({ db: pool, codec: createTokenCodec(testPepper), groupId: anotherGroup, operationalScopes: ["orders:read"] });
    assert.equal(await changedStore.authenticateAccess(secondTokens.access_token), null, "old configured group cannot authorize after group change");
    await store.revoke(secondTokens.refresh_token);
    assert.equal(await store.authenticateAccess(secondTokens.access_token), null);
    assert.equal(await store.revoke("unknown-token"), undefined);
    const expiredGrant = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"], expiresIn: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal((await store.exchangeDeviceCode({ deviceCode: expiredGrant.deviceCode, clientId: "versekit" })).error, "expired_token");

    let adapterUrl = "";
    const memberSession = await createSession(pool, pepper, userId);
    const sessionToken = (req) => /(?:^|;\s*)bp_session=([^;]+)/.exec(req.headers.cookie || "")?.[1] || null;
    const sessionContext = async (req) => {
      const token = sessionToken(req); if (!token) return null;
      const sessionHash = createHmac("sha256", pepper).update(`session:${token}`).digest("hex");
      const found = await pool.query("SELECT ds.app_user_id FROM dashboard_sessions ds JOIN app_users u ON u.id=ds.app_user_id WHERE ds.session_hash=$1 AND ds.expires_at>now() AND u.account_status='active'", [sessionHash]);
      return found.rowCount ? { appUserId: found.rows[0].app_user_id } : null;
    };
    const adapter = await createVersekitAdapter({
      env: actual, db: pool, tokenPepper: testPepper, quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"],
      deviceCodeLimiter: createRequestRateLimiter({ limit: 12, windowMs: 60_000 }),
      revokeLimiter: createRequestRateLimiter({ limit: 6, windowMs: 60_000 }),
      meLimiter: createRequestRateLimiter({ limit: 30, windowMs: 60_000 }),
      getSessionContext: sessionContext,
      getSessionToken: sessionToken,
      getCurrentAppUser: async (req) => {
        const identity = await sessionContext(req); if (!identity) return null;
        const found = await pool.query("SELECT id,COALESCE(verselink_name,display_name) display_name,account_status FROM app_users WHERE id=$1", [identity.appUserId]);
        return found.rows[0] || null;
      },
      sameOrigin: (req) => req.headers.origin === adapterUrl
    });
    const adapterServer = createServer((req, res) => adapter(req, res, new URL(req.url, "http://127.0.0.1")));
    await new Promise((resolve, reject) => { adapterServer.once("error", reject); adapterServer.listen(0, "127.0.0.1", resolve); });
    adapterUrl = "http://127.0.0.1:" + adapterServer.address().port;
    const postForm = async (path, value, contentType = "application/x-www-form-urlencoded") => {
      const response = await fetch(adapterUrl + path, { method: "POST", headers: { "content-type": contentType }, body: value, signal: AbortSignal.timeout(5_000) });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
    };
    const tokenPath = "/versekit/v1/token";
    const tokenForm = (code, client = "versekit") => "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=" + encodeURIComponent(code) + "&client_id=" + client;
    const refreshForm = (token, client = "versekit") => "grant_type=refresh_token&refresh_token=" + encodeURIComponent(token) + "&client_id=" + client;
    const meRequest = (token, cookie) => fetch(adapterUrl + "/versekit/v1/me", {
      headers: { ...(cookie ? { cookie } : {}), ...(token ? { authorization: token } : {}) }, signal: AbortSignal.timeout(5_000)
    });
    const revokeForm = (token, client) => "token=" + encodeURIComponent(token) + (client === undefined ? "" : "&client_id=" + encodeURIComponent(client));
    try {
      const browserHeaders = { cookie: `bp_session=${memberSession}` };
      const browserPage = await fetch(adapterUrl + "/device", { headers: browserHeaders, signal: AbortSignal.timeout(5_000) });
      const browserHtml = await browserPage.text();
      assert.equal(browserPage.status, 200);
      assert.match(browserHtml, /VK02 Test Org/);
      assert.match(browserHtml, /VK03 Test Member/);
      assert.match(browserHtml, /href="\/device-consent\.css"/);
      assert.match(browserHtml, /AUTHORIZATION PROVIDER/);
      assert.match(browserHtml, /REQUESTING APPLICATION/);
      assert.match(browserHtml, /name="user_code"/);
      assert.doesNotMatch(browserHtml, /checked/);
      assert.equal(browserPage.headers.get("cache-control"), "no-store");
      assert.equal(browserPage.headers.get("referrer-policy"), "same-origin",
        "native consent form submissions retain a same-origin referrer policy compatible with Origin validation");
      assert.equal(browserPage.headers.get("x-frame-options"), "DENY");
      assert.equal(browserPage.headers.get("x-content-type-options"), "nosniff");
      assert.equal(browserPage.headers.get("content-security-policy"), "default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      assert.equal(browserPage.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"), true);
      const nonmemberSession = await createSession(pool, pepper, otherOnlyId);
      const nonmemberPage = await fetch(adapterUrl + "/device", { headers: { cookie: `bp_session=${nonmemberSession}` }, signal: AbortSignal.timeout(5_000) });
      const nonmemberHtml = await nonmemberPage.text();
      assert.equal(nonmemberPage.status, 200);
      assert.match(nonmemberHtml, /href="\/login"/);
      assert.match(nonmemberHtml, /VK02 Test Org/);
      assert.doesNotMatch(nonmemberHtml, /Other Group Member|Other Private Org|name="user_code"/);
      const csrfLookup = /name="csrf" value="([^"]+)"/.exec(browserHtml)?.[1];
      assert.ok(csrfLookup);
      assert.deepEqual((await postForm("/versekit/v1/device/code", "scope=orders%3Aread")).body, { error: "invalid_request" });
      assert.deepEqual((await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread", "text/plain")).body, { error: "invalid_request" });
      assert.deepEqual((await postForm("/versekit/v1/device/code", "client_id=versekit&scope=unknown%3Aread")).body, { error: "invalid_scope" });
      assert.deepEqual((await postForm("/versekit/v1/device/code", "client_id=versekit&scope=stock%3Aread")).body, { error: "invalid_scope" });
      assert.deepEqual((await postForm("/versekit/v1/device/code", "x".repeat(9_000))).body, { error: "invalid_request" });
      const created = await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread+orders%3Aread+unknown%3Aread");
      assert.equal(created.status, 200);
      assert.equal(created.headers.get("cache-control"), "no-store");
      assert.match(created.body.device_code, /^vkd_/);
      assert.match(created.body.user_code, /^[BCDFGHJKLMNPQRSTVWXYZ]{5}-[BCDFGHJKLMNPQRSTVWXYZ]{5}$/);
      assert.equal(created.body.verification_uri, "https://example.org/device");
      assert.ok(!created.body.verification_uri.includes(created.body.user_code));
      assert.equal(created.body.expires_in, 600);
      assert.equal(created.body.interval, 5);

      const codec = createTokenCodec(testPepper);
      const httpStore = new VersekitTokenStore({ db: pool, codec, groupId: realGroup, operationalScopes: ["orders:read"] });
      const record = await httpStore.findGrantByUserCode(created.body.user_code);
      assert.ok(record);
      const storedGrant = await pool.query("SELECT device_code_hash,user_code_hash FROM versekit_device_grants WHERE id=$1", [record.id]);
      assert.equal(storedGrant.rows[0].device_code_hash, codec.hash("device_code", created.body.device_code));
      assert.equal(storedGrant.rows[0].user_code_hash, codec.hash("user_code", created.body.user_code));

      const submitBrowser = (fields, origin = adapterUrl) => fetch(adapterUrl + "/device", {
        method: "POST", headers: { ...browserHeaders, ...(origin === null ? {} : { origin }), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields), signal: AbortSignal.timeout(5_000)
      });
      assert.equal((await submitBrowser({ action: "lookup", csrf: csrfLookup, user_code: "ABCDF-GHJKM" }, null)).status, 403,
        "a missing Origin remains rejected even with a valid CSRF token");
      assert.equal((await submitBrowser({ action: "lookup", user_code: "ABCDF-GHJKM" })).status, 403, "missing CSRF is rejected");
      assert.equal((await submitBrowser({ action: "lookup", csrf: "invalid", user_code: "ABCDF-GHJKM" })).status, 403, "invalid CSRF is rejected");
      const csrfParts = csrfLookup.split(".");
      const csrfClaims = JSON.parse(Buffer.from(csrfParts[0], "base64url").toString("utf8"));
      const expiredCsrfPayload = Buffer.from(JSON.stringify({ ...csrfClaims, exp: Date.now() - 1 })).toString("base64url");
      const expiredCsrf = `${expiredCsrfPayload}.${codec.hash("csrf", expiredCsrfPayload)}`;
      assert.equal((await submitBrowser({ action: "lookup", csrf: expiredCsrf, user_code: "ABCDF-GHJKM" })).status, 403, "expired CSRF is rejected");
      const tamperedCsrf = `${csrfLookup.slice(0, -1)}${csrfLookup.endsWith("A") ? "B" : "A"}`;
      assert.equal((await submitBrowser({ action: "lookup", csrf: tamperedCsrf, user_code: "ABCDF-GHJKM" })).status, 403, "tampered CSRF is rejected");
      const invalidCodeResponse = await submitBrowser({ action: "lookup", csrf: csrfLookup, user_code: "not-a-code" });
      assert.equal(invalidCodeResponse.status, 400);
      assert.match(await invalidCodeResponse.text(), /code is invalid or no longer available/);
      const expiredBrowserGrant = await httpStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      await pool.query("UPDATE versekit_device_grants SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 second' WHERE id=$1", [expiredBrowserGrant.id]);
      const expiredCodeResponse = await submitBrowser({ action: "lookup", csrf: csrfLookup, user_code: expiredBrowserGrant.userCode });
      assert.equal(expiredCodeResponse.status, 400);
      assert.match(await expiredCodeResponse.text(), /code is invalid or no longer available/);
      const browserGrant = (await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread")).body;
      assert.equal((await submitBrowser({ action: "lookup", csrf: csrfLookup, user_code: browserGrant.user_code }, "null")).status, 403,
        "a null Origin remains rejected even with a valid CSRF token");
      assert.equal((await submitBrowser({ action: "lookup", csrf: csrfLookup, user_code: browserGrant.user_code }, "http://attacker.invalid")).status, 403,
        "a cross-origin POST remains rejected even with a valid CSRF token");
      let lookupResponse = await submitBrowser({ action: "lookup", csrf: csrfLookup, user_code: browserGrant.user_code });
      assert.equal(lookupResponse.status, 200);
      let reviewHtml = await lookupResponse.text();
      assert.match(reviewHtml, /Requesting application: <strong>VerseKit/);
      assert.match(reviewHtml, /orders:read/);
      assert.match(reviewHtml, /<fieldset class="permission-fieldset">/);
      assert.match(reviewHtml, /<form method="post" action="\/device" class="deny-form">/);
      assert.doesNotMatch(reviewHtml, /checked/);
      const challenge = /name="challenge" value="([^"]+)"/.exec(reviewHtml)?.[1];
      const reviewCsrf = /name="csrf" value="([^"]+)"/.exec(reviewHtml)?.[1];
      assert.ok(challenge && reviewCsrf);
      const scopeEscalation = await submitBrowser({ action: "approve", challenge, csrf: reviewCsrf, scope: "stock:read" });
      assert.equal(scopeEscalation.status, 400, "unrequested and unsupported permissions cannot be approved");
      lookupResponse = await submitBrowser({ action: "approve", challenge, csrf: reviewCsrf, scope: "orders:read" });
      assert.equal(lookupResponse.status, 200);
      assert.match(await lookupResponse.text(), /Return to the VerseKit desktop client/);
      await pool.query("UPDATE versekit_device_grants SET last_poll_at=now()-interval '10 seconds' WHERE user_code_hash=$1", [codec.hash("user_code", browserGrant.user_code)]);
      const browserToken = await postForm("/versekit/v1/token", tokenForm(browserGrant.device_code));
      assert.equal(browserToken.status, 200);
      assert.equal(browserToken.body.scope, "orders:read");
      const unauthMe = await meRequest(null, `bp_session=${memberSession}`);
      assert.equal(unauthMe.status, 401, "VerseLink cookies cannot authenticate the protected API");
      assert.equal(unauthMe.headers.get("content-type"), "application/problem+json; charset=utf-8");
      assert.equal(unauthMe.headers.get("www-authenticate"), 'Bearer error="invalid_token"');
      assert.deepEqual(await unauthMe.json(), { type: "about:blank", status: 401, code: "UNAUTHORIZED" });
      assert.equal((await meRequest("Bearer malformed")).status, 401);
      assert.equal((await meRequest("Bearer vka_" + "A".repeat(43))).status, 401);
      const meResponse = await meRequest(`Bearer ${browserToken.body.access_token}`);
      assert.equal(meResponse.status, 200);
      assert.equal(meResponse.headers.get("cache-control"), "no-store");
      assert.deepEqual(await meResponse.json(), { member: { id: userId, name: "VK03 Test Member" }, org: { name: "VK02 Test Org" }, scopes: ["orders:read"] });
      const rotatedHttp = await postForm(tokenPath, refreshForm(browserToken.body.refresh_token));
      assert.equal(rotatedHttp.status, 200);
      assert.notEqual(rotatedHttp.body.access_token, browserToken.body.access_token);
      assert.notEqual(rotatedHttp.body.refresh_token, browserToken.body.refresh_token);
      assert.equal(rotatedHttp.body.scope, browserToken.body.scope);
      assert.equal((await meRequest(`Bearer ${rotatedHttp.body.access_token}`)).status, 200);
      assert.deepEqual((await postForm(tokenPath, refreshForm(browserToken.body.refresh_token))).body, { error: "invalid_grant" });
      assert.equal((await meRequest(`Bearer ${rotatedHttp.body.access_token}`)).status, 401, "refresh replay revokes that token family");

      const deniedBrowserGrant = (await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread")).body;
      assert.match(deniedBrowserGrant.user_code || "", /^[BCDFGHJKLMNPQRSTVWXYZ]{5}-[BCDFGHJKLMNPQRSTVWXYZ]{5}$/);
      const deniedLookup = await submitBrowser({ action: "lookup", csrf: csrfLookup, user_code: deniedBrowserGrant.user_code });
      const deniedReview = await deniedLookup.text();
      assert.equal(deniedLookup.status, 200, deniedReview);
      assert.match(deniedReview, /Review VerseKit access/);
      const deniedChallenge = /name="challenge" value="([^"]+)"/.exec(deniedReview)?.[1];
      const deniedCsrf = /name="csrf" value="([^"]+)"/.exec(deniedReview)?.[1];
      assert.ok(deniedChallenge && deniedCsrf, deniedReview);
      const deniedResponse = await submitBrowser({ action: "deny", challenge: deniedChallenge, csrf: deniedCsrf });
      const deniedHtml = await deniedResponse.text();
      assert.equal(deniedResponse.status, 200);
      assert.match(deniedHtml, /No tokens were issued/);
      assert.match(deniedHtml, /class="state-card state-result state-denied"/);
      assert.deepEqual((await postForm(tokenPath, tokenForm(deniedBrowserGrant.device_code))).body, { error: "access_denied" });

      assert.deepEqual((await postForm(tokenPath, "grant_type=refresh_token&client_id=versekit")).body, { error: "invalid_request" });
      assert.deepEqual((await postForm(tokenPath, "grant_type=authorization_code&client_id=versekit")).body, { error: "unsupported_grant_type" });
      assert.deepEqual((await postForm(tokenPath, tokenForm(created.body.device_code, "other-client"))).body, { error: "invalid_request" });
      assert.deepEqual((await postForm(tokenPath, tokenForm("unknown-device-code"))).body, { error: "invalid_grant" });
      assert.deepEqual((await postForm(tokenPath, tokenForm(created.body.device_code))).body, { error: "authorization_pending" });
      assert.deepEqual((await postForm(tokenPath, tokenForm(created.body.device_code))).body, { error: "slow_down" });
      assert.equal(await httpStore.consent({ grantId: record.id, userId, scopes: ["orders:read"], approve: true }), true);
      await pool.query("UPDATE versekit_device_grants SET last_poll_at=now()-interval '10 seconds' WHERE id=$1", [record.id]);
      const approved = await postForm(tokenPath, tokenForm(created.body.device_code));
      assert.equal(approved.status, 200);
      assert.equal(approved.headers.get("cache-control"), "no-store");
      assert.equal(approved.body.token_type, "Bearer");
      assert.equal(approved.body.scope, "orders:read");
      assert.equal((await meRequest(`Bearer ${approved.body.access_token}`)).status, 200);
      const revokeApproved = await postForm("/versekit/v1/revoke", revokeForm(approved.body.refresh_token, "versekit"));
      assert.equal(revokeApproved.status, 200);
      assert.equal(revokeApproved.headers.get("cache-control"), "no-store");
      assert.equal((await meRequest(`Bearer ${approved.body.access_token}`)).status, 401);
      assert.deepEqual((await postForm(tokenPath, refreshForm(approved.body.refresh_token))).body, { error: "invalid_grant" });
      assert.equal((await postForm("/versekit/v1/revoke", revokeForm(approved.body.refresh_token))).status, 200, "repeated revocation is safe");
      assert.equal((await postForm("/versekit/v1/revoke", revokeForm("unknown-token"))).status, 200, "unknown credentials are indistinguishable");
      assert.equal((await postForm("/versekit/v1/revoke", revokeForm("unknown-token"))).status, 200);
      assert.deepEqual((await postForm("/versekit/v1/revoke", revokeForm("unknown-token", "not-versekit"))).body, { error: "invalid_request" });
      const independentGrantA = await httpStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      const independentGrantB = await httpStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      await httpStore.consent({ grantId: independentGrantA.id, userId, scopes: ["orders:read"], approve: true });
      await httpStore.consent({ grantId: independentGrantB.id, userId, scopes: ["orders:read"], approve: true });
      const independentA = (await httpStore.exchangeDeviceCode({ deviceCode: independentGrantA.deviceCode, clientId: "versekit" })).tokens;
      const independentB = (await httpStore.exchangeDeviceCode({ deviceCode: independentGrantB.deviceCode, clientId: "versekit" })).tokens;
      assert.equal((await meRequest(`Bearer ${independentA.access_token}`)).status, 200);
      assert.equal((await meRequest(`Bearer ${independentB.access_token}`)).status, 200);
      assert.equal((await postForm("/versekit/v1/revoke", revokeForm(independentA.access_token))).status, 200);
      assert.equal((await meRequest(`Bearer ${independentA.access_token}`)).status, 401, "access-token revocation invalidates its family");
      assert.deepEqual((await postForm(tokenPath, refreshForm(independentA.refresh_token))).body, { error: "invalid_grant" });
      assert.equal((await meRequest(`Bearer ${independentB.access_token}`)).status, 200, "revoking one device does not affect an independent grant");
      await pool.query("DELETE FROM group_members WHERE group_id=$1 AND app_user_id=$2", [realGroup, userId]);
      assert.equal((await meRequest(`Bearer ${independentB.access_token}`)).status, 401, "membership removal is checked on each protected request");
      assert.deepEqual((await postForm(tokenPath, refreshForm(independentB.refresh_token))).body, { error: "invalid_grant" });
      await pool.query("INSERT INTO group_members (group_id,app_user_id,role) VALUES ($1,$2,'member')", [realGroup, userId]);
      assert.equal((await meRequest(`Bearer ${independentB.access_token}`)).status, 401, "membership loss permanently invalidates attempted refresh");
      const expiringGrant = await httpStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      await httpStore.consent({ grantId: expiringGrant.id, userId, scopes: ["orders:read"], approve: true });
      const expiringPair = (await httpStore.exchangeDeviceCode({ deviceCode: expiringGrant.deviceCode, clientId: "versekit" })).tokens;
      await pool.query("UPDATE versekit_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [codec.hash("refresh", expiringPair.refresh_token)]);
      assert.deepEqual((await postForm(tokenPath, refreshForm(expiringPair.refresh_token))).body, { error: "invalid_grant" }, "expired refresh credentials are rejected");
      await pool.query("UPDATE versekit_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [codec.hash("access", expiringPair.access_token)]);
      assert.equal((await meRequest(`Bearer ${expiringPair.access_token}`)).status, 401, "expired access credentials are rejected");
      const blockedGrant = await httpStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      await httpStore.consent({ grantId: blockedGrant.id, userId, scopes: ["orders:read"], approve: true });
      const blockedPair = (await httpStore.exchangeDeviceCode({ deviceCode: blockedGrant.deviceCode, clientId: "versekit" })).tokens;
      await pool.query("UPDATE group_members SET role='owner' WHERE group_id=$1 AND app_user_id=$2", [realGroup, userId]);
      assert.equal((await httpStore.authorizeAccess(blockedPair.access_token, { operation: "orders:read" })).allowed, true,
        "changing a current member's owner role does not expand or remove its granted authorization");
      await pool.query("UPDATE app_users SET account_status='blocked' WHERE id=$1", [userId]);
      assert.equal((await meRequest(`Bearer ${blockedPair.access_token}`)).status, 401, "blocked owners cannot use existing access tokens or bypass active-account checks");
      assert.deepEqual((await postForm(tokenPath, refreshForm(blockedPair.refresh_token))).body, { error: "invalid_grant" });
      await pool.query("UPDATE app_users SET account_status='active' WHERE id=$1", [userId]);
      assert.equal((await meRequest(`Bearer ${blockedPair.access_token}`)).status, 401, "refresh attempted while blocked revokes the family");
      await pool.query("UPDATE group_members SET role='member' WHERE group_id=$1 AND app_user_id=$2", [realGroup, userId]);
      const temporaryGroup = randomUUID();
      await pool.query("INSERT INTO blueprint_groups (id,name) VALUES ($1,'Temporary VerseKit Org')", [temporaryGroup]);
      await pool.query("INSERT INTO group_members (group_id,app_user_id,role) VALUES ($1,$2,'member')", [temporaryGroup, userId]);
      await createVersekitAdapter({ env: { ...actual, VERSEKIT_GROUP_ID: temporaryGroup }, db: pool, tokenPepper: testPepper,
        quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"] });
      const temporaryStore = new VersekitTokenStore({ db: pool, codec, groupId: temporaryGroup, operationalScopes: ["orders:read"] });
      const temporaryGrant = await temporaryStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      await temporaryStore.consent({ grantId: temporaryGrant.id, userId, scopes: ["orders:read"], approve: true });
      const temporaryPair = (await temporaryStore.exchangeDeviceCode({ deviceCode: temporaryGrant.deviceCode, clientId: "versekit" })).tokens;
      await pool.query("DELETE FROM blueprint_groups WHERE id=$1", [temporaryGroup]);
      assert.equal(await temporaryStore.authenticateAccess(temporaryPair.access_token), null, "deleted group immediately invalidates access");
      assert.deepEqual(await temporaryStore.refresh({ refreshToken: temporaryPair.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });
      assert.deepEqual((await postForm(tokenPath, tokenForm(created.body.device_code))).body, { error: "invalid_grant" });
      await createVersekitAdapter({ env: actual, db: pool, tokenPepper: testPepper, quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"] });

      const deniedCode = (await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread")).body;
      const deniedRecord = await httpStore.findGrantByUserCode(deniedCode.user_code);
      assert.equal(await httpStore.consent({ grantId: deniedRecord.id, userId, scopes: [], approve: false }), true);
      assert.deepEqual((await postForm(tokenPath, tokenForm(deniedCode.device_code))).body, { error: "access_denied" });

      const concurrentCode = (await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread")).body;
      const concurrentRecord = await httpStore.findGrantByUserCode(concurrentCode.user_code);
      await httpStore.consent({ grantId: concurrentRecord.id, userId, scopes: ["orders:read"], approve: true });
      await pool.query("UPDATE versekit_device_grants SET last_poll_at=now()-interval '10 seconds' WHERE id=$1", [concurrentRecord.id]);
      const simultaneous = await Promise.all([postForm(tokenPath, tokenForm(concurrentCode.device_code)), postForm(tokenPath, tokenForm(concurrentCode.device_code))]);
      assert.equal(simultaneous.filter((item) => item.status === 200).length, 1);
      assert.equal(simultaneous.filter((item) => item.body.error === "invalid_grant").length, 1);
      const issuedConcurrent = simultaneous.find((item) => item.status === 200).body;
      const refreshRace = await Promise.all([postForm(tokenPath, refreshForm(issuedConcurrent.refresh_token)), postForm(tokenPath, refreshForm(issuedConcurrent.refresh_token))]);
      assert.equal(refreshRace.filter((item) => item.status === 200).length, 1, "only one concurrent refresh may rotate the credential");
      assert.equal(refreshRace.filter((item) => item.body.error === "invalid_grant").length, 1);
      const racedAccess = refreshRace.find((item) => item.status === 200).body.access_token;
      assert.equal((await meRequest(`Bearer ${racedAccess}`)).status, 401, "concurrent replay revokes all credentials in the family");
      const httpExpired = await httpStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"], expiresIn: 1 });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      assert.deepEqual((await postForm(tokenPath, tokenForm(httpExpired.deviceCode))).body, { error: "expired_token" });
      assert.equal((await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread")).status, 200);
      assert.equal((await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread")).status, 200);
      const limited = await postForm("/versekit/v1/device/code", "client_id=versekit&scope=orders%3Aread");
      assert.equal(limited.status, 429);
      assert.deepEqual(limited.body, { error: "temporarily_unavailable" });
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
      const revokeLimited = await postForm("/versekit/v1/revoke", revokeForm("unknown-token"));
      assert.equal(revokeLimited.status, 429);
      assert.ok(Number(revokeLimited.headers.get("retry-after")) >= 1);
      let meLimited;
      for (let i = 0; i < 40; i++) { meLimited = await meRequest(null); if (meLimited.status === 429) break; }
      assert.equal(meLimited.status, 429);
      assert.equal(meLimited.headers.get("content-type"), "application/problem+json; charset=utf-8");
      assert.deepEqual(await meLimited.json(), { type: "about:blank", status: 429, code: "RATE_LIMITED" });
      assert.ok(Number(meLimited.headers.get("retry-after")) >= 1);

      await t.test("disabled configuration changes are unobserved until an enabled group activation", async () => {
        const pair = await issueApprovedPair();
        const pending = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
        const markerBefore = (await pool.query("SELECT group_id,updated_at FROM versekit_authorization_config WHERE id=true")).rows[0];
        const credentialBefore = (await pool.query(
          "SELECT t.revoked_at,f.revoked_at AS family_revoked,d.status FROM versekit_tokens t JOIN versekit_token_families f ON f.id=t.family_id JOIN versekit_device_grants d ON d.id=f.grant_id WHERE t.token_hash=$1 AND t.token_type='access'",
          [codec.hash("access", pair.tokens.access_token)]
        )).rows[0];
        const disabledDb = { query() { throw new Error("disabled adapter queried PostgreSQL"); }, connect() { throw new Error("disabled adapter connected to PostgreSQL"); } };
        assert.equal(await createVersekitAdapter({ env: { ...actual, VERSEKIT_ENABLED: "false", VERSEKIT_GROUP_ID: anotherGroup }, db: disabledDb }), null,
          "disabled adapter with another configured group does not initialize VerseKit");
        assert.equal(await createVersekitAdapter({ env: { ...actual, VERSEKIT_ENABLED: "false", VERSEKIT_GROUP_ID: realGroup }, db: disabledDb }), null,
          "disabled adapter returning to Group A still performs no initialization");
        const markerAfterDisabled = (await pool.query("SELECT group_id,updated_at FROM versekit_authorization_config WHERE id=true")).rows[0];
        const credentialAfterDisabled = (await pool.query(
          "SELECT t.revoked_at,f.revoked_at AS family_revoked,d.status FROM versekit_tokens t JOIN versekit_token_families f ON f.id=t.family_id JOIN versekit_device_grants d ON d.id=f.grant_id WHERE t.token_hash=$1 AND t.token_type='access'",
          [codec.hash("access", pair.tokens.access_token)]
        )).rows[0];
        assert.deepEqual(markerAfterDisabled, markerBefore, "unobserved disabled settings do not change the persistent marker");
        assert.deepEqual(credentialAfterDisabled, credentialBefore, "unobserved disabled settings do not mutate credentials");

        await createVersekitAdapter({ env: actual, db: pool, tokenPepper: testPepper, quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"] });
        assert.deepEqual((await pool.query("SELECT group_id,updated_at FROM versekit_authorization_config WHERE id=true")).rows[0], markerBefore,
          "same-group reactivation preserves the marker generation");
        assert.equal((await store.authorizeAccess(pair.tokens.access_token, { operation: "orders:read" })).allowed, true,
          "valid Group A credentials survive a disabled pause and same-group reactivation");

        await createVersekitAdapter({ env: { ...actual, VERSEKIT_GROUP_ID: anotherGroup }, db: pool, tokenPepper: testPepper,
          quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"] });
        assert.equal((await pool.query("SELECT status FROM versekit_device_grants WHERE id=$1", [pending.id])).rows[0].status, "denied",
          "an enabled A-to-B transition denies outstanding grants");
        assert.equal((await pool.query("SELECT revoked_at FROM versekit_token_families WHERE grant_id=$1", [pair.grant.id])).rows[0].revoked_at !== null, true,
          "an enabled A-to-B transition revokes the existing family");
        await createVersekitAdapter({ env: actual, db: pool, tokenPepper: testPepper, quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"] });
        assert.equal(await store.authenticateAccess(pair.tokens.access_token), null,
          "returning to A cannot reactivate credentials invalidated by an observed B activation");
      });

      await t.test("authorization locks and caller-owned transactions remain open through a protected operation", async () => {
        const txUserId = randomUUID();
        await pool.query("INSERT INTO app_users(id,email,display_name,account_status) VALUES($1,$2,'Caller Transaction Member','active')",
          [txUserId, `vk04-transaction-${txUserId}@example.test`]);
        await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'member')", [realGroup, txUserId]);
        const txGrant = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
        assert.equal(await store.consent({ grantId: txGrant.id, userId: txUserId, scopes: ["orders:read"], approve: true }), true);
        const pair = (await store.exchangeDeviceCode({ deviceCode: txGrant.deviceCode, clientId: "versekit" })).tokens;
        const authClient = await pool.connect();
        const competingClient = await pool.connect();
        let authInTransaction = false;
        let competingInTransaction = false;
        let releaseCalls = 0;
        try {
          await authClient.query("BEGIN");
          authInTransaction = true;
          const guardStatements = [];
          const callerClient = {
            query(sql, params) { guardStatements.push(String(sql)); return authClient.query(sql, params); },
            release() { releaseCalls++; return authClient.release(); }
          };
          const authorized = await store.authorizeAccess(pair.access_token, { operation: "orders:read", client: callerClient });
          assert.equal(authorized.allowed, true);
          assert.equal(releaseCalls, 0, "guard leaves caller-owned connection unreleased");
          assert.equal(guardStatements.some((sql) => /^\s*(COMMIT|ROLLBACK|BEGIN)\b/i.test(sql)), false,
            "guard does not take ownership of transaction control");
          const protectedProbe = await authClient.query("SELECT count(*)::int AS members FROM group_members WHERE group_id=$1 AND app_user_id=$2",
            [realGroup, txUserId]);
          assert.equal(protectedProbe.rows[0].members, 1, "protected database work executes in the caller transaction after authorization");

          await competingClient.query("BEGIN");
          competingInTransaction = true;
          const backend = await competingClient.query("SELECT pg_backend_pid() AS pid");
          const competingPid = backend.rows[0].pid;
          const removal = competingClient.query("DELETE FROM group_members WHERE group_id=$1 AND app_user_id=$2", [realGroup, txUserId]);
          const deadline = Date.now() + 5_000;
          let waitingOnLock = false;
          while (Date.now() < deadline) {
            const state = await pool.query("SELECT state,wait_event_type FROM pg_stat_activity WHERE pid=$1", [competingPid]);
            if (state.rows[0]?.wait_event_type === "Lock") { waitingOnLock = true; break; }
            await new Promise((resolve) => setImmediate(resolve));
          }
          assert.equal(waitingOnLock, true, "the competing membership removal is observably blocked on a PostgreSQL lock");
          assert.equal(releaseCalls, 0, "the guard did not release the caller connection while the competing transaction waits");

          await authClient.query("COMMIT");
          authInTransaction = false;
          await removal;
          await competingClient.query("COMMIT");
          competingInTransaction = false;
          assert.equal(await store.authenticateAccess(pair.access_token), null,
            "subsequent authorization denies credentials after the competing removal commits");
        } finally {
          if (authInTransaction) await authClient.query("ROLLBACK").catch(() => {});
          if (competingInTransaction) await competingClient.query("ROLLBACK").catch(() => {});
          authClient.release();
          competingClient.release();
          await pool.query("DELETE FROM app_users WHERE id=$1", [txUserId]);
        }
      });

      const historicalA = await issueApprovedPair();
      const pendingA = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      await createVersekitAdapter({ env: { ...actual, VERSEKIT_GROUP_ID: anotherGroup }, db: pool, tokenPepper: testPepper,
        quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"] });
      assert.equal((await pool.query("SELECT status FROM versekit_device_grants WHERE id=$1", [pendingA.id])).rows[0].status, "denied",
        "group reconfiguration invalidates outstanding grants");
      assert.deepEqual(await store.exchangeDeviceCode({ deviceCode: pendingA.deviceCode, clientId: "versekit" }), { error: "invalid_grant" });
      const groupBStore = new VersekitTokenStore({ db: pool, codec, groupId: anotherGroup, operationalScopes: ["orders:read"] });
      const groupBGrant = await groupBStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
      assert.equal(await groupBStore.consent({ grantId: groupBGrant.id, userId, scopes: ["orders:read"], approve: true }), true);
      const historicalB = (await groupBStore.exchangeDeviceCode({ deviceCode: groupBGrant.deviceCode, clientId: "versekit" })).tokens;
      assert.ok(historicalB);
      assert.equal(await store.authenticateAccess(historicalA.tokens.access_token), null, "switching A → B revokes A credentials");
      assert.deepEqual(await store.refresh({ refreshToken: historicalA.tokens.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });
      assert.equal((await groupBStore.authorizeAccess(historicalB.access_token, { operation: "orders:read" })).allowed, true);
      await createVersekitAdapter({ env: actual, db: pool, tokenPepper: testPepper, quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"] });
      assert.equal(await store.authenticateAccess(historicalA.tokens.access_token), null, "switching back to A cannot reactivate its old token");
      assert.equal(await groupBStore.authenticateAccess(historicalB.access_token), null, "switching back to A revokes B credentials too");
      await assert.rejects(groupBStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] }), /configuration is no longer active/,
        "a stale adapter instance cannot issue grants after reconfiguration");

      await t.test("authorization locks serialize concurrent membership removal, revocation, and group deletion", async () => {
        const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
        const pauseAuthorization = async (accessToken, targetStore) => {
          const entered = deferred(), release = deferred();
          const authPool = await createTestPool(databaseUrl);
          let paused = false;
          const coordinatedDb = {
            query: (...args) => authPool.query(...args),
            async connect() {
              const client = await authPool.connect();
              return {
                async query(sql, params) {
                  const result = await client.query(sql, params);
                  if (!paused && typeof sql === "string" && sql.includes("FOR SHARE OF t,f,d,u,g,gm")) {
                    paused = true; entered.resolve(); await release.promise;
                  }
                  return result;
                },
                release: () => client.release()
              };
            }
          };
          const guardedStore = new VersekitTokenStore({ db: coordinatedDb, codec, groupId: targetStore.groupId,
            operationalScopes: targetStore.operationalScopes });
          const result = guardedStore.authorizeAccess(accessToken, { operation: "me" });
          let closed = false;
          const close = async () => {
            if (closed) return;
            closed = true;
            release.resolve();
            await result.catch(() => {});
            await authPool.end();
          };
          try {
            let timeout;
            await Promise.race([entered.promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("authorization did not reach its protected query")), 5000); })]);
            clearTimeout(timeout);
          } catch (error) { await close(); throw error; }
          return { result, release: release.resolve, close };
        };

        const memberRace = await issueApprovedPair();
        let paused = await pauseAuthorization(memberRace.tokens.access_token, store);
        try { await assert.rejects(pool.query("SELECT app_user_id FROM group_members WHERE group_id=$1 AND app_user_id=$2 FOR UPDATE NOWAIT", [realGroup, userId]),
          (error) => error.code === "55P03", "authorization holds the membership row while its decision is in flight"); }
        finally { await paused.close(); }
        assert.equal((await paused.result).allowed, true);
        await pool.query("DELETE FROM group_members WHERE group_id=$1 AND app_user_id=$2", [realGroup, userId]);
        assert.equal(await store.authenticateAccess(memberRace.tokens.access_token), null, "removal committed before the next request is denied");
        await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'member')", [realGroup, userId]);

        const accountRace = await issueApprovedPair();
        paused = await pauseAuthorization(accountRace.tokens.access_token, store);
        try { await assert.rejects(pool.query("SELECT id FROM app_users WHERE id=$1 FOR UPDATE NOWAIT", [userId]),
          (error) => error.code === "55P03", "authorization holds the account row while its decision is in flight"); }
        finally { await paused.close(); }
        assert.equal((await paused.result).allowed, true);
        await pool.query("UPDATE app_users SET account_status='blocked' WHERE id=$1", [userId]);
        assert.equal(await store.authenticateAccess(accountRace.tokens.access_token), null, "account deactivation denies the next request");
        assert.deepEqual(await store.refresh({ refreshToken: accountRace.tokens.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });
        await pool.query("UPDATE app_users SET account_status='active' WHERE id=$1", [userId]);

        const revokeRace = await issueApprovedPair();
        paused = await pauseAuthorization(revokeRace.tokens.access_token, store);
        try { await assert.rejects(pool.query("SELECT id FROM versekit_tokens WHERE token_hash=$1 FOR UPDATE NOWAIT", [codec.hash("access", revokeRace.tokens.access_token)]),
          (error) => error.code === "55P03", "authorization locks the token while its decision is in flight"); }
        finally { await paused.close(); }
        assert.equal((await paused.result).allowed, true);
        await store.revoke(revokeRace.tokens.refresh_token);
        assert.equal(await store.authenticateAccess(revokeRace.tokens.access_token), null, "family revocation denies all later requests");

        const refreshAndRevoke = await issueApprovedPair();
        const independent = await issueApprovedPair();
        const [rotation] = await Promise.all([
          store.refresh({ refreshToken: refreshAndRevoke.tokens.refresh_token, clientId: "versekit" }),
          store.revoke(refreshAndRevoke.tokens.refresh_token)
        ]);
        assert.ok(rotation.tokens || rotation.error === "invalid_grant", "refresh and revocation serialize without duplicate or partially authorized credentials");
        assert.equal(await store.authenticateAccess(refreshAndRevoke.tokens.access_token), null);
        if (rotation.tokens) assert.equal(await store.authenticateAccess(rotation.tokens.access_token), null, "revocation covers a concurrent rotation");
        assert.equal((await store.authorizeAccess(independent.tokens.access_token, { operation: "me" })).allowed, true,
          "revoking a concurrent family leaves an independent family usable");

        const deletingGroup = randomUUID();
        await pool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,'Concurrent Delete Org')", [deletingGroup]);
        await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'member')", [deletingGroup, userId]);
        await createVersekitAdapter({ env: { ...actual, VERSEKIT_GROUP_ID: deletingGroup }, db: pool, tokenPepper: testPepper,
          quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"] });
        const deletingStore = new VersekitTokenStore({ db: pool, codec, groupId: deletingGroup, operationalScopes: ["orders:read"] });
        const deletingGrant = await deletingStore.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
        assert.equal(await deletingStore.consent({ grantId: deletingGrant.id, userId, scopes: ["orders:read"], approve: true }), true);
        const deletingPair = (await deletingStore.exchangeDeviceCode({ deviceCode: deletingGrant.deviceCode, clientId: "versekit" })).tokens;
        paused = await pauseAuthorization(deletingPair.access_token, deletingStore);
        try { await assert.rejects(pool.query("SELECT id FROM blueprint_groups WHERE id=$1 FOR UPDATE NOWAIT", [deletingGroup]),
          (error) => error.code === "55P03", "authorization holds the group row while its decision is in flight"); }
        finally { await paused.close(); }
        assert.equal((await paused.result).allowed, true);
        await pool.query("DELETE FROM blueprint_groups WHERE id=$1", [deletingGroup]);
        assert.equal(await deletingStore.authenticateAccess(deletingPair.access_token), null);
        assert.deepEqual(await deletingStore.refresh({ refreshToken: deletingPair.refresh_token, clientId: "versekit" }), { error: "invalid_grant" });
        await createVersekitAdapter({ env: actual, db: pool, tokenPepper: testPepper, quotaPolicy: testQuotaPolicy, capabilities: ["orders:read"] });
      });
    } finally {
      await new Promise((resolve) => adapterServer.close(resolve));
    }

    runtime = await startMissionTestServer({ databaseUrl: startupDatabaseUrl, pepper, extraEnv: actual });
    const consentCss = await fetch(runtime.baseUrl + "/device-consent.css", { signal: AbortSignal.timeout(5_000) });
    assert.equal(consentCss.status, 200);
    assert.match(consentCss.headers.get("content-type") || "", /^text\/css(?:;|$)/);
    assert.equal(consentCss.headers.get("x-content-type-options"), "nosniff");
    assert.match(await consentCss.text(), /--accent:\s*#21cfff/);
    assert.equal((await fetch(runtime.baseUrl + "/device-consent.css/../server.js", { signal: AbortSignal.timeout(5_000) })).status, 404);
    const readyScope = await fetch(runtime.baseUrl + "/versekit/v1/device/code", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "client_id=versekit&scope=orders%3Aread", signal: AbortSignal.timeout(5_000)
    });
    assert.equal(readyScope.status, 200);
    assert.equal(typeof (await readyScope.json()).device_code, "string");
    const unauthDevicePage = await request("/device");
    assert.equal(unauthDevicePage.status, 200);
    assert.match(unauthDevicePage.body, /href="\/login"/);
    assert.doesNotMatch(unauthDevicePage.body, /user_code|device_code|Other Private Org/);
    const liveDiscovery = await request("/.well-known/versekit-org.json");
    assert.equal(liveDiscovery.status, 200);
    assert.deepEqual(JSON.parse(liveDiscovery.body).versions["1"].scopes_supported, ["orders:read"]);
    assert.ok(!liveDiscovery.body.includes(realGroup) && !liveDiscovery.body.includes(anotherGroup));
    assert.ok(!liveDiscovery.body.includes("Other Private Org"));
    const discoveryMethod = await request("/.well-known/versekit-org.json", "POST");
    assert.equal(discoveryMethod.status, 405);
    assert.deepEqual(JSON.parse(discoveryMethod.body), { type: "about:blank", status: 405, code: "METHOD_NOT_ALLOWED" });
    const ordersUnauthorized = await request("/versekit/v1/orders");
    assert.equal(ordersUnauthorized.status, 401);
    assert.equal(ordersUnauthorized.headers.get("www-authenticate"), 'Bearer error="invalid_token"');
    assert.deepEqual(JSON.parse(ordersUnauthorized.body), { type: "about:blank", status: 401, code: "UNAUTHORIZED" });
    const unknownVersekit = await request("/versekit/v1/unknown", "POST");
    assert.equal(unknownVersekit.status, 404);
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
        await assert.rejects(startMissionTestServer({ databaseUrl: startupDatabaseUrl, pepper, logDirectory: failureLogDir, extraEnv: badEnv }), (error) => {
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
    await assert.rejects(createVersekitAdapter({ env: actual, db: { query: async () => { throw new Error("connection lost"); } }, tokenPepper: testPepper }), /VERSEKIT_GROUP_ID lookup failed/);
  } finally {
    await stopMissionTestServer(runtime);
    await pool?.end();
    if (startupDatabaseCreated) {
      const databaseAdminUrl = new URL(safeUrl); databaseAdminUrl.pathname = "/postgres";
      const databaseAdmin = await createTestPool(databaseAdminUrl.toString());
      try {
        await databaseAdmin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [startupDatabase]);
        await databaseAdmin.query(`DROP DATABASE IF EXISTS "${startupDatabase}"`);
      } finally { await databaseAdmin.end(); }
    }
    if (/^vk02_[a-f0-9]{32}$/.test(schema)) await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
