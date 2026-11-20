import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXYZ";
const TOKEN_PREFIX = /^[a-z][a-z0-9]{1,15}$/;

export const createTokenCodec = (tokenPepper) => {
  if (typeof tokenPepper !== "string" || Buffer.byteLength(tokenPepper, "utf8") < 32) {
    throw new Error("VerseKit token pepper must contain at least 32 bytes");
  }
  const hash = (purpose, value) => {
    if (typeof purpose !== "string" || !/^[a-z_]{1,32}$/.test(purpose)) throw new Error("Invalid token purpose");
    if (typeof value !== "string" || value.length < 1 || value.length > 512) throw new Error("Invalid token value");
    return createHmac("sha256", tokenPepper).update(`versekit:${purpose}:`).update(value, "utf8").digest("hex");
  };
  const issue = (prefix) => {
    if (!TOKEN_PREFIX.test(prefix)) throw new Error("Invalid token prefix");
    return `${prefix}_${randomBytes(32).toString("base64url")}`;
  };
  return Object.freeze({ hash, issue });
};

const randomCodeChars = (length) => {
  let result = "";
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  while (result.length < length) {
    for (const byte of randomBytes(Math.max(16, length - result.length))) {
      if (byte >= limit) continue;
      result += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (result.length === length) break;
    }
  }
  return result;
};

// Ten alphabet symbols provide about 43 bits; the separator is presentation only.
export const newUserCode = () => {
  const chars = randomCodeChars(10);
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
};

export const normalizeUserCode = (value) => {
  if (typeof value !== "string") return null;
  const normalized = value.toUpperCase().replaceAll("-", "");
  return /^[BCDFGHJKLMNPQRSTVWXYZ]{10}$/.test(normalized)
    ? `${normalized.slice(0, 5)}-${normalized.slice(5)}`
    : null;
};

export const safeEqualHex = (left, right) => {
  if (typeof left !== "string" || typeof right !== "string" || !/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};

export const oauthJson = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", pragma: "no-cache", ...headers });
  res.end(JSON.stringify(body));
};
