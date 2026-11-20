import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { canonicalizeVersekitDeliveryQuantity, sumVersekitDeliveryQuantities } from "../src/integrations/versekit/orders.js";
import { createOrdersWriteHandler } from "../src/integrations/versekit/orders-write.js";
import { createVersekitRouter } from "../src/integrations/versekit/router.js";
import { createTokenCodec } from "../src/integrations/versekit/tokens.js";
import { VersekitTokenStore } from "../src/integrations/versekit/store.js";
import { activateVersekitAuthorizationGroup, initializeVersekitSchema } from "../src/integrations/versekit/schema.js";
import { resolveC6TestDatabaseUrl } from "./helpers/c6-test-database.js";
import { apiRequest, createSession, createTestPool, startMissionTestServer, stopMissionTestServer, VERSEKIT_TEST_TOKEN_PEPPER } from "./helpers/mission-integration.js";

const PEPPER = VERSEKIT_TEST_TOKEN_PEPPER;
const SINK_PEPPER = "vk06-browser-test-sink-pepper";
const TEST_QUOTA = { capacity: 24, refillIntervalSeconds: 3600 };

test("VerseKit delivery quantities canonicalize and sum using exact decimals", () => {
  assert.equal(canonicalizeVersekitDeliveryQuantity(0.1), "0.1");
  assert.equal(canonicalizeVersekitDeliveryQuantity(1e-7), "0.0000001");
  assert.equal(sumVersekitDeliveryQuantities(["0.1", "0.2", "1.05"]), "1.35");
  assert.throws(() => canonicalizeVersekitDeliveryQuantity(0));
  assert.throws(() => canonicalizeVersekitDeliveryQuantity(0.10000000000000002), { reason: "DELIVERY_QUANTITY_PRECISION_UNSUPPORTED" });
});

