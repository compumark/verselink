import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocationCatalogHandlers,
  LOCATION_CATALOG_TTL_SECONDS,
  normalizeLocationEntry,
  resolveLocation
} from "../src/telemetry-location-catalog.js";

const verified = { location_raw: "Pyro4_Outpost_col_m_scrp_indy_001", display_name: "Ruin Station", system_name: "Pyro", jurisdiction: null, affiliation: "Headhunters", status: "verified", match_type: "manual" };
const response = () => ({ headers: {}, setHeader(name, value) { this.headers[name] = value; }, writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); }, end(text = "") { this.body = typeof text === "string" && text ? JSON.parse(text) : text || null; } });
const fakePool = () => ({ query: async sql => sql.includes("catalog_version") ? { rows: [{ version: 7 }] } : { rows: [verified] }, connect: async () => ({ query: async () => ({ rowCount: 1 }), release() {} }) });

test("location mappings require an exact raw key and keep system, jurisdiction and affiliation separate", () => {
  const mapping = normalizeLocationEntry({ ...verified, status: "verified" });
  assert.equal(mapping.location_raw, verified.location_raw);
  assert.deepEqual(resolveLocation(verified.location_raw, "UEE", mapping), {
    locationDisplay: "Ruin Station", systemDisplay: "Pyro", jurisdictionDisplay: "Unknown", affiliationDisplay: "Headhunters", resolutionStatus: "resolved"
  });
  assert.equal(resolveLocation("Pyro4_Outpost_col_m_scrp_indy_001", "UEE", null).jurisdictionDisplay, "Unknown", "legacy telemetry jurisdiction is never used as a fallback");
  assert.equal(resolveLocation("pyro4_outpost_col_m_scrp_indy_001", "Pyro", mapping).locationDisplay, "pyro4_outpost_col_m_scrp_indy_001", "matching is byte-exact");
});

test("location resolver makes a confirmed jurisdiction unknown when telemetry conflicts", () => {
  const result = resolveLocation("raw-key", "UEE", { ...verified, location_raw: "raw-key", jurisdiction: "Pyro Free Peoples", status: "verified" });
  assert.equal(result.locationDisplay, "Ruin Station");
  assert.equal(result.systemDisplay, "Pyro");
  assert.equal(result.jurisdictionDisplay, "Unknown");
  assert.equal(result.affiliationDisplay, "Headhunters");
  assert.equal(result.resolutionStatus, "conflict");
});

test("unverified suggestions cannot be normalized into confirmed catalog entries", () => {
  assert.equal(normalizeLocationEntry({ location_raw: "raw", display_name: "A place", status: "suggested" }).status, "suggested");
  assert.equal(resolveLocation({ entries: [{ location_raw: "raw", display_name: "Guess", status: "suggested", match_type: "manual" }] }, "raw", "Stanton").jurisdictionDisplay, "Unknown");
  assert.equal(LOCATION_CATALOG_TTL_SECONDS, 86400);
});

test("device catalog is a bounded versioned bearer-authenticated bundle with ETag support", async () => {
  const requests = [];
  const handlers = createLocationCatalogHandlers({
    pool: fakePool(),
    authenticateDevice: async req => { requests.push(req); return { kind: "authenticated", context: { deviceId: "device-1" } }; },
    consumeDeviceLimit: () => ({ allowed: true }),
    sendJson: (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); },
    sendError: (res, status, error) => { res.writeHead(status); res.end(JSON.stringify({ error })); }
  });
  const first = response();
  await handlers.deviceBundle({ headers: {} }, first);
  assert.equal(first.status, 200);
  assert.equal(first.headers["cache-control"], `private, max-age=${LOCATION_CATALOG_TTL_SECONDS}`);
  const bundle = first.body;
  assert.equal(bundle.schema, 1);
  assert.equal(bundle.version, 7);
  assert.deepEqual(bundle.entries.map(row => row.location_raw), [verified.location_raw]);
  const unchanged = response();
  await handlers.deviceBundle({ headers: { "if-none-match": first.headers.etag } }, unchanged);
  assert.equal(unchanged.status, 304);
  assert.equal(requests.length, 2);
});

test("invalid or revoked devices are rejected and do not download catalog data", async () => {
  let queried = false;
  const handlers = createLocationCatalogHandlers({
    pool: { query: async () => { queried = true; return { rows: [] }; } },
    authenticateDevice: async () => ({ kind: "device_revoked" }),
    sendJson: (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); },
    sendError: (res, status, error) => { res.writeHead(status); res.end(JSON.stringify({ error })); }
  });
  const res = response();
  await handlers.deviceBundle({ headers: {} }, res);
  assert.equal(res.status, 401);
  assert.equal(res.headers["WWW-Authenticate"], "Bearer");
  assert.equal(queried, false);
});

test("external import creates proposals only and never resolves a game-log key", async () => {
  const inserted = [];
  const pool = {
    connect: async () => ({ query: async (sql, params) => { inserted.push({ sql, params }); return { rowCount: 1 }; }, release() {} }),
    query: async () => ({ rows: [] })
  };
  const handlers = createLocationCatalogHandlers({
    pool,
    sendJson: (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); },
    sendError: (res, status, error) => { res.writeHead(status); res.end(JSON.stringify({ error })); },
    wikiImportEnabled: true,
    fetchImpl: async () => new Response(JSON.stringify([{ id: 24, name: "Ruin Station", system: "Pyro", jurisdiction: "UEE" }]), { status: 200 })
  });
  const res = response();
  await handlers.importCandidates({ is_admin: true }, res, "wiki");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, source: "Star Citizen Wiki API", proposals: 1, exact_key_matches: 0 });
  assert.match(inserted[1].sql, /telemetry_location_suggestions/);
  assert.doesNotMatch(inserted[1].sql, /telemetry_location_catalog\s*\(/);
});
