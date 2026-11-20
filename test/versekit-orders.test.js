import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { assertOrdersReadiness, createOrdersCursorCodec, mapVersekitOrder, normalizeVersekitOrderStatus } from "../src/integrations/versekit/orders.js";
import { createOrdersHandler } from "../src/integrations/versekit/orders.js";
import { createVersekitRouter } from "../src/integrations/versekit/router.js";
import { createTokenCodec } from "../src/integrations/versekit/tokens.js";
import { VersekitTokenStore } from "../src/integrations/versekit/store.js";
import { resolveC6TestDatabaseUrl } from "./helpers/c6-test-database.js";
import { createSession, createTestPool, startMissionTestServer, stopMissionTestServer, VERSEKIT_TEST_TOKEN_PEPPER } from "./helpers/mission-integration.js";

const PEPPER = VERSEKIT_TEST_TOKEN_PEPPER;
const SINK_PEPPER = "short-unchanged-sink-test";
const CURSOR_GROUP = "11111111-1111-4111-8111-111111111111";
const CURSOR_PAYLOAD = Object.freeze({ v: 1, g: CURSOR_GROUP, scope: "orders:read",
  s: { created: "2026-11-19T10:00:00.123456Z", id: "ffffffff-ffff-4fff-8fff-ffffffffffff" },
  l: { created: "2026-11-19T09:00:00.123456Z", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } });

test("VerseKit cursor codec authenticates canonical payloads and is restart stable", () => {
  const first = createOrdersCursorCodec(PEPPER);
  const second = createOrdersCursorCodec(PEPPER);
  const token = first.encode(CURSOR_PAYLOAD, CURSOR_GROUP);
  assert.deepEqual(second.decode(token, CURSOR_GROUP), CURSOR_PAYLOAD);
  const differentKey = createOrdersCursorCodec(`${PEPPER}-different-key`);
  assert.equal(differentKey.decode(token, CURSOR_GROUP), null, "a cursor cannot be reused after signing secret rotation");
  assert.equal(second.decode(token, "22222222-2222-4222-8222-222222222222"), null);
});

test("VerseKit cursor rejects tampering, malformed encodings and invalid ordering", async () => {
  const codec = createOrdersCursorCodec(PEPPER);
  const token = codec.encode(CURSOR_PAYLOAD, CURSOR_GROUP);
  const [payloadPart, macPart] = token.split(".");
  const tamper = (change) => {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    change(payload);
    return `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${macPart}`;
  };
  const candidates = [
    tamper((p) => { p.s.created = "2026-11-20T10:00:00.123456Z"; }),
    tamper((p) => { p.l.created = "2026-11-19T10:00:00.123456Z"; }),
    tamper((p) => { p.l.id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"; }),
    tamper((p) => { p.g = "22222222-2222-4222-8222-222222222222"; }),
    tamper((p) => { p.scope = "stock:read"; }),
    tamper((p) => { p.v = 2; }),
    `${payloadPart}.${Buffer.from("different-mac").toString("base64url")}`,
    `${payloadPart.slice(0, -2)}.${macPart}`,
    `${payloadPart}.${macPart.slice(0, -4)}`,
    "%%%!.bad", "eyJhIjoxfQ==.abc", `${payloadPart}`
  ];
  for (const candidate of candidates) assert.equal(codec.decode(candidate, CURSOR_GROUP), null, candidate);

  const context = "verselink:versekit:orders:cursor:v1";
  const key = createHmac("sha256", PEPPER).update(`${context}:key`).digest();
  const forgedInvalidOrder = { ...CURSOR_PAYLOAD,
    l: { created: "2026-11-20T10:00:00.123456Z", id: CURSOR_PAYLOAD.s.id } };
  const encoded = Buffer.from(JSON.stringify(forgedInvalidOrder)).toString("base64url");
  const mac = createHmac("sha256", key).update(`${context}\0`).update(encoded).digest("base64url");
  assert.equal(codec.decode(`${encoded}.${mac}`, CURSOR_GROUP), null, "valid MAC cannot make a semantically invalid cursor valid");

  const callOrders = async (candidate, activeCodec = codec) => {
    const handler = createOrdersHandler({ db: { connect: () => { throw new Error("database must not be reached"); } },
      groupId: CURSOR_GROUP, tokenStore: {}, limiter: { consume: () => ({ allowed: true }) }, cursorCodec: activeCodec });
    const router = createVersekitRouter({ orders: handler });
    const req = new EventEmitter(); req.method = "GET"; req.pause = () => {}; req.headers = {}; req.socket = undefined;
    const res = new EventEmitter(); res.setHeader = () => {}; res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; };
    res.end = (body) => { res.body = body; res.writableEnded = true; res.emit("finish"); };
    const handled = await router(req, res, new URL(`http://localhost/versekit/v1/orders?cursor=${encodeURIComponent(candidate)}`));
    return { handled, res };
  };
  for (const candidate of candidates) {
    const { res } = await callOrders(candidate);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, "INVALID_CURSOR");
  }
  const differentKey = createOrdersCursorCodec(`${PEPPER}-rotated`);
  const validUnderOldKey = codec.encode(CURSOR_PAYLOAD, CURSOR_GROUP);
  const wrongKeyResponse = await callOrders(validUnderOldKey, differentKey);
  assert.equal(wrongKeyResponse.res.statusCode, 400);
  assert.equal(JSON.parse(wrongKeyResponse.res.body).code, "INVALID_CURSOR");

  const invalidCursorResponse = await callOrders(`${encoded}.${mac}`);
  assert.equal(invalidCursorResponse.handled, true);
  assert.equal(invalidCursorResponse.res.statusCode, 400);
  assert.match(invalidCursorResponse.res.headers["content-type"], /^application\/problem\+json/);
  assert.equal(JSON.parse(invalidCursorResponse.res.body).code, "INVALID_CURSOR");
  assert.equal(Object.hasOwn(JSON.parse(invalidCursorResponse.res.body), "orders"), false);
  assert.notEqual(invalidCursorResponse.res.statusCode, 500);
});

