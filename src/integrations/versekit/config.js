import { isIP } from "node:net";
import { domainToASCII } from "node:url";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalidOrigin = () => new Error("VERSEKIT_PUBLIC_URL must be an absolute HTTPS origin");

const parseAuthority = (raw) => {
  // Inspect the original authority: URL parsing normalizes empty ports and legacy IPv4 forms.
  const match = /^https:\/\/([^/?#]+)\/?$/.exec(raw);
  if (!match || /[\\\s%@]/u.test(match[1])) throw invalidOrigin();
  const authority = match[1];
  const parts = authority.startsWith("[")
    ? /^\[([^\]]+)\](?::([0-9]+))?$/.exec(authority)
    : /^([^:]+)(?::([0-9]+))?$/.exec(authority);
  if (!parts) throw invalidOrigin();
  const [, host, port] = parts;
  if (port !== undefined && (!/^[1-9][0-9]*$/.test(port) || Number(port) > 65535)) throw invalidOrigin();
  if (authority.startsWith("[")) {
    if (isIP(host) !== 6) throw invalidOrigin();
  } else if (!/^[\p{L}\p{N}\p{M}.-]+$/u.test(host) || host.endsWith(".")) {
    throw invalidOrigin();
  }
  return { host, ipv6: authority.startsWith("[") };
};

export const versekitRequested = (env) => env.VERSEKIT_ENABLED === "true";

export const parseVersekitConfig = (env) => {
  if (!versekitRequested(env)) return null;
  const groupId = env.VERSEKIT_GROUP_ID;
  if (typeof groupId !== "string" || !UUID.test(groupId)) throw new Error("VERSEKIT_GROUP_ID must be one existing UUID");
  const raw = env.VERSEKIT_PUBLIC_URL;
  if (typeof raw !== "string") throw invalidOrigin();
  const authority = parseAuthority(raw);
  let url;
  try { url = new URL(raw); } catch { throw invalidOrigin(); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw invalidOrigin();
  if (authority.ipv6) {
    if (isIP(url.hostname.slice(1, -1)) !== 6) throw invalidOrigin();
  } else if (isIP(url.hostname) === 4) {
    // A conventional dotted quad is the only accepted IPv4 spelling.
    const octet = "(?:0|[1-9][0-9]{0,2})";
    if (!new RegExp(`^${octet}(?:\\.${octet}){3}$`).test(authority.host)
      || isIP(authority.host) !== 4 || authority.host !== url.hostname) throw invalidOrigin();
  } else {
    const ascii = domainToASCII(authority.host);
    const dnsHost = /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.[a-z0-9-]+)*$/i.test(ascii)
      && ascii.split(".").every((label) => label.length <= 63 && !label.endsWith("-"));
    if (!dnsHost || url.hostname !== ascii) throw invalidOrigin();
  }
  return Object.freeze({ groupId: groupId.toLowerCase(), publicOrigin: url.origin });
};
