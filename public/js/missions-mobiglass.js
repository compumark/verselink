const styleId = 'missions-mobiglass-css';

const ensureStyles = () => {
  if (document.getElementById(styleId)) return;
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    .missions-shell{min-height:360px;padding:clamp(22px,4vw,42px);border:1px solid var(--border);background:linear-gradient(145deg,var(--panel),var(--panel2));color:var(--text);box-shadow:inset 0 0 32px var(--panel2),0 0 22px var(--glow)}
    .missions-shell h1{margin:7px 0 12px;color:var(--bright);font-size:clamp(22px,4vw,34px);letter-spacing:.12em}
    .missions-state{display:grid;place-items:center;min-height:230px;padding:28px;text-align:center;border:1px solid var(--border);background:var(--panel)}
    .missions-state strong{display:block;color:var(--accent);font-size:15px;letter-spacing:.14em}
    .missions-state p{max-width:480px;margin:14px auto 0;color:var(--muted);line-height:1.6}
    .missions-state button{margin-top:22px;padding:11px 16px;border:1px solid var(--accent);background:var(--panel2);color:var(--bright);font:inherit;letter-spacing:.1em;cursor:pointer}
    .missions-state button:hover,.missions-state button:focus-visible{background:var(--accent);color:var(--bg);outline:0;box-shadow:0 0 14px var(--glow)}
    .missions-loading-mark{width:44px;height:44px;margin-bottom:18px;border:1px solid var(--accent);border-radius:50%;box-shadow:0 0 16px var(--glow);position:relative}
    .missions-loading-mark:before,.missions-loading-mark:after{content:"";position:absolute;inset:9px;border:1px solid var(--border);border-radius:50%}.missions-loading-mark:after{inset:20px;border-color:var(--accent)}
    @media(max-width:680px){.missions-shell{min-height:330px;padding:22px 16px}.missions-state{min-height:220px;padding:22px 16px}.missions-state button{width:100%}}
  `;
  document.head.append(style);
};

const isCurrentView = () => location.hash === '#missions';
const shell = (state) => `<section class="missions-shell" aria-live="polite"><div class="eyebrow">MOBIGLASS APPLICATION</div><h1>MISSIONS</h1>${state}</section>`;
const loading = () => `<div class="missions-state" role="status"><div class="missions-loading-mark" aria-hidden="true"></div><div><strong>INITIALIZING MISSION SYSTEM...</strong><p>Validating VerseLink group context.</p></div></div>`;
const ready = () => `<div class="missions-state"><div><strong>MISSION SYSTEM READY</strong><p>Plan and coordinate objectives with your VerseLink groups.</p></div></div>`;
const empty = () => `<div class="missions-state"><div><strong>NO GROUPS AVAILABLE</strong><p>Missions belong to VerseLink groups. Create or join a group before planning a mission.</p><button type="button" data-missions-groups>OPEN GROUP MANAGEMENT</button></div></div>`;
const unavailable = () => `<div class="missions-state" role="alert"><div><strong>MISSION SYSTEM UNAVAILABLE</strong><p>Unable to load VerseLink group context.</p><button type="button" data-missions-retry>RETRY</button></div></div>`;

const render = (root, state) => {
  if (!root || !isCurrentView()) return false;
  root.innerHTML = shell(state);
  return true;
};

export async function mount(root = document.querySelector('#content')) {
  if (!root || !isCurrentView()) return;
  ensureStyles();
  if (!render(root, loading())) return;
  try {
    const response = await fetch('/api/groups');
    if (!isCurrentView()) return;
    if (response.status === 401) {
      location.hash = 'home';
      return;
    }
    if (!response.ok) throw new Error('group context unavailable');
    const body = await response.json();
    if (!isCurrentView()) return;
    if (!render(root, Array.isArray(body.groups) && body.groups.length ? ready() : empty())) return;
    root.querySelector('[data-missions-groups]')?.addEventListener('click', () => { location.hash = 'groups'; });
  } catch {
    if (!render(root, unavailable())) return;
    root.querySelector('[data-missions-retry]')?.addEventListener('click', () => { mount(root); });
  }
}