test("VerseKit quantity conversion preserves zero and rejects invalid or underflowing values", () => {
  const base = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", order_number: "O-1", material_name: "Ore",
    required_quantity: "12.5", quantity_unit: "SCU", status: "open", delivered_quantity: "0",
    cursor_created_at: "2026-11-19T10:00:00.123456Z" };
  const mappedZero = mapVersekitOrder(base);
  assert.equal(mappedZero.items[0].delivered, 0, "exact zero remains valid for an undelivered order");
  assert.equal(mapVersekitOrder({ ...base, required_quantity: "1" }).items[0].quantity, 1);
  assert.equal(mapVersekitOrder({ ...base, required_quantity: "0.1" }).items[0].quantity, 0.1);
  assert.equal(mapVersekitOrder({ ...base, required_quantity: "0.25" }).items[0].quantity, 0.25);
  assert.equal(mapVersekitOrder({ ...base, required_quantity: "12.5" }).items[0].quantity, 12.5);
  const tinyRepresentable = `0.${"0".repeat(322)}1`;
  assert.ok(Number(tinyRepresentable) > 0);
  assert.throws(() => mapVersekitOrder({ ...base, required_quantity: tinyRepresentable }), { reason: "REQUIRED_QUANTITY_PRECISION_UNSUPPORTED" });
  const underflow = `0.${"0".repeat(323)}1`;
  assert.equal(Number(underflow), 0);
  assert.throws(() => mapVersekitOrder({ ...base, required_quantity: underflow }), { reason: "REQUIRED_QUANTITY_PRECISION_UNDERFLOW" });
  assert.throws(() => mapVersekitOrder({ ...base, delivered_quantity: underflow }), { reason: "DELIVERED_QUANTITY_PRECISION_UNDERFLOW" });
  assert.throws(() => mapVersekitOrder({ ...base, delivered_quantity: "-1" }), { reason: "DELIVERED_QUANTITY_INVALID" });
  assert.throws(() => mapVersekitOrder({ ...base, required_quantity: "0.12345678901234567" }), { reason: "REQUIRED_QUANTITY_PRECISION_UNSUPPORTED" });
  assert.throws(() => mapVersekitOrder({ ...base, delivered_quantity: "0.10000000000000001" }),
    { reason: "DELIVERED_QUANTITY_PRECISION_UNSUPPORTED" }, "decimal round-trip loss is rejected even when Number would display 0.1");
  for (const value of ["NaN", "Infinity", "not-a-number"]) {
    assert.throws(() => mapVersekitOrder({ ...base, delivered_quantity: value }), { reason: "DELIVERED_QUANTITY_INVALID" });
  }
});