test("VerseKit order deliveries are atomic, idempotent across restart, and fixed-group on PostgreSQL 16", {
  skip: !process.env.TEST_DATABASE_URL, timeout: 120_000
}, async (t) => {
  const safeUrl = resolveC6TestDatabaseUrl(process.env.TEST_DATABASE_URL);
  const databaseName = `vk06_write_${randomUUID().replaceAll("-", "")}`;
  const adminUrl = new URL(safeUrl); adminUrl.pathname = "/postgres";
  const admin = await createTestPool(adminUrl.toString());
  let databaseCreated = false; let bootstrap; let runtime; let pool; let adapterServer;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    databaseCreated = true;
    const databaseUrl = new URL(safeUrl); databaseUrl.pathname = `/${databaseName}`;
    bootstrap = await startMissionTestServer({ databaseUrl: databaseUrl.toString(), pepper: SINK_PEPPER,
      extraEnv: { VERSEKIT_ENABLED: "false", VERSEKIT_TOKEN_PEPPER: "" } });
    await stopMissionTestServer(bootstrap); bootstrap = null;
    pool = await createTestPool(databaseUrl.toString());

    const group = randomUUID(); const otherGroup = randomUUID(); const member = randomUUID(); const outsider = randomUUID();
    await pool.query("INSERT INTO blueprint_groups(id,name) VALUES($1,'VK06 main org'),($2,'VK06 other org')", [group, otherGroup]);
    await pool.query("INSERT INTO app_users(id,email,display_name,account_status) VALUES($1,$2,'VK06 member','active'),($3,$4,'VK06 outsider','active')",
      [member, `vk06-${member}@example.test`, outsider, `vk06-${outsider}@example.test`]);
    await pool.query("INSERT INTO group_members(group_id,app_user_id,role) VALUES($1,$2,'member'),($3,$2,'member'),($3,$4,'member')", [group, member, otherGroup, outsider]);
    await initializeVersekitSchema(pool, TEST_QUOTA);
    await activateVersekitAuthorizationGroup(pool, group);

    runtime = await startMissionTestServer({ databaseUrl: databaseUrl.toString(), pepper: SINK_PEPPER,
      extraEnv: { VERSEKIT_ENABLED: "true", VERSEKIT_GROUP_ID: group, VERSEKIT_PUBLIC_URL: "https://versekit-test.example.org/" } });
    const discovery = await fetch(`${runtime.baseUrl}/.well-known/versekit-org.json`);
    assert.equal(discovery.status, 200);
    assert.deepEqual((await discovery.json()).versions["1"].scopes_supported, ["orders:read"], "the application bootstrap remains read-only");

    const codec = createTokenCodec(PEPPER);
    const store = new VersekitTokenStore({ db: pool, codec, groupId: group, operationalScopes: ["orders:read", "orders:write"] });
    const issueToken = async (scopes) => {
      const grant = await store.createDeviceGrant({ clientId: "versekit", scopes });
      assert.equal(await store.consent({ grantId: grant.id, userId: member, scopes, approve: true }), true);
      return (await store.exchangeDeviceCode({ deviceCode: grant.deviceCode, clientId: "versekit" })).tokens.access_token;
    };
    const writeToken = await issueToken(["orders:write"]);
    const readToken = await issueToken(["orders:read"]);
    const createWriteServer = async (activeStore) => {
      const handler = createOrdersWriteHandler({ db: pool, groupId: group, tokenStore: activeStore,
        limiter: { consume: () => ({ allowed: true }) } });
      const router = createVersekitRouter({ ordersWrite: handler });
      const server = createServer((req, res) => router(req, res, new URL(req.url, "http://127.0.0.1")));
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      adapterServer = server;
      return `http://127.0.0.1:${server.address().port}`;
    };
    const closeWriteServer = async () => {
      if (!adapterServer) return;
      const closing = once(adapterServer, "close");
      adapterServer.close();
      await closing;
      adapterServer = null;
    };
    let writeBase = await createWriteServer(store);
    const session = await createSession(pool, SINK_PEPPER, member);
    const order = async ({ name = "Taranite", required = "10", legacy = null, orderGroup = group, hidden = false } = {}) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO material_orders(id,order_number,group_id,created_by,material_name,required_quantity,quantity_unit,delivered_quantity,hidden_at)
        VALUES($1,$2,$3,$4,$5,$6,'SCU',$7,CASE WHEN $8 THEN now() ELSE NULL END)`,
      [id, `VK06-${id}`, orderGroup, member, name, required, legacy, hidden]);
      return id;
    };
    const deliver = (base, id, { key = randomUUID(), items = [{ item: "Taranite", quantity: 1 }], token = writeToken } = {}) =>
      fetch(`${base}/versekit/v1/orders/${id}/deliveries`, { method: "POST", headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key
      }, body: JSON.stringify({ items }) });
    const ledger = async (id) => pool.query("SELECT count(*)::int AS count,COALESCE(sum(delivered_quantity),0)::text AS total FROM material_order_deliveries WHERE order_id=$1", [id]);

    const basic = await order();
    const first = await deliver(writeBase, basic, { key: "basic-replay-key", items: [
      { item: "Taranite", quantity: 1 }, { item: "Taranite", quantity: 2 }
    ] });
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.equal(firstBody.order.items[0].delivered, 3);
    assert.equal(firstBody.order.status, "open");
    assert.equal((await ledger(basic)).rows[0].total, "3");

    await closeWriteServer();
    const restartedStore = new VersekitTokenStore({ db: pool, codec: createTokenCodec(PEPPER), groupId: group,
      operationalScopes: ["orders:read", "orders:write"] });
    writeBase = await createWriteServer(restartedStore);
    const replay = await deliver(writeBase, basic, { key: "basic-replay-key", items: [
      { quantity: 1, item: "Taranite" }, { quantity: 2, item: "Taranite" }
    ] });
    assert.equal(replay.status, 201);
    assert.deepEqual(await replay.json(), firstBody, "a restart and JSON property reordering still replay the original response");
    assert.equal((await ledger(basic)).rows[0].count, 1);
    for (const mismatch of [
      { id: basic, items: [{ item: "Taranite", quantity: 4 }] },
      { id: await order(), items: [{ item: "Taranite", quantity: 3 }] }
    ]) {
      const response = await deliver(writeBase, mismatch.id, { key: "basic-replay-key", items: mismatch.items });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "INVALID_REQUEST");
    }
    assert.equal((await ledger(basic)).rows[0].count, 1, "mismatched key reuses do not add a delivery");

    const partial = await deliver(writeBase, basic, { key: "partial-key", items: [{ item: "Taranite", quantity: 4 }] });
    assert.equal(partial.status, 201);
    assert.equal((await partial.json()).order.items[0].delivered, 7);
    const complete = await deliver(writeBase, basic, { key: "complete-key", items: [{ item: "Taranite", quantity: 3 }] });
    assert.equal(complete.status, 201);
    assert.equal((await complete.json()).order.status, "done");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM app_notifications WHERE order_id=$1 AND kind='order_completed'", [basic])).rows[0].count, 1,
      "completion notification is atomic and appears once");

    const noKey = await fetch(`${writeBase}/versekit/v1/orders/${await order()}/deliveries`, { method: "POST",
      headers: { authorization: `Bearer ${writeToken}`, "content-type": "application/json" }, body: JSON.stringify({ items: [{ item: "Taranite", quantity: 1 }] }) });
    assert.equal(noKey.status, 400);
    assert.equal((await noKey.json()).code, "IDEMPOTENCY_KEY_MISSING");
    const readDenied = await deliver(writeBase, await order(), { token: readToken });
    assert.equal(readDenied.status, 403);
    assert.equal((await readDenied.json()).code, "SCOPE_MISSING");
    const unauth = await fetch(`${writeBase}/versekit/v1/orders/${basic}/deliveries`, { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "unauth" }, body: JSON.stringify({ items: [{ item: "Taranite", quantity: 1 }] }) });
    assert.equal(unauth.status, 401);
    assert.equal(unauth.headers.get("www-authenticate"), 'Bearer error="invalid_token"');
    assert.equal((await unauth.json()).code, "UNAUTHORIZED");

    const wrongItem = await deliver(writeBase, await order(), { key: "wrong-item", items: [{ item: "Copper", quantity: 1 }] });
    assert.equal(wrongItem.status, 422);
    assert.equal((await wrongItem.json()).code, "ITEM_NOT_IN_ORDER");
    const malformed = await fetch(`${writeBase}/versekit/v1/orders/${basic}/deliveries`, { method: "POST", headers: {
      authorization: `Bearer ${writeToken}`, "content-type": "application/json", "idempotency-key": "bad-body"
    }, body: "{" });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).code, "INVALID_BODY");
    const excessOrder = await order();
    const excess = await deliver(writeBase, excessOrder, { key: "excess", items: [{ item: "Taranite", quantity: 11 }] });
    assert.equal(excess.status, 400);
    assert.equal((await excess.json()).code, "INVALID_REQUEST");
    await pool.query("UPDATE material_orders SET required_quantity=20 WHERE id=$1", [excessOrder]);
    const excessReplay = await deliver(writeBase, excessOrder, { key: "excess", items: [{ item: "Taranite", quantity: 11 }] });
    assert.equal(excessReplay.status, 400);
    assert.equal(excessReplay.headers.get("content-type"), "application/problem+json; charset=utf-8");
    assert.equal((await excessReplay.json()).code, "INVALID_REQUEST", "deterministic business errors replay after state changes");
    assert.equal((await ledger(excessOrder)).rows[0].count, 0);
    const closedOrder = await order({ required: "1", legacy: "1" });
    await pool.query("UPDATE material_orders SET status='completed' WHERE id=$1", [closedOrder]);
    const closed = await deliver(writeBase, closedOrder, { key: "closed" });
    assert.equal(closed.status, 409);
    assert.equal((await closed.json()).code, "ORDER_CLOSED");
    const wrongScopeRuntime = await apiRequest(runtime.baseUrl, `/versekit/v1/orders/${basic}/deliveries`, { method: "POST", session, json: { items: [{ item: "Taranite", quantity: 1 }] } });
    assert.equal(wrongScopeRuntime.status, 404, "the real server bootstrap does not mount the unapproved write capability");

    const foreign = await order({ orderGroup: otherGroup });
    const hidden = await order({ hidden: true });
    for (const id of [foreign, hidden]) {
      const response = await deliver(writeBase, id, { key: `invisible-${id}` });
      assert.equal(response.status, 404);
      assert.equal((await response.json()).code, "NOT_FOUND");
    }
    const legacy = await order({ legacy: "2" });
    const legacyWrite = await deliver(writeBase, legacy, { key: "legacy-unsafe" });
    assert.equal(legacyWrite.status, 409);
    assert.equal((await legacyWrite.json()).code, "ORDER_CLOSED");
    assert.deepEqual((await ledger(legacy)).rows[0], { count: 0, total: "0" });
    const legacyBrowser = await apiRequest(runtime.baseUrl, "/api/orders/action", { method: "POST", session,
      form: { id: legacy, action: "report", delivered_quantity: "1" } });
    assert.equal(legacyBrowser.status, 409);
    assert.equal((await pool.query("SELECT delivered_quantity::text FROM material_orders WHERE id=$1", [legacy])).rows[0].delivered_quantity, "2");

    const concurrent = await order();
    const sameKey = await Promise.all([
      deliver(writeBase, concurrent, { key: "same-key-concurrent", items: [{ item: "Taranite", quantity: 3 }] }),
      deliver(writeBase, concurrent, { key: "same-key-concurrent", items: [{ item: "Taranite", quantity: 3 }] })
    ]);
    assert.deepEqual(sameKey.map((response) => response.status), [201, 201]);
    assert.deepEqual(await sameKey[0].json(), await sameKey[1].json());
    assert.equal((await ledger(concurrent)).rows[0].count, 1);

    const limited = await order();
    const overRace = await Promise.all([
      deliver(writeBase, limited, { key: "race-seven", items: [{ item: "Taranite", quantity: 7 }] }),
      deliver(writeBase, limited, { key: "race-six", items: [{ item: "Taranite", quantity: 6 }] })
    ]);
    assert.deepEqual(overRace.map((response) => response.status).sort(), [201, 400]);
    assert.ok(Number((await ledger(limited)).rows[0].total) <= 10);

    const crossClient = await order();
    const crossRace = await Promise.all([
      deliver(writeBase, crossClient, { key: "cross-vk", items: [{ item: "Taranite", quantity: 7 }] }),
      apiRequest(runtime.baseUrl, "/api/orders/action", { method: "POST", session,
        form: { id: crossClient, action: "report", delivered_quantity: "7" } })
    ]);
    const vkStatus = crossRace[0].status;
    const browserStatus = crossRace[1].status;
    assert.ok(vkStatus === 201 || vkStatus === 400);
    assert.ok(browserStatus === 200 || browserStatus === 400);
    assert.ok(Number((await ledger(crossClient)).rows[0].total) <= 10);
    assert.equal((await pool.query("SELECT delivered_quantity::text FROM material_orders WHERE id=$1", [crossClient])).rows[0].delivered_quantity,
      (await ledger(crossClient)).rows[0].total, "browser and VerseKit share the ledger total without overwriting each other");

    const cancelRace = await order();
    const racing = await Promise.all([
      deliver(writeBase, cancelRace, { key: "cancel-race", items: [{ item: "Taranite", quantity: 3 }] }),
      apiRequest(runtime.baseUrl, "/api/orders/action", { method: "POST", session, form: { id: cancelRace, action: "cancel" } })
    ]);
    assert.ok([201, 409].includes(racing[0].status));
    assert.equal(racing[1].status, 200);
    assert.equal((await pool.query("SELECT status FROM material_orders WHERE id=$1", [cancelRace])).rows[0].status, "cancelled",
      "a serialized browser cancellation is never overwritten by a stale VerseKit report");

    const claimRace = await order();
    const claimResults = await Promise.all([
      deliver(writeBase, claimRace, { key: "claim-race", items: [{ item: "Taranite", quantity: 2 }] }),
      apiRequest(runtime.baseUrl, "/api/orders/action", { method: "POST", session, form: { id: claimRace, action: "claim" } })
    ]);
    assert.equal(claimResults[0].status, 201);
    assert.ok([200, 409].includes(claimResults[1].status));
    assert.equal((await pool.query("SELECT status FROM material_orders WHERE id=$1", [claimRace])).rows[0].status, "reported",
      "claim rechecks under the same order lock and cannot overwrite delivered progress");

    const completeRace = await order({ required: "10" });
    await pool.query("INSERT INTO material_order_deliveries(order_id,delivered_by,delivered_quantity) VALUES($1,$2,9)", [completeRace, member]);
    await pool.query("UPDATE material_orders SET delivered_quantity=9,status='reported' WHERE id=$1", [completeRace]);
    const completing = await Promise.all([
      deliver(writeBase, completeRace, { key: "complete-race", items: [{ item: "Taranite", quantity: 1 }] }),
      apiRequest(runtime.baseUrl, "/api/orders/action", { method: "POST", session, form: { id: completeRace, action: "complete" } })
    ]);
    assert.equal(completing[0].status, 201);
    assert.ok([200, 409].includes(completing[1].status));
    assert.equal((await pool.query("SELECT status FROM material_orders WHERE id=$1", [completeRace])).rows[0].status, "completed");
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM app_notifications WHERE order_id=$1 AND kind='order_completed'", [completeRace])).rows[0].count, 1);

    const memberRevoked = await order();
    await pool.query("DELETE FROM group_members WHERE group_id=$1 AND app_user_id=$2", [group, member]);
    const afterRemoval = await deliver(writeBase, memberRevoked, { key: "member-removed" });
    assert.equal(afterRemoval.status, 401);
    assert.equal((await afterRemoval.json()).code, "UNAUTHORIZED");
  } finally {
    if (adapterServer) await new Promise((resolve) => adapterServer.close(resolve));
    await stopMissionTestServer(runtime);
    await stopMissionTestServer(bootstrap);
    await pool?.end();
    if (databaseCreated) {
      await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [databaseName]);
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    }
    await admin.end();
  }
});
