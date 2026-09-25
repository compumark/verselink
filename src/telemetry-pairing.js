import { createHmac, randomBytes } from "node:crypto";

export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const DEFAULT_DEVICE_NAME = "Telemetry device";

export const encodePairingCode = (bytes) => {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 10) throw new TypeError("pairing code input must be exactly 10 bytes");
  let buffer = 0;
  let bits = 0;
  let encoded = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += CROCKFORD_ALPHABET[(buffer >> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  return encoded;
};

export const formatPairingCode = (canonicalCode) => {
  if (typeof canonicalCode !== "string" || !/^[0-9A-HJKMNP-TV-Z]{16}$/.test(canonicalCode)) throw new TypeError("invalid canonical pairing code");
  return canonicalCode.match(/.{4}/g).join("-");
};

export const generatePairingCode = (random = randomBytes) => formatPairingCode(encodePairingCode(random(10)));

export const normalizePairingCode = (value) => {
  if (typeof value !== "string") return null;
  const canonical = value.replace(/[\x20\t\r\n-]/g, "").replace(/[a-z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) - 32));
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(canonical) ? canonical : null;
};

export const hashPairingCode = (pepper, canonicalCode) => createHmac("sha256", pepper).update(`verselink-telemetry-pairing:${canonicalCode}`, "utf8").digest("hex");

export const generateDeviceCredential = (random = randomBytes) => `vlt_${random(32).toString("base64url")}`;

export const hashDeviceCredential = (pepper, credential) => createHmac("sha256", pepper).update(`verselink-telemetry-device:${credential}`, "utf8").digest("hex");

const hasUnpairedSurrogate = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
};

export const normalizeDeviceName = (value) => {
  if (value === undefined) return DEFAULT_DEVICE_NAME;
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) return null;
  const normalized = value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
  const codePoints = [...normalized].length;
  return codePoints > 0 && codePoints <= 64 ? normalized : null;
};
