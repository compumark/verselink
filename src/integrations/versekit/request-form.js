export const VERSEKIT_FORM_BODY_LIMIT = 8 * 1024;
export const VERSEKIT_FORM_BODY_DEADLINE_MS = 10_000;

export const rejectUnreadVersekitRequest = (req, res, writeResponse) => {
  const socket = req.socket;
  try { req.pause?.(); } catch { socket?.destroy?.(); return; }
  if (res.destroyed || res.writableEnded || socket?.destroyed) return;
  if (res.headersSent) { socket?.destroy(); return; }

  let settled = false;
  let fallback;
  const cleanup = () => {
    if (settled) return;
    settled = true;
    clearTimeout(fallback);
    res.off("finish", onFinish);
    res.off("close", onClose);
    res.off("error", onError);
  };
  const onFinish = () => {
    cleanup();
    if (socket && !socket.destroyed) {
      if (typeof socket.destroySoon === "function") socket.destroySoon();
      else socket.end();
    }
  };
  const onClose = () => {
    const responseFlushed = res.writableFinished;
    cleanup();
    if (!responseFlushed && socket && !socket.destroyed) {
      if (typeof socket.destroy === "function") socket.destroy();
      else socket.end?.();
    }
  };
  const onError = () => {
    cleanup();
    if (socket && !socket.destroyed) {
      if (typeof socket.destroy === "function") socket.destroy();
      else socket.end?.();
    }
  };

  try {
    res.shouldKeepAlive = false;
    res.setHeader("connection", "close");
    res.once("finish", onFinish);
    res.once("close", onClose);
    res.once("error", onError);
    fallback = setTimeout(onError, 2_000);
    fallback.unref?.();
    writeResponse();
  } catch {
    onError();
    if (!res.destroyed && !res.writableEnded && socket && !socket.destroyed) {
      if (typeof socket.destroy === "function") socket.destroy();
      else socket.end?.();
    }
  }
};

const writeRejectedResponse = (req, res, mode, status) => {
  req.pause();
  const socket = req.socket;
  if (res.destroyed || res.writableEnded || socket?.destroyed) return;
  if (res.headersSent) { socket?.destroy(); return; }
  res.shouldKeepAlive = false;
  const html = mode === "html";
  const problem = mode === "problem";
  const responseStatus = problem ? 400 : status;
  const body = html
    ? `<!doctype html><html lang="en"><meta charset="utf-8"><title>VerseKit connection</title><p>Request rejected. Reload the page and try again.</p></html>`
    : problem
      ? JSON.stringify({ type: "about:blank", status: responseStatus, code: "INVALID_BODY" })
      : JSON.stringify({ error: status === 408 ? "temporarily_unavailable" : "invalid_request" });
  res.writeHead(responseStatus, {
    "content-type": html ? "text/html; charset=utf-8" : problem ? "application/problem+json; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
    "content-length": String(Buffer.byteLength(body))
  });
  const ignoreResponseError = () => {};
  res.once("error", ignoreResponseError);
  res.once("close", () => res.off("error", ignoreResponseError));
  // End the HTTP response first so its 413/408 can reach the client. destroySoon()
  // then closes the socket after queued response bytes flush; the unread upload is
  // never drained and the connection cannot be reused for another request.
  res.once("finish", () => {
    if (socket && !socket.destroyed) {
      if (typeof socket.destroySoon === "function") socket.destroySoon();
      else socket.end();
    }
  });
  res.end(body);
};

const readVersekitBody = (req, res, { mode, contentType, limit, deadlineMs }) => new Promise((resolve) => {
  let settled = false;
  let bytes = 0;
  const chunks = [];
  let timer;

  const clearReaders = (keepError = false) => {
    clearTimeout(timer);
    req.off("data", onData);
    req.off("end", onEnd);
    req.off("aborted", onAbort);
    if (!keepError) {
      req.off("error", onError);
      req.off("close", onClose);
    } else if (req.closed) {
      req.off("error", onError);
      req.off("close", onClose);
    } else {
      req.once("close", () => {
        req.off("error", onError);
        req.off("close", onClose);
      });
    }
  };
  const finish = (result, keepError = false) => {
    if (settled) return;
    settled = true;
    clearReaders(keepError);
    resolve(result);
  };
  const rejectAndClose = (reason, status) => {
    if (settled) return;
    settled = true;
    clearReaders(true);
    writeRejectedResponse(req, res, mode, status);
    resolve({ error: reason, responded: true });
  };
  const onData = (chunk) => {
    if (settled) return;
    bytes += chunk.length;
    if (bytes > limit) {
      rejectAndClose("too_large", 413);
      return;
    }
    chunks.push(chunk);
  };
  const onEnd = () => {
    if (settled) return;
    finish({ body: Buffer.concat(chunks).toString("utf8") });
  };
  const onAbort = () => {
    req.pause();
    if (!req.socket?.destroyed) req.socket?.destroy();
    finish({ error: "aborted", responded: true }, true);
  };
  const onError = () => finish({ error: "aborted", responded: true }, true);
  const onClose = () => {
    if (!req.complete) onAbort();
  };

  req.on("data", onData);
  req.once("end", onEnd);
  req.once("aborted", onAbort);
  req.once("error", onError);
  req.once("close", onClose);
  timer = setTimeout(() => rejectAndClose("timeout", 408), deadlineMs);
  timer.unref?.();

  const declaredLength = req.headers?.["content-length"];
  if (declaredLength !== undefined && Number(declaredLength) > limit) {
    rejectAndClose("too_large", 413);
    return;
  }
  if (!contentType.test(String(req.headers?.["content-type"] || ""))) {
    rejectAndClose("invalid_content_type", 400);
  }
});

export const readVersekitForm = (req, res, {
  mode = "oauth",
  limit = VERSEKIT_FORM_BODY_LIMIT,
  deadlineMs = VERSEKIT_FORM_BODY_DEADLINE_MS
} = {}) => {
  return readVersekitBody(req, res, {
    mode, limit, deadlineMs,
    contentType: /^application\/x-www-form-urlencoded(?:\s*;|$)/i
  });
};

export const readVersekitJson = (req, res, {
  limit = VERSEKIT_FORM_BODY_LIMIT,
  deadlineMs = VERSEKIT_FORM_BODY_DEADLINE_MS
} = {}) => readVersekitBody(req, res, {
  mode: "problem", limit, deadlineMs,
  contentType: /^application\/json(?:\s*;|$)/i
});

export const parseVersekitForm = (body, { allowRepeatedScope = false } = {}) => {
  const params = new URLSearchParams(body);
  const values = new Map();
  for (const [key, value] of params) {
    if (values.has(key) && !(allowRepeatedScope && key === "scope")) return null;
    if (allowRepeatedScope && key === "scope") values.set(key, [...(values.get(key) || []), value]);
    else values.set(key, value);
  }
  return values;
};