test("P2 regression: distinct PostgreSQL subnormal quantities are rejected before export", () => {
  const required = `0.${"0".repeat(322)}1`;
  const delivered = `0.${"0".repeat(323)}9`;
  assert.notEqual(required, delivered);
  assert.equal(Number(required), Number(delivered), "both PostgreSQL fixed-point decimals collapse to the same JavaScript number");
  const base = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", order_number: "P2-1", material_name: "Ore",
    quantity_unit: "SCU", status: "open", cursor_created_at: "2026-11-19T10:00:00.123456Z" };
  assert.throws(() => mapVersekitOrder({ ...base, required_quantity: required, delivered_quantity: delivered }),
    { reason: "REQUIRED_QUANTITY_PRECISION_UNSUPPORTED" });
  assert.throws(() => mapVersekitOrder({ ...base, required_quantity: "1", delivered_quantity: delivered }),
    { reason: "DELIVERED_QUANTITY_PRECISION_UNSUPPORTED" }, "a valid required quantity cannot hide unsupported delivered precision");
  assert.equal(normalizeVersekitOrderStatus("open", required, delivered), "open",
    "status normalization uses original decimal magnitudes instead of collapsed Number values");
  assert.equal(Number(required), Number(delivered));
  assert.throws(() => normalizeVersekitOrderStatus("open", Number(required), Number(delivered)),
    { name: "OrdersCompatibilityError", reason: "REQUIRED_QUANTITY_INVALID" },
    "already-rounded Number arguments are rejected instead of producing a false done status");
  assert.throws(() => normalizeVersekitOrderStatus("open", required, Number(delivered)),
    { name: "OrdersCompatibilityError", reason: "DELIVERED_QUANTITY_INVALID" });
});

test("VerseKit orders readiness mapper applies runtime unit and numeric constraints", () => {
  const base = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", order_number: "O-1", material_name: "Ore",
    required_quantity: "12.5", quantity_unit: "SCU", status: "open", delivered_quantity: "2",
    cursor_created_at: "2026-11-19T10:00:00.123456Z" };
  assert.equal(mapVersekitOrder(base).items[0].unit, "scu");
  assert.throws(() => mapVersekitOrder({ ...base, quantity_unit: "fathom" }), { reason: "UNIT_UNSUPPORTED" });
  assert.throws(() => mapVersekitOrder({ ...base, required_quantity: "0.12345678901234567" }), { reason: "REQUIRED_QUANTITY_PRECISION_UNSUPPORTED" });
  assert.throws(() => mapVersekitOrder({ ...base, delivered_quantity: "9999999999999999" }), { reason: "DELIVERED_QUANTITY_PRECISION_UNSUPPORTED" });
});

