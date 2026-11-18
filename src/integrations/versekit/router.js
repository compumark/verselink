import { rejectUnreadVersekitRequest } from "./request-form.js";

const CODES = new Set(["NOT_FOUND", "METHOD_NOT_ALLOWED", "MAINTENANCE", "INVALID_REQUEST", "UNAUTHORIZED", "RATE_LIMITED"]);

export const sendProblem = (res, status, code, extraHeaders = {}) => {
  if (!CODES.has(code)) throw new Error("Unsupported VerseKit problem code");
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/problem+json; charset=utf-8", "cache-control": "no-store", ...extraHeaders });
  res.end(JSON.stringify({ type: "about:blank", status, code }));
};

export const createVersekitRouter = ({ discovery = null, context = null } = {}) => {
  const state = Object.freeze({ discovery, context });
  return async (req, res, url) => {
  const path = url.pathname;
  const isDiscovery = path === "/.well-known/versekit-org.json";
  const reserved = isDiscovery || path === "/device" || path === "/versekit/v1" || path.startsWith("/versekit/v1/");
  if (!reserved) return false;
  try {
    if (!isDiscovery || !state.discovery) rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 404, "NOT_FOUND"));
    else if (req.method !== "GET") rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 405, "METHOD_NOT_ALLOWED", { allow: "GET" }));
    else if (url.search) rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 400, "INVALID_REQUEST"));
    else {
      const payload = JSON.stringify(state.discovery);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(payload);
    }
  } catch {
    if (res.headersSent) res.destroy?.();
    else rejectUnreadVersekitRequest(req, res, () => sendProblem(res, 503, "MAINTENANCE", { "retry-after": "30" }));
  }
  return true;
  };
};
