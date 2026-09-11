import { copyText } from '/js/auth-core.js';
import '/js/profile-accent.js';

const profileThemeStyle=document.createElement('style');profileThemeStyle.textContent='.profile-link button,.profile-actions button[type=submit],.profile-service button.primary{padding:10px 14px;border:1px solid var(--border);background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 35%,transparent),color-mix(in srgb,var(--border) 35%,transparent))!important;border-color:var(--border)!important;color:var(--bright)!important;font:inherit;cursor:pointer}.profile-link button:hover,.profile-link button:focus-visible,.profile-actions button[type=submit]:hover,.profile-actions button:focus-visible,.profile-service button.primary:hover,.profile-service button.primary:focus-visible{background:var(--accent)!important;border-color:var(--bright)!important;color:var(--bg)!important;outline:0}.profile-appearance{margin-top:24px;padding-top:18px;border-top:1px solid var(--border)}.profile-appearance strong{color:var(--bright);letter-spacing:.12em}.profile-radio{display:flex;gap:8px;color:var(--text);font-size:12px}.profile-presets{display:flex;flex-wrap:wrap;gap:7px}.profile-presets button,.profile-appearance>#accent-reset{padding:8px 10px;border:1px solid var(--border);background:var(--panel2);color:var(--bright);cursor:pointer}.profile-presets button.selected,.profile-presets button:hover{border-color:var(--user-accent,var(--accent));color:var(--user-accent,var(--accent));box-shadow:0 0 9px color-mix(in srgb,var(--user-accent,var(--accent)) 35%,transparent)}.profile-color-row{display:flex;gap:8px;align-items:center}.profile-color-row input[type=color]{width:48px;height:42px;padding:3px;background:var(--panel2);border:1px solid var(--border)}.accent-preview{display:grid;gap:8px;margin:16px 0;padding:14px;border:1px solid var(--user-accent,var(--accent));color:var(--user-accent,var(--accent));box-shadow:0 0 14px color-mix(in srgb,var(--user-accent,var(--accent)) 35%,transparent)}.accent-preview button{width:max-content;padding:7px 12px;border:1px solid currentColor;background:var(--user-accent,var(--accent));color:var(--bg);cursor:pointer}';document.head.append(profileThemeStyle);

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const css = `<style>.profile-view{display:grid;gap:14px}.profile-card{padding:26px;border:1px solid var(--border);background:linear-gradient(135deg,rgba(25,70,90,.16),var(--panel-depth) 52%,rgba(1,9,16,.72));box-shadow:inset 0 1px 0 var(--panel-reflection),inset 0 -18px 30px rgba(0,0,0,.16),0 12px 24px rgba(0,0,0,.18)}.profile-card h1{margin:6px 0;color:var(--bright);letter-spacing:.1em}.profile-label{display:block;margin:18px 0 7px;color:var(--muted);font-size:10px;letter-spacing:.16em}.profile-input{width:100%;box-sizing:border-box;padding:11px;border:1px solid var(--border);background:rgba(1,9,16,.68);color:var(--text);font:inherit}.profile-check{display:flex;align-items:center;gap:9px;margin-top:20px;color:var(--text)}.profile-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.profile-actions button,.profile-security button,.profile-service button{padding:10px 14px;border:1px solid var(--border);background:rgba(1,9,16,.68);color:var(--bright);font:inherit;cursor:pointer}.profile-actions button[type=submit],.profile-service button.primary{background:linear-gradient(135deg,rgba(25,126,171,.9),rgba(3,53,85,.95))}.profile-note,.profile-link{margin-top:16px;color:var(--muted);line-height:1.5}.profile-link code,.profile-secret{display:block;margin-top:7px;padding:9px;overflow:auto;overflow-wrap:anywhere;word-break:break-word;border:1px solid var(--border);background:rgba(1,9,16,.68);color:var(--accent);font:inherit}.profile-error{color:#ffabb6}.profile-security,.profile-service{margin-top:24px;padding-top:18px;border-top:1px solid var(--border)}.profile-security strong,.profile-service strong{color:var(--bright);letter-spacing:.12em}.profile-security-status,.profile-service-meta{color:var(--muted)}.profile-service-status{margin-top:16px;color:var(--accent);font-size:16px;letter-spacing:.12em}.profile-service button:disabled{opacity:.55;cursor:wait}.profile-dialog{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:20px;background:rgba(1,8,14,.78);backdrop-filter:blur(7px)}.profile-dialog-panel{width:min(560px,100%);max-height:calc(100vh - 40px);overflow:auto;padding:22px;border:1px solid var(--border);background:linear-gradient(135deg,var(--panel),var(--panel-depth));box-shadow:0 0 28px var(--glow)}.profile-dialog-panel h2{margin-top:0;color:var(--bright)}.profile-dialog-actions{display:flex;gap:10px;flex-wrap:wrap}.profile-dialog-actions button{padding:10px 14px;border:1px solid var(--border);background:rgba(1,9,16,.68);color:var(--bright);font:inherit;cursor:pointer}@media(max-width:620px){.profile-card{padding:18px}.profile-dialog{padding:12px}.profile-dialog-panel{padding:18px}}</style>`;

