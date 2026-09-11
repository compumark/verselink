import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export const LOG_LEVELS = Object.freeze(["ERROR", "WARN", "INFO", "DEBUG"]);
const levelIndex = (value) => LOG_LEVELS.indexOf(String(value || "").toUpperCase());
export const normalizeLogLevel = (value) => levelIndex(value) >= 0 ? String(value).toUpperCase() : "INFO";

const secretKey = /password|authorization|cookie|token|secret|database_url|sink_token_pepper|webhook|uex_api/i;
const secretValue = /\bvl_[A-Za-z0-9_-]{20,}\b|\b(?:Bearer\s+)?[A-Za-z0-9_-]{32,}\b|(?:postgres(?:ql)?:\/\/)[^\s"']+/gi;
export const redact = (value, depth = 0) => {
  if (depth > 6) return "[truncated]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return redact({ message: value.message, stack: value.stack }, depth + 1);
  if (typeof value === "string") return value.replace(secretValue, "[redacted]").replace(/[\r\n\t]/g, " ").slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key, secretKey.test(key) ? "[redacted]" : redact(item, depth + 1)]));
  return redact(String(value), depth + 1);
};

export const createLogger = ({ logDirectory = process.env.LOG_DIR || "/app/logs", defaultLevel = process.env.LOG_LEVEL, retentionDays = process.env.LOG_RETENTION_DAYS, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) => {
  const parsedRetention = Number(retentionDays);
  const retention = Number.isInteger(parsedRetention) && parsedRetention > 0 ? parsedRetention : 30;
  const state = { defaultLevel: normalizeLogLevel(defaultLevel), runtimeOverride: null, resetAt: null, timer: null };
  const effectiveLevel = () => state.runtimeOverride || state.defaultLevel;
  const enabled = (level) => levelIndex(level) <= levelIndex(effectiveLevel());
  const fallback = (message) => { try { process.stderr.write(`[verselink logger] ${redact(message)}\n`); } catch {} };
  const write = async (filePrefix, record) => {
    try {
      await mkdir(logDirectory, { recursive: true });
      const date = new Date(now()).toISOString().slice(0, 10);
      await appendFile(join(logDirectory, `${filePrefix}-${date}.log`), `${JSON.stringify(redact(record))}\n`, "utf8");
    } catch (error) { fallback(`write failed: ${error?.message || "unknown"}`); }
  };
  const record = (level, type, event, details = {}, context = {}) => {
    const normalized = normalizeLogLevel(level);
    if (!enabled(normalized)) return false;
    const entry = { timestamp: new Date(now()).toISOString(), level: normalized, type, ...(event ? { event } : {}), ...(context.request_id ? { request_id: context.request_id } : {}), ...(context.user_id ? { user_id: context.user_id } : {}), ...(context.user ? { user: context.user } : {}), ...(details && Object.keys(details).length ? { details } : {}) };
    void write("verselink", entry);
    return true;
  };
  const clearOverride = (context = {}, automatic = false) => {
    const previousLevel = effectiveLevel();
    if (state.timer) clearTimer(state.timer);
    state.timer = null; state.runtimeOverride = null; state.resetAt = null;
    record("WARN", "SECURITY", automatic ? "admin.log_level.auto_reset" : "admin.log_level.reset", { previous_level: previousLevel, new_level: state.defaultLevel }, context);
  };
  const setRuntimeOverride = (level, minutes, context = {}) => {
    const normalized = String(level || "").toUpperCase();
    if (!LOG_LEVELS.includes(normalized)) throw new Error("invalid log level");
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 240) throw new Error("invalid reset duration");
    const previousLevel = effectiveLevel();
    if (state.timer) clearTimer(state.timer);
    state.runtimeOverride = normalized;
    state.resetAt = new Date(now() + minutes * 60_000).toISOString();
    state.timer = setTimer(() => clearOverride({}, true), minutes * 60_000);
    record("WARN", "SECURITY", "admin.log_level.changed", { previous_level: previousLevel, new_level: normalized, reset_after_minutes: minutes }, context);
    return getState();
  };
  const getState = () => ({ default_level: state.defaultLevel, effective_level: effectiveLevel(), runtime_override: Boolean(state.runtimeOverride), reset_after_minutes: state.runtimeOverride ? Math.max(1, Math.ceil((new Date(state.resetAt).getTime() - now()) / 60_000)) : null, reset_at: state.resetAt, log_directory: logDirectory, retention_days: retention });
  const cleanupRetention = async () => {
    try {
      await mkdir(logDirectory, { recursive: true });
      const cutoff = new Date(now() - retention * 86_400_000).toISOString().slice(0, 10);
      const files = await readdir(logDirectory);
      await Promise.all(files.filter((file) => /^(access|verselink)-\d{4}-\d{2}-\d{2}\.log$/.test(file) && file.slice(-14, -4) < cutoff).map(async (file) => {
        const target = join(logDirectory, file); const metadata = await stat(target); if (metadata.isFile()) await unlink(target);
      }));
    } catch (error) { fallback(`retention cleanup failed: ${error?.message || "unknown"}`); }
  };
  return {
    getState, setRuntimeOverride, resetRuntimeOverride: (context) => clearOverride(context, false), cleanupRetention, isEnabled: enabled,
    error: (event, error, context = {}, details = {}) => record("ERROR", "ERROR", event, { ...details, error: error?.message || error, stack: error?.stack }, context),
    warn: (event, details = {}, context = {}) => record("WARN", "WARN", event, details, context),
    info: (event, details = {}, context = {}) => record("INFO", "EVENT", event, details, context),
    debug: (event, details = {}, context = {}) => record("DEBUG", "SYSTEM", event, details, context),
    security: (event, details = {}, context = {}) => record("WARN", "SECURITY", event, details, context),
    access: (entry, level = "INFO") => { if (!enabled(level)) return false; void write("access", { timestamp: new Date(now()).toISOString(), level: normalizeLogLevel(level), type: "HTTP", ...entry }); return true; }
  };
};
