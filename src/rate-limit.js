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

export const clientKey = (req) => req.socket?.remoteAddress || "unknown";
