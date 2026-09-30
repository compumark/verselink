export const TELEMETRY_HISTORY_CLEANUP_BATCH_SIZE = 500;

export const cleanupExpiredTelemetryHistory = async (db, batchSize = TELEMETRY_HISTORY_CLEANUP_BATCH_SIZE) => {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > TELEMETRY_HISTORY_CLEANUP_BATCH_SIZE) {
    throw new RangeError("invalid telemetry history cleanup batch size");
  }
  const result = await db.query(
    `WITH expired AS (
       SELECT id
       FROM telemetry_presence_history
       WHERE received_at < clock_timestamp() - interval '90 days'
       ORDER BY received_at,id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM telemetry_presence_history history
     USING expired
     WHERE history.id=expired.id
     RETURNING history.id`,
    [batchSize]
  );
  return result.rowCount;
};

export const createTelemetryHistoryCleanupRunner = ({ db, logger, batchSize = TELEMETRY_HISTORY_CLEANUP_BATCH_SIZE }) => {
  let running = false;
  return async () => {
    if (running) return { status: "already_running", removed: 0 };
    running = true;
    try {
      const removed = await cleanupExpiredTelemetryHistory(db, batchSize);
      logger?.info("telemetry.history.cleanup", { removed });
      return { status: "complete", removed };
    } catch {
      logger?.warn("telemetry.history.cleanup.failed", { reason: "database_unavailable" });
      return { status: "failed", removed: 0 };
    } finally {
      running = false;
    }
  };
};
