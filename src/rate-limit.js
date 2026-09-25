export const createRateLimiter = ({ limit, windowMs, maxEntries = 10000, now = () => Date.now() }) => {
  const entries = new Map();

  const cleanup = (timestamp = now()) => {
    for (const [key, entry] of entries) if (entry.resetAt <= timestamp) entries.delete(key);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  };

  const getEntry = (key, timestamp = now()) => {
    cleanup(timestamp);
    const current = entries.get(key);
    if (!current || current.resetAt <= timestamp) {
      const entry = { failures: 0, resetAt: timestamp + windowMs };
      entries.set(key, entry);
      cleanup(timestamp);
      return entry;
    }
    return current;
  };

  return {
    allow(key, timestamp = now()) {
      return getEntry(String(key || "unknown"), timestamp).failures < limit;
    },
    recordFailure(key, timestamp = now()) {
      const entry = getEntry(String(key || "unknown"), timestamp);
      entry.failures += 1;
    },
    clear(key) {
      entries.delete(String(key || "unknown"));
    },
    cleanup,
    size: () => entries.size
  };
};

export const createRequestRateLimiter = ({ limit, windowMs, maxEntries = 10000, now = () => Date.now() }) => {
  if (!Number.isInteger(limit) || limit < 1 || !Number.isFinite(windowMs) || windowMs < 1 || !Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new TypeError("invalid request rate limiter configuration");
  }
  const entries = new Map();
  const cleanup = (timestamp = now()) => {
    for (const [key, entry] of entries) if (entry.resetAt <= timestamp) entries.delete(key);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  };
  return {
    consume(key, timestamp = now()) {
      cleanup(timestamp);
      const normalizedKey = String(key || "unknown");
      let entry = entries.get(normalizedKey);
      if (!entry || entry.resetAt <= timestamp) {
        entry = { count: 0, resetAt: timestamp + windowMs };
        entries.delete(normalizedKey);
        entries.set(normalizedKey, entry);
      } else {
        entries.delete(normalizedKey);
        entries.set(normalizedKey, entry);
      }
      const allowed = entry.count < limit;
      if (allowed) entry.count += 1;
      cleanup(timestamp);
      return {
        allowed,
        remaining: Math.max(0, limit - entry.count),
        resetAt: entry.resetAt,
        retryAfter: Math.max(0, Math.ceil((entry.resetAt - timestamp) / 1000))
      };
    },
    cleanup,
    size: () => entries.size
  };
};

export const clientKey = (req) => req.socket?.remoteAddress || "unknown";
