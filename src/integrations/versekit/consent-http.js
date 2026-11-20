import { randomBytes } from "node:crypto";
import { normalizeUserCode, safeEqualHex } from "./tokens.js";
import { parseVersekitForm, readVersekitForm, rejectUnreadVersekitRequest } from "./request-form.js";
const LABELS = Object.freeze({
  "stock:read": "View organization stock.",
  "stock:write": "Create or update organization stock.",
  "blueprints:read": "View organization blueprints.",
  "blueprints:write": "Create or update organization blueprints.",
  "orders:read": "View organization orders.",
  "orders:write": "Create or update organization orders."
});
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const sendPage = (res, status, content) => {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", pragma: "no-cache",
    "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "same-origin",
    "content-security-policy": "default-src 'none'; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>VerseKit connection · VerseLink</title><style>body{font:16px system-ui,sans-serif;background:#101722;color:#edf2f7;margin:0;padding:2rem}.card{max-width:38rem;margin:5vh auto;background:#1b2735;border:1px solid #34465b;border-radius:12px;padding:2rem}h1{font-size:1.5rem}p,li{line-height:1.55}.muted{color:#bdc9d8}label{display:block;margin:.8rem 0}input[type=text]{box-sizing:border-box;width:100%;padding:.8rem;font:inherit;letter-spacing:.12em}button,.button{display:inline-block;border:0;border-radius:6px;padding:.75rem 1rem;margin:.5rem .4rem .2rem 0;font:inherit;cursor:pointer;background:#72d1a2;color:#10231a}.deny{background:#d49a9a;color:#261111}code{font-size:1rem}</style></head><body><main class="card">${content}</main></body></html>`);
};
const errorPage = (res, message, status = 400) => sendPage(res, status, `<h1>VerseKit connection</h1><p>${escapeHtml(message)}</p><p class="muted">Return to VerseKit and try again, or close this page.</p>`);
const readForm = async (req, res, deadlineMs) => {
  const result = await readVersekitForm(req, res, { mode: "html", allowRepeatedScope: true, deadlineMs });
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
      if (!identity) return sendPage(res, 200, `<h1>Connect VerseKit to VerseLink</h1><p>A current VerseLink login is required to approve access.</p><a class="button" href="/login">Log in to VerseLink</a>`);
      const target = "lookup";
      return sendPage(res, 200, `<h1>Connect VerseKit</h1><p>Organization: <strong>${escapeHtml(context.groupName)}</strong></p><p>Signed in as <strong>${escapeHtml(identity.name)}</strong>.</p><p>Enter the user code shown in your VerseKit desktop client. You will review the requested permissions before deciding.</p><form method="post" action="/device"><input type="hidden" name="action" value="lookup"><input type="hidden" name="csrf" value="${csrfFor(identity, target)}"><label for="user_code">VerseKit user code</label><input id="user_code" name="user_code" type="text" maxlength="11" autocomplete="off" required><button type="submit">Review request</button></form>`);
    }
    if (req.method !== "POST") { rejectUnreadVersekitRequest(req, res, () => { res.writeHead(405, { allow: "GET, POST", "cache-control": "no-store" }); res.end(); }); return true; }
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
      const scopeHtml = approval.scopes.map((scope) => `<li><code>${escapeHtml(scope)}</code> — ${escapeHtml(LABELS[scope] || "Access to the requested capability.")}<br><label><input type="checkbox" name="scope" value="${escapeHtml(scope)}"> Allow this permission</label></li>`).join("");
      return sendPage(res, 200, `<h1>Review VerseKit access</h1><p>Organization: <strong>${escapeHtml(context.groupName)}</strong></p><p>VerseLink member: <strong>${escapeHtml(identity.name)}</strong></p><p>Requesting application: <strong>VerseKit</strong></p><p>Select only the permissions you approve. No permission is selected automatically.</p><form method="post" action="/device"><input type="hidden" name="action" value="approve"><input type="hidden" name="challenge" value="${escapeHtml(approval.challenge)}"><input type="hidden" name="csrf" value="${csrfFor(identity, target)}"><ul>${scopeHtml}</ul><button type="submit">Approve selected permissions</button></form><form method="post" action="/device"><input type="hidden" name="action" value="deny"><input type="hidden" name="challenge" value="${escapeHtml(approval.challenge)}"><input type="hidden" name="csrf" value="${csrfFor(identity, target)}"><button class="deny" type="submit">Deny</button></form>`);
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
      return sendPage(res, 200, `<h1>${action === "approve" ? "VerseKit access approved" : "VerseKit access denied"}</h1><p>${action === "approve" ? "Your decision was saved. Return to the VerseKit desktop client to continue." : "The request was denied. No tokens were issued."}</p>`);
    }
    return errorPage(res, "This request could not be processed.");
  };
  return handler;
};
