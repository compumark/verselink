export const TELEMETRY_AUTH_IN_FLIGHT_PER_PEER = 4;
export const TELEMETRY_AUTH_IN_FLIGHT_GLOBAL = 8;
export const TELEMETRY_AUTH_IN_FLIGHT_MAX_PEERS = 2048;

export const createTelemetryAuthInFlightLimiter = ({
  perPeerLimit = TELEMETRY_AUTH_IN_FLIGHT_PER_PEER,
  globalLimit = TELEMETRY_AUTH_IN_FLIGHT_GLOBAL,
  maxPeers = TELEMETRY_AUTH_IN_FLIGHT_MAX_PEERS
} = {}) => {
  if (![perPeerLimit, globalLimit, maxPeers].every((value) => Number.isInteger(value) && value > 0)) {
    throw new TypeError("invalid telemetry auth concurrency limits");
  }

  const activeByPeer = new Map();
  let activeTotal = 0;

  const tryAcquire = (peer) => {
    const key = String(peer || "unknown");
    const activeForPeer = activeByPeer.get(key) || 0;
    if (activeTotal >= globalLimit || activeForPeer >= perPeerLimit) return null;
    if (activeForPeer === 0 && activeByPeer.size >= maxPeers) return null;

    activeByPeer.set(key, activeForPeer + 1);
    activeTotal += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeTotal -= 1;
      const remainingForPeer = (activeByPeer.get(key) || 1) - 1;
      if (remainingForPeer === 0) activeByPeer.delete(key);
      else activeByPeer.set(key, remainingForPeer);
    };
  };

  return {
    tryAcquire,
    async run(peer, operation, onSaturated) {
      const release = tryAcquire(peer);
      if (!release) return onSaturated();
      try {
        return await operation();
      } finally {
        release();
      }
    },
    snapshot() {
      return { activeTotal, peerCount: activeByPeer.size };
    }
  };
};
