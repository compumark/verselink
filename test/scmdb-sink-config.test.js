import assert from "node:assert/strict";
import test from "node:test";
import { normalizeScmdbSinkBaseUrl, scmdbSinkUrl } from "../src/scmdb-sink-config.js";

test("uses an explicitly configured SCMDB sink base URL", () => {
  const baseUrl = normalizeScmdbSinkBaseUrl("https://example.org/v1/scmdb");
  assert.equal(baseUrl, "https://example.org/v1/scmdb");
  assert.equal(scmdbSinkUrl(baseUrl, "sink-token"), "https://example.org/v1/scmdb/sink-token");
});

test("normalizes an SCMDB sink base URL trailing slash", () => {
  const baseUrl = normalizeScmdbSinkBaseUrl("https://example.org/v1/scmdb/");
  assert.equal(baseUrl, "https://example.org/v1/scmdb");
  assert.equal(scmdbSinkUrl(baseUrl, "sink-token"), "https://example.org/v1/scmdb/sink-token");
});

test("disables SCMDB sync when the sink URL is absent, blank, or invalid", () => {
  for (const value of [undefined, "", "   ", "example.org/v1/scmdb", "ftp://example.org/v1/scmdb", "not a url"]) {
    assert.equal(normalizeScmdbSinkBaseUrl(value), null);
  }
  assert.equal(scmdbSinkUrl(null, "sink-token"), null);
});

test("supports explicit DEV, Production, self-hosted, and local SCMDB URLs", () => {
  for (const value of [
    "https://dev.example.org/v1/scmdb",
    "https://production.example.org/v1/scmdb",
    "https://verselink.example.org/v1/scmdb",
    "http://192.168.1.2:3001/v1/scmdb"
  ]) assert.equal(normalizeScmdbSinkBaseUrl(value), value);
});