test("VerseKit order status mapping preserves cancellation and only marks full delivery done", () => {
  const sourceRow = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", order_number: "STATUS-1", material_name: "Ore",
    required_quantity: "12.5", delivered_quantity: "0", quantity_unit: "SCU", cursor_created_at: "2026-11-19T10:00:00.123456Z" };
  const cases = [
    ["open", "10", "0", "open"], ["claimed", "10", "0", "open"], ["reported", "10", "2", "open"],
    ["completed", "10", "1", "open"], ["completed", "10", "10", "done"], ["reported", "10", "10", "done"], ["cancelled", "10", "10", "cancelled"]
  ];
  for (const [status, required, delivered, expected] of cases) {
    assert.equal(normalizeVersekitOrderStatus(status, required, delivered), expected, `${status} ${delivered}/${required}`);
    assert.doesNotThrow(() => mapVersekitOrder({ ...sourceRow, status }), `${status} is an accepted source status`);
  }
  assert.equal(normalizeVersekitOrderStatus("open", "0.30000000000000004", "0.3"), "open",
    "status comparison preserves the exact decimal difference");
  assert.equal(normalizeVersekitOrderStatus("open", "10.000", "10"), "done",
    "scale differences do not change exact decimal equality");
  assert.equal(normalizeVersekitOrderStatus("reported", "10", "10.01"), "done",
    "over-delivery preserves the existing full-delivery classification");
  assert.equal(normalizeVersekitOrderStatus("completed", "12.5", "12.50"), "done");
  assert.equal(normalizeVersekitOrderStatus("claimed", "12.5", "12.49"), "open");
  assert.equal(normalizeVersekitOrderStatus("open", "12.5", "13"), "done");
  assert.equal(normalizeVersekitOrderStatus("cancelled", "12.5", "12.50"), "cancelled",
    "cancellation retains precedence for valid source decimals");
  const invalidStatuses = ["bogus", "", null, undefined, "OPEN", "Open", "CANCELLED", "canceled", 1, false];
  for (const status of invalidStatuses) {
    assert.throws(() => normalizeVersekitOrderStatus(status, "10", "10"),
      { name: "OrdersCompatibilityError", reason: "ORDER_SOURCE_INVALID" });
    assert.throws(() => mapVersekitOrder({ ...sourceRow, status }),
      { name: "OrdersCompatibilityError", reason: "ORDER_SOURCE_INVALID" });
  }
  assert.throws(() => normalizeVersekitOrderStatus("bogus", 10, 10),
    { name: "OrdersCompatibilityError", reason: "ORDER_SOURCE_INVALID" },
    "source status validation runs before quantity validation or result derivation");
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number(12.5)]) {
    assert.throws(() => normalizeVersekitOrderStatus("open", value, "0"),
      { name: "OrdersCompatibilityError", reason: "REQUIRED_QUANTITY_INVALID" });
    assert.throws(() => normalizeVersekitOrderStatus("open", "12.5", value),
      { name: "OrdersCompatibilityError", reason: "DELIVERED_QUANTITY_INVALID" });
  }
  for (const value of ["NaN", "Infinity", "12..5", "-0.1", " 12.5", "1e-323"]) {
    assert.throws(() => normalizeVersekitOrderStatus("open", value, "0"),
      { name: "OrdersCompatibilityError", reason: "REQUIRED_QUANTITY_INVALID" });
    assert.throws(() => normalizeVersekitOrderStatus("open", "12.5", value),
      { name: "OrdersCompatibilityError", reason: "DELIVERED_QUANTITY_INVALID" });
  }
});