const loadProfile = async () => { const response = await fetch('/api/profile'); const body = await response.json(); if (!response.ok) throw Error(body.error || 'Unable to load profile'); return body.profile; };
const loadScmdb = async () => { const response = await fetch('/api/profile/scmdb'); const body = await response.json(); if (!response.ok) throw Error(body.error || 'Unable to load SCMDB status'); return body.connections || []; };
const updateProfile = async values => { const response = await fetch('/api/profile', { method: 'POST', body: new URLSearchParams(values) }); const body = await response.json(); if (!response.ok) throw Error(body.error || 'Unable to save profile'); return body.profile; };
const accentPresets = { CYAN:'#39D9FF', AZURE:'#3D8BFF', EMERALD:'#42E6A4', AMBER:'#FFB347', ORANGE:'#FF7A32', CRIMSON:'#FF4D5E', VIOLET:'#A77BFF', SNOW:'#D9F4FF' };
const applyAccent = color => document.documentElement.style.setProperty('--user-accent', color || 'var(--accent)');
const accentBlock = profile => `<section class="profile-appearance"><strong>INTERFACE CUSTOMIZATION</strong><label class="profile-label">ACCENT COLOR</label><label class="profile-radio"><input type="radio" name="accent-choice" value="" ${!profile.accent_color?'checked':''}> THEME DEFAULT</label><div class="profile-presets">${Object.entries(accentPresets).map(([name,value])=>`<button type="button" data-accent="${value}" class="${profile.accent_color===value?'selected':''}">${name}</button>`).join('')}</div><label class="profile-label" for="profile-accent">CUSTOM COLOR</label><div class="profile-color-row"><input id="profile-accent-picker" type="color" value="${profile.accent_color||'#39D9FF'}"><input class="profile-input" id="profile-accent" name="accent_color" pattern="#[0-9A-Fa-f]{6}" value="${profile.accent_color||''}" placeholder="#RRGGBB"></div><div class="accent-preview" id="accent-preview"><b>PREVIEW</b><span>HUD LINE · SELECTED STATE</span><button type="button">ACTION</button></div><button type="button" id="accent-reset">RESET TO THEME DEFAULT</button></section>`;
const recoveryStatus = profile => profile.has_recovery_key ? 'ACTIVE' : 'NOT SET';
const serviceStatus = connections => { const connection = connections[0]; return { connection, label: connection ? String(connection.status || 'disconnected').toUpperCase() : 'NOT CONNECTED' }; };

