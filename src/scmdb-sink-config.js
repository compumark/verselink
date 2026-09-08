export const normalizeScmdbSinkBaseUrl = (value) => {
  const configured = String(value || "").trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash) return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
};

export const scmdbSinkUrl = (baseUrl, token) => baseUrl ? `${baseUrl}/${token}` : null;