test("VerseKit orders read is fixed-group, hidden-safe, precise, and keyset paginated on PostgreSQL 16", {
  skip: !process.env.TEST_DATABASE_URL, timeout: 120_000
}, async () => {
  const safeUrl = resolveC6TestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const databaseName = `vk05_orders_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(safeUrl); adminUrl.pathname = "/postgres";
  const admin = await createTestPool(adminUrl.toString());
  let databaseCreated = false; let bootstrap; let runtime; let blockedRuntime; let pool; let databaseUrl;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    databaseUrl = new URL(safeUrl); databaseUrl.pathname = `/${databaseName}`;
    bootstrap = await startMissionTestServer({ databaseUrl: databaseUrl.toString(), pepper: SINK_PEPPER, extraEnv: { VERSEKIT_ENABLED: "false", VERSEKIT_TOKEN_PEPPER: "" } });
    await stopMissionTestServer(bootstrap); bootstrap = null;
    pool = await createTestPool(databaseUrl.toString());

    const group = randomUUID(); const otherGroup = randomUUID(); const underflowGroup = randomUUID(); const user = randomUUID();
    await pool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,'VK05 fixed org'),($2,'VK05 unrelated org'),($3,'VK05 underflow org')", [group, otherGroup, underflowGroup]);
    await pool.query("INSERT INTO app_users(id,email,display_name,account_status) VALUES($1,$2,'VK05 test member','active')", [user, `vk05-${user}@example.test`]);
    await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$4,'member'),($2,$4,'member'),($3,$4,'member')", [group, otherGroup, underflowGroup, user]);
    const tinyUnderflow = `0.${"0".repeat(323)}1`;
    const subnormalRequired = `0.${"0".repeat(322)}1`;
    const subnormalDelivered = `0.${"0".repeat(323)}9`;
    assert.equal(Number(subnormalRequired), Number(subnormalDelivered), "the regression pair collapses to the same JavaScript Number");
    const postgresDecimals = await pool.query("SELECT $1::numeric::text AS required, $2::numeric::text AS delivered", [subnormalRequired, subnormalDelivered]);
    assert.deepEqual(postgresDecimals.rows[0], { required: subnormalRequired, delivered: subnormalDelivered },
      "PostgreSQL numeric::text retains the expanded fixed-point source values");
    await pool.query(`INSERT INTO material_orders(id,order_number,group_id,created_by,material_name,required_quantity,quantity_unit)
      VALUES($1,'VK05-UNDERFLOW',$2,$3,'Underflow fixture',$4,'SCU'),
        ($5,'VK05-SUBNORMAL',$2,$3,'Subnormal fixture',$6,'SCU')`,
    [randomUUID(), underflowGroup, user, tinyUnderflow, randomUUID(), subnormalRequired]);
    await pool.query("UPDATE material_orders SET delivered_quantity=$1 WHERE order_number='VK05-SUBNORMAL'", [subnormalDelivered]);
    runtime = await startMissionTestServer({ databaseUrl: databaseUrl.toString(), pepper: SINK_PEPPER,
      extraEnv: { VERSEKIT_ENABLED: "true", VERSEKIT_GROUP_ID: group, VERSEKIT_PUBLIC_URL: "https://verse.example.org/" } });
    const codec = createTokenCodec(PEPPER);
    const store = new VersekitTokenStore({ db: pool, codec, groupId: group, operationalScopes: ["orders:read"] });
    const grant = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    assert.equal(await store.consent({ grantId: grant.id, userId: user, scopes: ["orders:read"], approve: true }), true);
    const tokens = (await store.exchangeDeviceCode({ deviceCode: grant.deviceCode, clientId: "versekit" })).tokens;
    const baseUrl = runtime.baseUrl;
    const get = async (query = "", bearer = tokens.access_token) => fetch(`${baseUrl}/versekit/v1/orders${query}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });
    const empty = await get();
    assert.equal(empty.status, 200);
    assert.deepEqual((await empty.json()).orders, []);

    const insertOrder = async ({ name, status = "open", required = "10", unit = "SCU", legacy = null, hidden = false, orderGroup = group, seconds }) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO material_orders(id,order_number,group_id,created_by,material_name,required_quantity,quantity_unit,delivered_quantity,status,note,assigned_to,created_at,hidden_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'private note',$4,now()-($10::int * interval '1 second'),CASE WHEN $11 THEN now() ELSE NULL END)`,
      [id, `VK05-${id}`, orderGroup, user, name, required, unit, legacy, status, seconds, hidden]);
      return id;
    };
    const orderIds = [];
    orderIds.push(await insertOrder({ name: "Fallback legacy", legacy: "2.25", seconds: 60 }));
    orderIds.push(await insertOrder({ name: "Claimed", status: "claimed", seconds: 50 }));
    orderIds.push(await insertOrder({ name: "Reported", status: "reported", legacy: "99", seconds: 40 }));
    orderIds.push(await insertOrder({ name: "Completed", status: "completed", seconds: 30 }));
    orderIds.push(await insertOrder({ name: "Cancelled", status: "cancelled", seconds: 20 }));
    orderIds.push(await insertOrder({ name: "Crystalline", unit: "CSCU", seconds: 15 }));
    orderIds.push(await insertOrder({ name: "Components", unit: "Pieces", seconds: 15 }));
    orderIds.push(await insertOrder({ name: "Decimal ledger sum", required: "0.3", seconds: 14 }));
    const hidden = await insertOrder({ name: "Hidden", hidden: true, seconds: 10 });
    await insertOrder({ name: "Unrelated", orderGroup: otherGroup, seconds: 5 });
    await pool.query("INSERT INTO material_order_deliveries(order_id,delivered_by,delivered_quantity) VALUES($1,$3,2),($1,$3,3),($2,$3,10),($4,$3,0.1),($4,$3,0.2)",
      [orderIds[2], orderIds[3], user, orderIds[7]]);

    // Readiness and runtime share mapVersekitOrder. Hidden and other-group
    // rows must not become blockers for the configured organization.
    await insertOrder({ name: "Hidden unsupported", unit: "fathom", hidden: true, seconds: 4 });
    await insertOrder({ name: "Other group unsupported", unit: "fathom", orderGroup: otherGroup, seconds: 3 });
    await insertOrder({ name: "Hidden subnormal", required: subnormalRequired, hidden: true, seconds: 2 });
    await insertOrder({ name: "Other group subnormal", required: subnormalRequired, orderGroup: otherGroup, seconds: 2 });
    await assertOrdersReadiness({ db: pool, groupId: group });
    const unsupported = await insertOrder({ name: "Visible unsupported", unit: "fathom", seconds: 2 });
    await assert.rejects(assertOrdersReadiness({ db: pool, groupId: group }), { code: "VERSEKIT_ORDERS_NOT_READY", reason: "UNIT_UNSUPPORTED" });
    await pool.query("DELETE FROM material_orders WHERE id=$1", [unsupported]);
    const excessive = await insertOrder({ name: "Excessive precision", required: "0.12345678901234567", seconds: 1 });
    await assert.rejects(assertOrdersReadiness({ db: pool, groupId: group }), { code: "VERSEKIT_ORDERS_NOT_READY", reason: "REQUIRED_QUANTITY_PRECISION_UNSUPPORTED" });
    await pool.query("DELETE FROM material_orders WHERE id=$1", [excessive]);
    const excessiveDelivered = await insertOrder({ name: "Excessive delivered", legacy: "0.12345678901234567", seconds: 1 });
    await assert.rejects(assertOrdersReadiness({ db: pool, groupId: group }), { code: "VERSEKIT_ORDERS_NOT_READY", reason: "DELIVERED_QUANTITY_PRECISION_UNSUPPORTED" });
    await pool.query("DELETE FROM material_orders WHERE id=$1", [excessiveDelivered]);
    const tinyRequired = await insertOrder({ name: "Underflow required", required: tinyUnderflow, seconds: 1 });
    await assert.rejects(assertOrdersReadiness({ db: pool, groupId: group }), { code: "VERSEKIT_ORDERS_NOT_READY", reason: "REQUIRED_QUANTITY_PRECISION_UNDERFLOW" });
    await pool.query("DELETE FROM material_orders WHERE id=$1", [tinyRequired]);
    const tinyLegacy = await insertOrder({ name: "Underflow legacy delivered", legacy: tinyUnderflow, seconds: 1 });
    await assert.rejects(assertOrdersReadiness({ db: pool, groupId: group }), { code: "VERSEKIT_ORDERS_NOT_READY", reason: "DELIVERED_QUANTITY_PRECISION_UNDERFLOW" });
    await pool.query("DELETE FROM material_orders WHERE id=$1", [tinyLegacy]);
    const tinyLedger = await insertOrder({ name: "Underflow ledger delivered", legacy: "0", seconds: 1 });
    await pool.query("INSERT INTO material_order_deliveries(order_id,delivered_by,delivered_quantity) VALUES($1,$2,$3)", [tinyLedger, user, tinyUnderflow]);
    await assert.rejects(assertOrdersReadiness({ db: pool, groupId: group }), { code: "VERSEKIT_ORDERS_NOT_READY", reason: "DELIVERED_QUANTITY_PRECISION_UNDERFLOW" });
    await pool.query("DELETE FROM material_orders WHERE id=$1", [tinyLedger]);
    const collapsedValues = await insertOrder({ name: "Collapsed subnormal pair", required: subnormalRequired, legacy: subnormalDelivered, seconds: 1 });
    await assert.rejects(assertOrdersReadiness({ db: pool, groupId: group }),
      { code: "VERSEKIT_ORDERS_NOT_READY", reason: "REQUIRED_QUANTITY_PRECISION_UNSUPPORTED" });
    await pool.query("DELETE FROM material_orders WHERE id=$1", [collapsedValues]);
    const subnormalDeliveredOnly = await insertOrder({ name: "Subnormal delivered", required: "1", legacy: subnormalDelivered, seconds: 1 });
    await assert.rejects(assertOrdersReadiness({ db: pool, groupId: group }),
      { code: "VERSEKIT_ORDERS_NOT_READY", reason: "DELIVERED_QUANTITY_PRECISION_UNSUPPORTED" });
    await pool.query("DELETE FROM material_orders WHERE id=$1", [subnormalDeliveredOnly]);
    const roundTripLoss = await insertOrder({ name: "Delivered round-trip loss", required: "1", legacy: "0.10000000000000001", seconds: 1 });
    await assert.rejects(assertOrdersReadiness({ db: pool, groupId: group }),
      { code: "VERSEKIT_ORDERS_NOT_READY", reason: "DELIVERED_QUANTITY_PRECISION_UNSUPPORTED" });
    await pool.query("DELETE FROM material_orders WHERE id=$1", [roundTripLoss]);
    const subnormalLedger = await insertOrder({ name: "Subnormal ledger sum", required: "1", legacy: "0", seconds: 1 });
    await pool.query("INSERT INTO material_order_deliveries(order_id,delivered_by,delivered_quantity) VALUES($1,$2,$3)", [subnormalLedger, user, subnormalDelivered]);
    await assert.rejects(assertOrdersReadiness({ db: pool, groupId: group }),
      { code: "VERSEKIT_ORDERS_NOT_READY", reason: "DELIVERED_QUANTITY_PRECISION_UNSUPPORTED" });
    await pool.query("DELETE FROM material_orders WHERE id=$1", [subnormalLedger]);
    await assertOrdersReadiness({ db: pool, groupId: group });

    const first = await get("?limit=2&group_id=" + otherGroup);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const firstBody = await first.json();
    assert.equal(firstBody.orders.length, 2);
    assert.ok(firstBody.next_cursor);
    assert.ok(firstBody.orders.every((order) => orderIds.includes(order.id)));
    assert.ok(!JSON.stringify(firstBody).includes("private note"));
    let all = [...firstBody.orders]; let cursor = firstBody.next_cursor;
    while (cursor) {
      const page = await get(`?limit=2&cursor=${encodeURIComponent(cursor)}`);
      assert.equal(page.status, 200);
      const body = await page.json();
      all.push(...body.orders); cursor = body.next_cursor;
    }
    assert.equal(all.length, 8);
    assert.equal(new Set(all.map((order) => order.id)).size, 8);
    assert.ok(!all.some((order) => order.id === hidden));
    const fallback = all.find((order) => order.id === orderIds[0]);
    assert.deepEqual(fallback.items[0], { item: "Fallback legacy", quantity: 10, delivered: 2.25, unit: "scu" });
    assert.equal(all.find((order) => order.id === orderIds[1]).items[0].delivered, 0, "PostgreSQL NULL fallback preserves exact zero");
    assert.equal(all.find((order) => order.id === orderIds[1]).status, "open");
    assert.equal(all.find((order) => order.id === orderIds[2]).items[0].delivered, 5, "delivery rows supersede, not add to, the legacy total");
    assert.equal(all.find((order) => order.id === orderIds[2]).status, "open");
    assert.equal(all.find((order) => order.id === orderIds[3]).status, "done");
    assert.equal(all.find((order) => order.id === orderIds[7]).items[0].delivered, 0.3,
      "PostgreSQL ledger decimals 0.1 and 0.2 sum exactly before safe JSON conversion");
    assert.equal(all.find((order) => order.id === orderIds[7]).status, "done");
    assert.equal(all.find((order) => order.id === orderIds[4]).status, "cancelled");
    assert.equal(all.find((order) => order.id === orderIds[5]).items[0].unit, "cscu");
    assert.equal(all.find((order) => order.id === orderIds[6]).items[0].unit, "piece");
    assert.ok(all.every((order) => !JSON.stringify(order).includes(otherGroup)));

    const session = await createSession(pool, SINK_PEPPER, user);
    // This group's visible positive quantity underflows JavaScript Number;
    // readiness must suppress discovery while normal VerseLink remains up.
    blockedRuntime = await startMissionTestServer({ databaseUrl: databaseUrl.toString(), pepper: SINK_PEPPER,
      extraEnv: { VERSEKIT_ENABLED: "true", VERSEKIT_GROUP_ID: underflowGroup, VERSEKIT_PUBLIC_URL: "https://verse.example.org/" } });
    assert.equal((await fetch(`${blockedRuntime.baseUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${blockedRuntime.baseUrl}/.well-known/versekit-org.json`)).status, 404,
      "readiness failure prevents discovery and orders:read advertisement");
    const normalOrders = await fetch(`${blockedRuntime.baseUrl}/api/orders?group_id=${underflowGroup}`, { headers: { cookie: `bp_session=${session}` } });
    assert.equal(normalOrders.status, 200, "ordinary VerseLink Orders remains available when VerseKit readiness fails");

    const browserCreate = await fetch(`${baseUrl}/api/orders`, { method: "POST", headers: { cookie: `bp_session=${session}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ group_id: group, material_name: "Browser-created", required_quantity: "4", quantity_unit: "Pieces", note: "private browser note" }) });
    assert.equal(browserCreate.status, 201);
    const created = await browserCreate.json();
    const reflected = async () => (await (await get()).json()).orders.find((order) => order.id === created.id);
    assert.equal((await reflected()).items[0].quantity, 4);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM material_orders WHERE id=$1", [created.id])).rows[0].count, 1,
      "the adapter reads the browser-created row without duplicating it");
    const report = await fetch(`${baseUrl}/api/orders/action`, { method: "POST", headers: { cookie: `bp_session=${session}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id: created.id, action: "report", delivered_quantity: "1" }) });
    assert.equal(report.status, 200);
    assert.equal((await reflected()).items[0].delivered, 1);
    const cancel = await fetch(`${baseUrl}/api/orders/action`, { method: "POST", headers: { cookie: `bp_session=${session}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id: created.id, action: "cancel" }) });
    assert.equal(cancel.status, 200);
    assert.equal((await reflected()).status, "cancelled");

    assert.equal((await get("?limit=0")).status, 400);
    assert.deepEqual(await (await get("?cursor=invalid!")).json(), { type: "about:blank", status: 400, code: "INVALID_CURSOR" });
    const unauth = await get("", null);
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get("www-authenticate"), 'Bearer error="invalid_token"');

    const invalidated = await store.createDeviceGrant({ clientId: "versekit", scopes: ["orders:read"] });
    await store.consent({ grantId: invalidated.id, userId: user, scopes: ["orders:read"], approve: true });
    const revokedToken = (await store.exchangeDeviceCode({ deviceCode: invalidated.deviceCode, clientId: "versekit" })).tokens;
    await store.revoke(revokedToken.access_token);
    assert.equal((await get("", revokedToken.access_token)).status, 401, "revoked tokens cannot read orders");

    const imprecise = await insertOrder({ name: "Imprecise", required: "0.12345678901234567", seconds: 1 });
    const incompatibleResponse = await get();
    assert.equal(incompatibleResponse.status, 503, "quantities exceeding the explicit 15 significant digit JSON precision are rejected");
    const incompatibleBody = await incompatibleResponse.text();
    assert.ok(!incompatibleBody.includes("Imprecise") && !incompatibleBody.includes(imprecise), "public maintenance response does not disclose record details");
    await pool.query("DELETE FROM material_orders WHERE id=$1", [imprecise]);
    assert.equal((await get()).status, 200, "corrected data becomes readable without restarting the already-ready adapter");
    const underflowOrder = await insertOrder({ name: "Underflow", required: tinyUnderflow, seconds: 1 });
    const underflowResponse = await get();
    assert.equal(underflowResponse.status, 503, "a newly introduced positive underflow never appears as quantity zero");
    assert.equal(underflowResponse.headers.get("retry-after"), "30");
    const underflowBody = await underflowResponse.text();
    assert.ok(!underflowBody.includes("Underflow") && !underflowBody.includes(underflowOrder));
    await pool.query("DELETE FROM material_orders WHERE id=$1", [underflowOrder]);
    assert.equal((await get()).status, 200, "correcting underflowing data restores runtime reads without restart");
    const subnormalRuntimeOrder = await insertOrder({ name: "Subnormal runtime secret", required: subnormalRequired, legacy: subnormalDelivered, seconds: 1 });
    const subnormalResponse = await get();
    assert.equal(subnormalResponse.status, 503, "a newly introduced subnormal precision collision is rejected at runtime");
    assert.equal(subnormalResponse.headers.get("retry-after"), "30");
    const subnormalBody = await subnormalResponse.text();
    assert.ok(!subnormalBody.includes("Subnormal runtime secret") && !subnormalBody.includes(subnormalRuntimeOrder));
    await pool.query("DELETE FROM material_orders WHERE id=$1", [subnormalRuntimeOrder]);
    assert.equal((await get()).status, 200, "correcting the incompatible subnormal row restores runtime reads");

    await pool.query("DELETE FROM group_members WHERE group_id=$1 AND app_user_id=$2", [group, user]);
    assert.equal((await get()).status, 401, "membership removal invalidates a previously issued bearer token");
  } finally {
    await stopMissionTestServer(runtime);
    await stopMissionTestServer(blockedRuntime);
    await stopMissionTestServer(bootstrap);
    await pool?.end();
    if (databaseCreated) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
    await admin.end();
  }
});