export const mount = async root => {
  if (!root || location.hash !== '#profile') return;
  root.innerHTML = css + '<section class="profile-view"><article class="profile-card">LOADING PROFILE...</article></section>';
  try {
    let profile = await loadProfile();
    let connections = await loadScmdb();
    const showConnectConfirm = () => {
      const dialog = document.createElement('div');
      dialog.className = 'profile-dialog';
      dialog.innerHTML = '<section class="profile-dialog-panel"><h2>CONNECT SCMDB</h2><p class="profile-note">VerseLink will generate a unique Sync Sink URL for your account. Add this URL to SCMDB to enable Blueprint Inventory synchronization.</p><div class="profile-dialog-actions"><button type="button" data-action="cancel">CANCEL</button><button type="button" class="primary" data-action="generate">GENERATE SINK URL</button></div></section>';
      document.body.append(dialog);
      dialog.querySelector('[data-action="cancel"]').onclick = () => dialog.remove();
      dialog.querySelector('[data-action="generate"]').onclick = async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const response = await fetch('/api/profile/scmdb/connect', { method: 'POST' });
          const body = await response.json().catch(() => ({}));
          if (response.status === 429) throw Error('TOO MANY REQUESTS\\nPlease try again later.');
          if (!response.ok) throw Error(body.error || 'Connection could not be created.');
          if (typeof body.sink_url !== 'string' || body.connection_status !== 'pending') throw Error('Connection could not be created.');
          dialog.innerHTML = `<section class="profile-dialog-panel"><h2>SCMDB SINK URL CREATED</h2><p class="profile-note">COPY THIS URL NOW. Add it as a Sync Sink in SCMDB. For security reasons, the full Sink URL will not be shown again.</p><code class="profile-secret">${esc(body.sink_url)}</code><div class="profile-dialog-actions"><button type="button" data-action="copy">COPY SINK URL</button><button type="button" data-action="done">DONE</button></div></section>`;
          const secret = dialog.querySelector('.profile-secret');
          dialog.querySelector('[data-action="copy"]').onclick = async copyEvent => { try { await copyText(secret.textContent); copyEvent.currentTarget.textContent = 'COPIED'; } catch { copyEvent.currentTarget.textContent = 'COPY FAILED'; } };
          dialog.querySelector('[data-action="done"]').onclick = async () => { dialog.remove(); connections = await loadScmdb(); render(); };
        } catch (error) {
          dialog.innerHTML = `<section class="profile-dialog-panel"><h2>SCMDB CONNECTION ERROR</h2><p class="profile-error">${esc(error.message || 'Connection could not be created.')}</p><div class="profile-dialog-actions"><button type="button" data-action="close">CLOSE</button></div></section>`;
          dialog.querySelector('[data-action="close"]').onclick = () => dialog.remove();
        }
      };
    };
    const showDisconnectConfirm = () => {
      const dialog = document.createElement('div');
      dialog.className = 'profile-dialog';
      dialog.innerHTML = '<section class="profile-dialog-panel"><h2>DISCONNECT SCMDB?</h2><p class="profile-note">The current SCMDB Sink URL will be revoked immediately. SCMDB will no longer synchronize with VerseLink.</p><div class="profile-dialog-actions"><button type="button" data-action="cancel">CANCEL</button><button type="button" class="primary" data-action="disconnect">DISCONNECT SCMDB</button></div></section>';
      document.body.append(dialog);
      dialog.querySelector('[data-action="cancel"]').onclick = () => dialog.remove();
      dialog.querySelector('[data-action="disconnect"]').onclick = async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const response = await fetch('/api/profile/scmdb/disconnect', { method: 'POST' });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw Error(body.error || 'Unable to disconnect SCMDB.');
          dialog.remove();
          connections = await loadScmdb();
          render('SCMDB DISCONNECTED');
        } catch (error) {
          dialog.innerHTML = `<section class="profile-dialog-panel"><h2>SCMDB DISCONNECT ERROR</h2><p class="profile-error">${esc(error.message || 'Unable to disconnect SCMDB.')}</p><div class="profile-dialog-actions"><button type="button" data-action="close">CLOSE</button></div></section>`;
          dialog.querySelector('[data-action="close"]').onclick = () => dialog.remove();
        }
      };
    };
    const showRecoveryWarning = () => {
      const dialog = document.createElement('div');
      dialog.className = 'profile-dialog';
      dialog.innerHTML = '<section class="profile-dialog-panel"><h2>GENERATE NEW RECOVERY KEY?</h2><p class="profile-note">Your current Recovery Key will become invalid immediately. You will only see the new Recovery Key once.</p><div class="profile-dialog-actions"><button type="button" data-action="cancel">CANCEL</button><button type="button" data-action="generate">GENERATE NEW KEY</button></div></section>';
      document.body.append(dialog);
      dialog.querySelector('[data-action="cancel"]').onclick = () => dialog.remove();
      dialog.querySelector('[data-action="generate"]').onclick = async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const response = await fetch('/api/me/recovery-key', { method: 'POST' });
          const body = await response.json().catch(() => ({}));
          if (response.status === 429) throw Error('TOO MANY REQUESTS\\nPlease try again later.');
          if (!response.ok || typeof body.recovery_key !== 'string' || !body.recovery_key.startsWith('vlr_')) throw Error('Unable to generate a new Recovery Key.');
          profile.has_recovery_key = true;
          dialog.innerHTML = `<section class="profile-dialog-panel"><h2>NEW RECOVERY KEY</h2><p class="profile-note">SAVE THIS KEY NOW.</p><code class="profile-secret">${esc(body.recovery_key)}</code><p class="profile-note">This Recovery Key will not be shown again. Your previous Recovery Key is now invalid.</p><div class="profile-dialog-actions"><button type="button" data-action="copy">COPY RECOVERY KEY</button><button type="button" data-action="done">DONE</button></div></section>`;
          const secret = dialog.querySelector('.profile-secret');
          dialog.querySelector('[data-action="copy"]').onclick = async copyEvent => { try { await copyText(secret.textContent); copyEvent.currentTarget.textContent = 'COPIED'; } catch { copyEvent.currentTarget.textContent = 'COPY FAILED'; } };
          dialog.querySelector('[data-action="done"]').onclick = () => { dialog.remove(); render(); };
        } catch (error) {
          dialog.innerHTML = `<section class="profile-dialog-panel"><h2>RECOVERY KEY ERROR</h2><p class="profile-error">${esc(error.message || 'Unable to generate a new Recovery Key.')}</p><div class="profile-dialog-actions"><button type="button" data-action="close">CLOSE</button></div></section>`;
          dialog.querySelector('[data-action="close"]').onclick = () => dialog.remove();
        }
      };
    };
    const render = (message = '') => {
      const publicUrl = location.origin + profile.public_path;
      const service = serviceStatus(connections);
      const detail = service.connection;
      const serviceDetails = detail && service.label === 'CONNECTED' ? `${detail.user_handle ? `<p class="profile-service-meta">SCMDB HANDLE: <strong>${esc(detail.user_handle)}</strong></p>` : ''}${detail.connected_at ? `<p class="profile-service-meta">CONNECTED SINCE: ${esc(new Date(detail.connected_at).toLocaleString())}</p>` : ''}${detail.last_seen_at ? `<p class="profile-service-meta">LAST SYNC: ${esc(new Date(detail.last_seen_at).toLocaleString())}</p>` : ''}` : '';
      const serviceHint = service.label === 'PENDING' ? 'Waiting for the first SCMDB synchronization.' : service.label === 'NOT CONNECTED' ? 'Connect SCMDB to synchronize your Blueprint Inventory with VerseLink.' : service.label === 'CONNECTED' ? 'SCMDB connection is active.' : 'Connection management will be available separately.';
      const canConnect = ['NOT CONNECTED', 'DISCONNECTED', 'REVOKED'].includes(service.label);
      root.innerHTML = css + `<section class="profile-view"><article class="profile-card"><div class="profile-label">VERSELINK MEMBER PROFILE</div><h1>${esc(profile.display_name)}</h1><p class="profile-note">Your SCMDB identity remains unchanged. These fields control only your VerseLink profile.</p><form id="profile-form"><label class="profile-label" for="profile-name">VERSELINK DISPLAY NAME</label><input class="profile-input" id="profile-name" name="verselink_name" maxlength="50" value="${esc(profile.verselink_name || '')}" placeholder="Use SCMDB name when empty"><label class="profile-label" for="profile-rsi">RSI PROFILE URL</label><input class="profile-input" id="profile-rsi" name="rsi_profile_url" type="url" maxlength="500" value="${esc(profile.rsi_profile_url || '')}" placeholder="https://robertsspaceindustries.com/citizens/..."><label class="profile-label" for="profile-discord">DISCORD NAME</label><input class="profile-input" id="profile-discord" name="discord_name" maxlength="80" value="${esc(profile.discord_name || '')}" placeholder="e.g. hector"><label class="profile-check"><input name="profile_public" type="checkbox" value="1" ${profile.profile_public ? 'checked' : ''}> MAKE THIS PROFILE PUBLIC</label><div class="profile-actions"><button type="submit">SAVE PROFILE</button><button id="profile-home" type="button">BACK</button></div></form><div class="profile-link">${profile.profile_public ? 'Your public profile is enabled.' : 'Your profile is private. Enable public visibility to share these details.'}<code>${esc(publicUrl)}</code><button id="profile-copy" type="button">COPY PROFILE URL</button></div><section class="profile-security"><strong>ACCOUNT SECURITY</strong><p class="profile-note">The Recovery Key can be used to regain access if you lose your VerseLink ID.</p><p class="profile-security-status">RECOVERY KEY: <strong>${recoveryStatus(profile)}</strong></p><button id="profile-recovery" type="button">${profile.has_recovery_key ? 'GENERATE NEW RECOVERY KEY' : 'GENERATE RECOVERY KEY'}</button></section><section class="profile-service"><strong>CONNECTED SERVICES</strong><div class="profile-label">SCMDB · BLUEPRINT INVENTORY SYNC</div><div class="profile-service-status">STATUS: ${esc(service.label)}</div><p class="profile-note">${serviceHint}</p>${serviceDetails}<div class="profile-actions">${canConnect ? `<button id="profile-scmdb-connect" class="primary" type="button">${service.label === 'NOT CONNECTED' ? 'CONNECT SCMDB' : 'CONNECT NEW SCMDB'}</button>` : ''}${service.label === 'CONNECTED' ? '<button id="profile-scmdb-disconnect" type="button">DISCONNECT SCMDB</button>' : ''}<button id="profile-scmdb-refresh" type="button">REFRESH STATUS</button></div></section>${message ? `<p class="profile-note ${message.startsWith('ERROR') ? 'profile-error' : ''}">${esc(message)}</p>` : ''}</article></section>`;
      root.querySelector('#profile-home').onclick = () => { location.hash = '#home'; };
      root.querySelector('#profile-copy').onclick = async () => { try { await copyText(publicUrl); root.querySelector('#profile-copy').textContent = 'COPIED'; } catch { root.querySelector('#profile-copy').textContent = 'COPY FAILED'; } };
      root.querySelector('#profile-recovery').onclick = showRecoveryWarning;
      root.querySelector('#profile-scmdb-connect')?.addEventListener('click', showConnectConfirm);
      root.querySelector('#profile-scmdb-disconnect')?.addEventListener('click', showDisconnectConfirm);
      root.querySelector('#profile-scmdb-refresh')?.addEventListener('click', async event => { event.currentTarget.disabled = true; try { connections = await loadScmdb(); render('SCMDB STATUS REFRESHED'); } catch (error) { render(`ERROR: ${error.message}`); } });
      root.querySelector('#profile-form').onsubmit = async event => { event.preventDefault(); try { profile = await updateProfile(Object.fromEntries(new FormData(event.target))); document.dispatchEvent(new CustomEvent('verselink-profile-updated', { detail: profile })); render('PROFILE SAVED'); } catch (error) { render(`ERROR: ${error.message}`); } };
      const profileMessage = [...root.querySelectorAll('.profile-card > .profile-note')].at(-1);
      if (profileMessage) root.querySelector('#profile-form .profile-actions')?.after(profileMessage);
    };
    const installRsiSync = () => {
      const form = root.querySelector('#profile-form');
      if (!form || root.querySelector('#profile-rsi-sync')) return;
      form.insertAdjacentHTML('afterend', '<div class="profile-actions"><button id="profile-rsi-sync" type="button">SYNC RSI PUBLIC DATA</button></div><p class="profile-note">Imports the public RSI avatar and dossier details. The direct RSI profile link remains unchanged.</p>');
      root.querySelector('#profile-rsi-sync').onclick = async () => { try { const response = await fetch('/api/profile/rsi-sync', { method: 'POST' }); const body = await response.json(); if (!response.ok) throw Error(body.error || 'Unable to sync RSI profile'); profile = body.profile; document.dispatchEvent(new CustomEvent('verselink-profile-updated', { detail: profile })); render('RSI PUBLIC PROFILE SYNCHRONIZED'); } catch (error) { render(`ERROR: ${error.message}`); } };
    };
    const observer = new MutationObserver(installRsiSync);
    observer.observe(root, { childList: true, subtree: true });
    render();
    installRsiSync();
  } catch (error) { root.innerHTML = css + `<section class="profile-view"><article class="profile-card profile-error">${esc(error.message)}</article></section>`; }
};
