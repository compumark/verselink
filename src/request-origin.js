export const createOriginChecker = (configuredAppUrl, { requireOrigin = false, exactOrigin = false } = {}) => {
  let expectedOrigin = null;
  try { expectedOrigin = new URL(configuredAppUrl).origin; } catch {}

  return (request) => {
    const origin = request?.headers?.origin;
    if (typeof origin !== "string" || origin.length === 0) return !requireOrigin;
    if (!expectedOrigin) return false;
    try {
      const parsed = new URL(origin);
      return parsed.origin === expectedOrigin && (!exactOrigin || origin === parsed.origin);
    } catch { return false; }
  };
};
