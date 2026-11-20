import { randomBytes } from "node:crypto";
import { normalizeUserCode, safeEqualHex } from "./tokens.js";
import { parseVersekitForm, readVersekitForm, rejectUnreadVersekitRequest } from "./request-form.js";

const LABELS = Object.freeze({
  "stock:read": "View organization stock.",
  "stock:write": "Create or update organization stock.",
  "blueprints:read": "View organization blueprints.",
  "blueprints:write": "Create or update organization blueprints.",
  "orders:read": "View organization orders.",
  "orders:write": "Report deliveries to organization orders."
});

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);

const pageFrame = (content) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>VerseKit authorization · VerseLink</title><link rel="stylesheet" href="/device-consent.css"></head><body><div class="authorization-shell"><header class="brand-header"><a class="brand" href="/mobiglass" aria-label="VerseLink home"><span class="brand-mark" aria-hidden="true"></span><span class="brand-copy"><strong>VERSE<span>LINK</span></strong><small>MOBIGLASS AUTHORIZATION</small></span></a><div class="header-status"><span class="status-dot" aria-hidden="true"></span><span>SECURE DEVICE LINK</span></div></header><main class="authorization-main">${content}</main><footer class="page-footer"><span>VERSELINK</span><span>DEVICE AUTHORIZATION</span></footer></div></body></html>`;

const PAGE_HEADERS = Object.freeze({
  "content-type": "text/html; charset=utf-8", "cache-control": "no-store", pragma: "no-cache",
  "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "same-origin",
  "content-security-policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
});

const sendPage = (res, status, content, extraHeaders = {}) => {
  res.writeHead(status, { ...PAGE_HEADERS, ...extraHeaders });
  res.end(pageFrame(content));
};

const stateHeading = (eyebrow, title, description = "") => `<header class="state-heading"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1>${description ? `<p class="state-description">${description}</p>` : ""}</header>`;
const detail = (label, value) => `<div class="identity-detail"><span>${label}</span><strong>${value}</strong></div>`;

const identityPanel = (groupName, memberName = null) => `<section class="identity-panel" aria-label="Authorization identity">${detail("AUTHORIZATION PROVIDER", "VerseLink")}${detail("ORGANIZATION", escapeHtml(groupName))}${memberName ? detail("SIGNED IN AS", escapeHtml(memberName)) : ""}</section>`;

const errorPage = (res, message, status = 400) => sendPage(res, status, `<section class="state-card state-error" role="alert">${stateHeading("AUTHORIZATION INTERRUPTED", "Request could not be completed", "VerseLink could not complete this device authorization request.")}<p class="error-copy">${escapeHtml(message)}</p><p class="support-copy">Return to VerseKit and try again, or close this page.</p></section>`);

const parserErrorPage = (status) => {
  const message = status === 413 ? "This form is larger than expected." : status === 408 ? "The form took too long to arrive." : "The form could not be read.";
  return pageFrame(`<section class="state-card state-error" role="alert">${stateHeading("AUTHORIZATION INTERRUPTED", "Request could not be completed", "VerseLink could not read this device authorization form.")}<p class="error-copy">${message}</p><p class="support-copy">Reload the authorization page and try again.</p></section>`);
};

const readForm = async (req, res, deadlineMs) => {
  const result = await readVersekitForm(req, res, { mode: "html", allowRepeatedScope: true, deadlineMs, htmlResponse: parserErrorPage, htmlHeaders: PAGE_HEADERS });
  if (result.responded || result.error) return result;
  const values = parseVersekitForm(result.body, { allowRepeatedScope: true });
  if (!values) return null;
  return { get: (key) => values.get(key), getAll: (key) => key === "scope" ? (values.get(key) || []) : (values.has(key) ? [values.get(key)] : []) };
};

export const createConsentHandlers = ({ context, tokenStore, codec, getSessionContext, getCurrentAppUser, getSessionToken, sameOrigin, lookupLimiter, requestBodyDeadlineMs }) => {
  const getIdentity = async (req) => {
    const sessionToken = await getSessionToken(req);
    if (typeof sessionToken !== "string" || !/^[A-Za-z0-9_-]{32,}$/.test(sessionToken)) return null;
    const session = await getSessionContext(req);
    if (!session?.appUserId) return null;
    const user = await getCurrentAppUser(req);
    if (!user || user.id !== session.appUserId || user.account_status !== "active") return null;
    const sessionHash = codec.hash("browser_session", sessionToken);
    const member = await tokenStore.db.query("SELECT 1 FROM app_users u JOIN group_members gm ON gm.app_user_id=u.id JOIN blueprint_groups g ON g.id=gm.group_id WHERE u.id=$1 AND gm.group_id=$2 AND u.account_status='active'", [user.id, context.groupId]);
    if (!member.rowCount) return null;
    return { userId: user.id, name: user.display_name || user.verselink_name || "VerseLink member", sessionHash };
  };
  const sign = (claims) => {
    const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + 10 * 60_000, nonce: randomBytes(24).toString("base64url") })).toString("base64url");
    return `${payload}.${codec.hash("csrf", payload)}`;
  };
  const verify = (token, identity, target) => {
    if (typeof token !== "string" || token.length > 2048) return null;
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra || !safeEqualHex(codec.hash("csrf", payload), signature)) return null;
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (!claims || claims.exp <= Date.now() || claims.session !== identity.sessionHash || claims.target !== target || typeof claims.nonce !== "string") return null;
      return claims;
    } catch { return null; }
  };
  const csrfFor = (identity, target) => sign({ session: identity.sessionHash, target });

  const handler = async (req, res, url) => {
    if (url.pathname !== "/device") return false;
    if (url.search) return rejectUnreadVersekitRequest(req, res, () => errorPage(res, "This request could not be processed."));
    if (req.method === "GET") {
      let identity;
      try { identity = await getIdentity(req); } catch { return rejectUnreadVersekitRequest(req, res, () => errorPage(res, "VerseLink could not verify your account. Please try again.", 503)); }
      if (!identity) return sendPage(res, 200, `<section class="state-card state-login">${stateHeading("SIGN-IN REQUIRED", "Sign in to continue", "An active VerseLink member session is required to authorize VerseKit for this organization.")}${identityPanel(context.groupName)}<div class="provider-panel"><span class="panel-label">REQUESTING APPLICATION</span><strong>VerseKit</strong><p>VerseLink will ask you to review each requested permission before access is granted.</p></div><a class="button button-primary" href="/login">Log in to VerseLink</a></section>`);
      const target = "lookup";
      return sendPage(res, 200, `<section class="state-card state-code">${stateHeading("DEVICE AUTHORIZATION", "Connect VerseKit", "Enter the one-time user code shown in your VerseKit desktop client. You will review its requested permissions before deciding.")}${identityPanel(context.groupName, identity.name)}<div class="provider-panel"><span class="panel-label">REQUESTING APPLICATION</span><strong>VerseKit</strong><p>Access is limited to the permissions you choose for this organization.</p></div><form method="post" action="/device" class="code-form"><input type="hidden" name="action" value="lookup"><input type="hidden" name="csrf" value="${csrfFor(identity, target)}"><label for="user_code">VerseKit user code</label><input id="user_code" name="user_code" type="text" maxlength="11" autocomplete="off" autocapitalize="characters" spellcheck="false" required><button class="button button-primary" type="submit">Review request</button></form></section>`);
    }
    if (req.method !== "POST") { rejectUnreadVersekitRequest(req, res, () => sendPage(res, 405, `<section class="state-card state-error" role="alert">${stateHeading("UNSUPPORTED REQUEST", "Method not allowed", "Use the device authorization page in your browser.")}</section>`, { allow: "GET, POST" })); return true; }
    if (!sameOrigin(req)) return rejectUnreadVersekitRequest(req, res, () => errorPage(res, "This request could not be verified. Reload the page and try again.", 403));
    const rate = lookupLimiter.consume(req.socket?.remoteAddress || "unknown");
    if (!rate.allowed) return rejectUnreadVersekitRequest(req, res, () => errorPage(res, "Too many attempts. Please wait before trying again.", 429));
    const form = await readForm(req, res, requestBodyDeadlineMs);
    if (form?.responded) return true;
    if (!form) return errorPage(res, "This request could not be processed.");
    let identity;
    try { identity = await getIdentity(req); } catch { return errorPage(res, "VerseLink could not verify your account. Please try again.", 503); }
    if (!identity) return errorPage(res, "Please log in to VerseLink and start again.", 401);
    const action = form.get("action");
    if (action === "lookup") {
      if (!verify(form.get("csrf"), identity, "lookup")) return errorPage(res, "This request expired or could not be verified. Reload the page and try again.", 403);
      const userCode = normalizeUserCode(form.get("user_code"));
      if (!userCode) return errorPage(res, "That code is invalid or no longer available.");
      let approval;
      try { approval = await tokenStore.createConsentChallenge({ userCode, userId: identity.userId, sessionHash: identity.sessionHash }); }
      catch { return errorPage(res, "VerseKit could not verify this request. Please try again.", 503); }
      if (!approval) return errorPage(res, "That code is invalid or no longer available.");
      const target = codec.hash("csrf_target", approval.challenge);
      const scopeHtml = approval.scopes.map((scope) => `<li class="permission-card"><div class="permission-copy"><code>${escapeHtml(scope)}</code><p>${escapeHtml(LABELS[scope] || "Access to the requested capability.")}</p></div><label class="permission-choice"><input type="checkbox" name="scope" value="${escapeHtml(scope)}"><span>Allow ${escapeHtml(scope)}</span></label></li>`).join("");
      return sendPage(res, 200, `<section class="state-card state-review">${stateHeading("PERMISSION REVIEW", "Review VerseKit access", "VerseLink is the authorization provider. VerseKit is requesting access to specific data in this organization.")}${identityPanel(context.groupName, identity.name)}<section class="provider-panel" aria-label="Request details"><span class="panel-label">REQUESTING APPLICATION</span><strong>VerseKit</strong><p>Requesting application: <strong>VerseKit</strong>. Only the permissions selected below will be approved for this organization.</p></section><form method="post" action="/device" class="review-form"><input type="hidden" name="action" value="approve"><input type="hidden" name="challenge" value="${escapeHtml(approval.challenge)}"><input type="hidden" name="csrf" value="${csrfFor(identity, target)}"><fieldset class="permission-fieldset"><legend>Requested permissions</legend><p id="permissions-note" class="support-copy">Select each permission you want VerseKit to receive. None are selected automatically.</p><ul class="permission-list" aria-describedby="permissions-note">${scopeHtml}</ul></fieldset><button class="button button-primary" type="submit">Approve selected permissions</button></form><form method="post" action="/device" class="deny-form"><input type="hidden" name="action" value="deny"><input type="hidden" name="challenge" value="${escapeHtml(approval.challenge)}"><input type="hidden" name="csrf" value="${csrfFor(identity, target)}"><button class="button button-deny" type="submit">Deny request</button></form></section>`);
    }
    if (action === "approve" || action === "deny") {
      const challenge = form.get("challenge") || "";
      const target = codec.hash("csrf_target", challenge);
      if (!verify(form.get("csrf"), identity, target)) return errorPage(res, "This request expired or could not be verified. Reload the page and try again.", 403);
      const scopes = form.getAll("scope");
      if (scopes.some((scope) => !tokenStore.operationalScopes.includes(scope)) || (action === "deny" && scopes.length)) return errorPage(res, "This request could not be processed.");
      let decided;
      try { decided = await tokenStore.decideConsent({ challenge, userId: identity.userId, sessionHash: identity.sessionHash, scopes: action === "approve" ? scopes : [], approve: action === "approve" }); }
      catch { return errorPage(res, "VerseKit could not save your decision. Please try again.", 503); }
      if (!decided) return errorPage(res, "This request is no longer available or your authorization changed. Return to VerseKit and try again.", 400);
      const approved = action === "approve";
      return sendPage(res, 200, `<section class="state-card state-result ${approved ? "state-success" : "state-denied"}" role="status">${stateHeading(approved ? "AUTHORIZATION SAVED" : "REQUEST DECLINED", approved ? "VerseKit access approved" : "VerseKit access denied", approved ? "Your decision was saved for this VerseLink organization." : "Your decision was saved. No tokens were issued.")}<div class="result-indicator"><span aria-hidden="true">${approved ? "✓" : "×"}</span><strong>${approved ? "APPROVED" : "DENIED"}</strong></div><p>${approved ? "Return to the VerseKit desktop client to continue." : "VerseKit will not receive access to this request."}</p></section>`);
    }
    return errorPage(res, "This request could not be processed.");
  };
  return handler;
};
