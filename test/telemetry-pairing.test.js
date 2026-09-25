import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CROCKFORD_ALPHABET,
  DEFAULT_DEVICE_NAME,
  encodePairingCode,
  formatPairingCode,
  generateDeviceCredential,
  hashDeviceCredential,
  hashPairingCode,
  normalizeDeviceName,
  normalizePairingCode
} from "../src/telemetry-pairing.js";

test("pairing code encodes the exact 80 input bits as sixteen Crockford symbols", async () => {
  const bytes = Buffer.from("00010203040506070809", "hex");
  const canonical = encodePairingCode(bytes);
  assert.equal(canonical, "000G40R40M30E209");
  assert.equal(canonical.length, 16);
  assert.ok([...canonical].every((character) => CROCKFORD_ALPHABET.includes(character)));
  assert.equal(formatPairingCode(canonical), "000G-40R4-0M30-E209");
  const source = await readFile(new URL("../src/telemetry-pairing.js", import.meta.url), "utf8");
  assert.match(source, /random\s*=\s*randomBytes/);
  assert.match(source, /encodePairingCode\(random\(10\)\)/);
  assert.doesNotMatch(source, /random\([^)]*\)\s*%\s*32/);
});

test("pairing normalization accepts only the documented ASCII separators and case", () => {
  for (const value of ["7K3M-9D2F-6R8W-1Q5C", "7k3m9d2f6r8w1q5c", "7K3M 9D2F 6R8W 1Q5C", "7K3M\t9D2F\r6R8W\n1Q5C"]) {
    assert.equal(normalizePairingCode(value), "7K3M9D2F6R8W1Q5C");
  }
  for (const value of ["7K3M-9D2F-6R8W-1Q5O", "7K3M-9D2F-6R8W-1Q5I", "7K3M-9D2F-6R8W-1Q5L", "7K3M–9D2F-6R8W-1Q5C", "7K3M 9D2F 6R8W 1Q5C", "7K3M!9D2F6R8W1Q5C", "7K3M9D2F6R8W1Q5", 123]) {
    assert.equal(normalizePairingCode(value), null, JSON.stringify(value));
  }
});

test("pairing HMAC uses the exact domain once and only the canonical code", () => {
  const pepper = "test-pepper";
  const canonical = normalizePairingCode("7K3M-9D2F-6R8W-1Q5C");
  const expected = createHmac("sha256", pepper).update("verselink-telemetry-pairing:7K3M9D2F6R8W1Q5C").digest("hex");
  assert.equal(hashPairingCode(pepper, canonical), expected);
  assert.equal(hashPairingCode(pepper, canonical).length, 64);
});

test("device credentials use 32 random bytes and the exact device HMAC domain", () => {
  const credential = generateDeviceCredential(() => Buffer.alloc(32));
  assert.match(credential, /^vlt_[A-Za-z0-9_-]{43}$/);
  const pepper = "test-pepper";
  const expected = createHmac("sha256", pepper).update(`verselink-telemetry-device:${credential}`).digest("hex");
  assert.equal(hashDeviceCredential(pepper, credential), expected);
  assert.equal(hashDeviceCredential(pepper, credential).length, 64);
});

test("device names default, trim Unicode White_Space, and count code points", () => {
  assert.equal(normalizeDeviceName(undefined), DEFAULT_DEVICE_NAME);
  assert.equal(normalizeDeviceName("\u00a0 Gaming PC \u2003"), "Gaming PC");
  assert.equal(normalizeDeviceName("🚀".repeat(64)), "🚀".repeat(64));
  assert.equal(normalizeDeviceName("🚀".repeat(65)), null);
  assert.equal(normalizeDeviceName(" \t\n "), null);
  assert.equal(normalizeDeviceName(42), null);
  assert.equal(normalizeDeviceName("bad\ud800name"), null);
  assert.equal(normalizeDeviceName("bad\udc00name"), null);
});
