export const VERSION_POLL_INTERVAL_MS = 60000;
export const VERSION_BACKOFF_MS = [60000, 120000, 240000, 300000];
export const normalizeDeploymentIdentity = value => {
  if (!value || typeof value !== "object") return null;
  const build = String(value.build ?? "").trim();
  if (!build || build.toLowerCase() === "unknown") return null;
  return { version: String(value.version ?? "").trim(), build };
};
export const isValidBuild = value => Boolean(normalizeDeploymentIdentity({ build: value }));
export const hasDeploymentChanged = (initial, current) => Boolean(initial?.build && current?.build && initial.build !== current.build);
export const getUpdateMessage = identity => identity?.version === "dev" ? "A new VerseLink development build is ready." : identity?.version && identity.version !== "unknown" ? `VerseLink ${identity.version} is ready.` : "A new VerseLink build is ready.";
export const updateUrlFor = (identity, currentUrl) => { const url = new URL(currentUrl); url.searchParams.set("build", identity.build); return url.href; };
let initialized = false;
export const initVersionWatch = () => {
  if (initialized) return; initialized = true;
  let baseline = null, timer = null, inFlight = false, failures = 0, updateShown = false;
  const stop = () => { if (timer !== null) { clearTimeout(timer); timer = null; } };
  const schedule = delay => { stop(); if (!document.hidden && navigator.onLine && !updateShown) timer = setTimeout(check, delay); };
  const showUpdate = identity => {
    if (updateShown) return; updateShown = true; stop();
    const style = document.createElement("style"); style.textContent = ".version-update{position:fixed;z-index:1000;left:50%;top:18px;transform:translateX(-50%);width:min(520px,calc(100vw - 32px));box-sizing:border-box;padding:22px 24px;border:1px solid var(--accent);background:var(--panel2);color:var(--text);box-shadow:0 0 24px var(--glow)}.version-update strong{display:block;color:var(--accent);font-size:11px;letter-spacing:.16em}.version-update h2{margin:12px 0 8px;color:var(--bright);font-size:20px;letter-spacing:.08em}.version-update p{margin:0 0 18px;color:var(--muted)}.version-update button{width:100%;padding:12px;border:1px solid var(--accent);background:var(--accent);color:var(--panel2);font:700 12px inherit;letter-spacing:.1em;cursor:pointer}@media(max-width:600px){.version-update{top:10px;padding:16px}.version-update h2{font-size:16px}}"; document.head.append(style);
    const box = document.createElement("section"); box.className = "version-update"; box.setAttribute("role", "status"); box.innerHTML = `<strong>SYSTEM UPDATE</strong><h2>NEW VERSION AVAILABLE</h2><p>${getUpdateMessage(identity)}<br>Reload VerseLink to apply the update.</p><button type="button">RELOAD VERSELINK</button>`; box.querySelector("button").onclick = () => window.location.assign(updateUrlFor(identity, window.location.href)); document.body.append(box);
  };
  async function check() {
    stop(); if (inFlight || document.hidden || !navigator.onLine || updateShown) return; inFlight = true;
    try { const response = await fetch("/api/version", { cache: "no-store" }); if (!response.ok) throw Error(); const identity = normalizeDeploymentIdentity(await response.json()); if (!identity) { failures++; schedule(VERSION_BACKOFF_MS[Math.min(failures - 1, 3)]); return; } failures = 0; if (!baseline) baseline = identity; else if (hasDeploymentChanged(baseline, identity)) showUpdate(identity); schedule(VERSION_POLL_INTERVAL_MS); } catch { failures++; schedule(VERSION_BACKOFF_MS[Math.min(failures - 1, 3)]); } finally { inFlight = false; }
  }
  document.addEventListener("visibilitychange", () => { stop(); if (!document.hidden) check(); }); window.addEventListener("offline", stop); window.addEventListener("online", check); check();
};
if (typeof window !== "undefined") initVersionWatch();
