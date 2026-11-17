export const STANDARD_SCOPES = Object.freeze([
  "stock:read", "stock:write", "blueprints:read", "blueprints:write", "orders:read", "orders:write"
]);

// Only callers with implemented and tested handlers may supply operationalScopes.
// The running VK-02 adapter deliberately supplies none.
export const buildDiscovery = ({ publicOrigin, groupName, operationalScopes, tag }) => {
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new Error("VerseKit discovery requires a validated HTTPS origin"); }
  if (origin.protocol !== "https:" || origin.origin !== publicOrigin || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("VerseKit discovery requires a validated HTTPS origin");
  }
  if (typeof groupName !== "string" || !groupName.trim() || groupName.length > 80) throw new Error("VerseKit group name must contain 1–80 characters");
  if (!Array.isArray(operationalScopes) || !operationalScopes.length ||
      new Set(operationalScopes).size !== operationalScopes.length ||
      operationalScopes.some((scope) => !STANDARD_SCOPES.includes(scope))) {
    throw new Error("VerseKit discovery requires distinct operational standard scopes");
  }
  const org = { name: groupName.trim() };
  if (tag !== undefined) {
    if (typeof tag !== "string" || !tag.trim() || tag.length > 12) throw new Error("VerseKit tag must contain 1–12 characters");
    org.tag = tag.trim();
  }
  return {
    standard: "versekit-org", org,
    versions: { "1": {
      api_base: `${publicOrigin}/versekit/v1`,
      device_authorization_endpoint: `${publicOrigin}/versekit/v1/device/code`,
      token_endpoint: `${publicOrigin}/versekit/v1/token`,
      revocation_endpoint: `${publicOrigin}/versekit/v1/revoke`,
      verification_uri: `${publicOrigin}/device`,
      scopes_supported: [...operationalScopes]
    } }
  };
};
