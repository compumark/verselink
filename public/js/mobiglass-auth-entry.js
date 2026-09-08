import { copyText } from '/js/auth-core.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const authCss = `<style>.mg-auth-entry{padding:26px 30px}.mg-auth-entry h1{margin:0 0 8px;color:var(--bright);font-size:18px;letter-spacing:.1em}.mg-auth-entry p{color:var(--muted);line-height:1.55;font-size:12px}.mg-auth-entry label{display:block;margin:18px 0 7px;color:var(--muted);font-size:10px;letter-spacing:.15em}.mg-auth-entry input{width:100%;box-sizing:border-box;padding:11px;border:1px solid var(--border);outline:0;background:#020a13;color:var(--text);font:inherit}.mg-auth-entry button{width:100%;margin-top:12px;padding:11px;border:1px solid var(--accent);background:linear-gradient(#0d75aa,#06466d);color:var(--bright);font:inherit;letter-spacing:.08em;cursor:pointer}.mg-auth-entry button:disabled{opacity:.6;cursor:wait}.mg-auth-entry .mg-auth-secondary{background:rgba(1,9,16,.68);border-color:var(--border)}.mg-auth-error{color:#ffabb6!important;white-space:pre-line}.mg-auth-actions{display:grid;gap:8px;margin-top:18px}.mg-auth-dialog{position:fixed;inset:0;z-index:1000;display:grid;place-items:center;padding:16px;background:rgba(1,8,14,.78);backdrop-filter:blur(7px)}.mg-auth-panel{width:min(560px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:24px;border:1px solid var(--border);background:linear-gradient(135deg,var(--panel),var(--panel2));box-shadow:0 0 28px var(--glow)}.mg-auth-panel h2{margin-top:0;color:var(--bright)}.mg-secret{display:block;max-width:100%;margin:14px 0;padding:10px;overflow-wrap:anywhere;word-break:break-word;border:1px solid var(--border);color:var(--accent);font:inherit}.mg-auth-dialog-actions{display:flex;gap:10px;flex-wrap:wrap}.mg-auth-dialog-actions button{flex:1;min-width:130px;padding:10px 14px;border:1px solid var(--border);background:rgba(1,9,16,.68);color:var(--bright);font:inherit;cursor:pointer}@media(max-width:520px){.mg-auth-entry{padding:20px 16px}.mg-auth-panel{padding:18px}}
</style>`;

const dialogCss = '<style>.mg-auth-panel input{width:100%;box-sizing:border-box;padding:11px;border:1px solid var(--border);outline:0;background:rgba(1,9,16,.72);color:var(--text);font:inherit;border-radius:0}.mg-auth-panel input:focus{border-color:var(--accent);box-shadow:0 0 12px var(--glow)}.mg-auth-panel button{width:100%;margin-top:12px;padding:11px;border:1px solid var(--accent);background:linear-gradient(135deg,rgba(25,106,145,.8),rgba(4,52,82,.92));color:var(--bright);font:inherit;letter-spacing:.08em;cursor:pointer}.mg-auth-panel button:disabled{opacity:.6;cursor:wait}.mg-auth-panel .mg-auth-secondary{background:rgba(1,9,16,.68);border-color:var(--border)}.mg-auth-dialog-actions button:first-child{background:rgba(1,9,16,.68);border-color:var(--border)}.mg-secret{background:rgba(1,9,16,.72)}</style>';
const entryMenuCss = '<style>.mg-auth-actions{gap:10px;margin-top:22px}.mg-auth-actions button{margin-top:0;padding:13px 16px;text-align:left;font-size:12px;letter-spacing:.12em;background:linear-gradient(135deg,rgba(25,70,90,.2),rgba(1,9,16,.72));border-color:var(--border);box-shadow:inset 0 1px 0 rgba(190,250,255,.08),0 6px 14px rgba(0,0,0,.18)}.mg-auth-actions button:hover,.mg-auth-actions button:focus-visible{border-color:var(--accent);background:linear-gradient(135deg,rgba(25,106,145,.28),rgba(1,9,16,.78));box-shadow:inset 0 1px 0 rgba(190,250,255,.12),0 0 12px var(--glow);outline:0}.mg-auth-actions #mg-login{border-color:var(--accent)}</style>';
const errorText = (response, body, fallback) => response.status === 429 ? 'TOO MANY REQUESTS\\nPlease try again later.' : body.error || fallback;
const dialog = content => {
  const wrapper = document.createElement('div');
  wrapper.className = 'mg-auth-dialog';
  wrapper.innerHTML = `<section class="mg-auth-panel">${content}</section>`;
  document.body.append(wrapper);
  return wrapper;
};

const showLogin = () => {
  const modal = dialog('<h2>LOGIN WITH VERSELINK ID</h2><p>Use your VerseLink ID starting with <strong>vl_</strong>. Recovery Keys starting with <strong>vlr_</strong> are not login credentials.</p><form id="mg-vl-login"><label for="mg-vl-token">VERSELINK ID</label><input id="mg-vl-token" type="password" autocomplete="off" placeholder="vl_..." required><p class="mg-auth-error" id="mg-vl-error"></p><div class="mg-auth-dialog-actions"><button type="button" data-close>CANCEL</button><button type="submit">LOGIN</button></div></form>');
  modal.querySelector('[data-close]').onclick = () => modal.remove();
  modal.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type=submit]');
    button.disabled = true;
    const error = modal.querySelector('#mg-vl-error');
    try {
      const response = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: modal.querySelector('#mg-vl-token').value }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(errorText(response, body, 'Unable to log in with VerseLink ID.'));
      window.location.reload();
    } catch (reason) { error.textContent = reason.message; button.disabled = false; }
  };
};

const showRecovery = () => {
  const modal = dialog('<h2>ACCOUNT RECOVERY</h2><p>Enter your Recovery Key to regain access to your VerseLink account.</p><form id="mg-recovery"><label for="mg-recovery-key">RECOVERY KEY</label><input id="mg-recovery-key" type="password" autocomplete="off" placeholder="vlr_..." required><p class="mg-auth-error" id="mg-recovery-error"></p><div class="mg-auth-dialog-actions"><button type="button" data-close>CANCEL</button><button type="submit">RECOVER ACCOUNT</button></div></form>');
  modal.querySelector('[data-close]').onclick = () => modal.remove();
  modal.querySelector('form').onsubmit = async event => {
    event.preventDefault(); const button = event.currentTarget.querySelector('button[type=submit]'); button.disabled = true;
    try {
      const response = await fetch('/auth/recover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recovery_key: modal.querySelector('#mg-recovery-key').value }) });
      const body = await response.json().catch(() => ({})); if (!response.ok) throw Error(errorText(response, body, 'Unable to recover account.'));
      if (!body.token?.startsWith('vl_') || !body.recovery_key?.startsWith('vlr_')) throw Error('Recovery succeeded but credentials were not returned.');
      modal.querySelector('.mg-auth-panel').innerHTML = `<h2>ACCOUNT RECOVERED</h2><p class="mg-auth-error">SAVE BOTH CREDENTIALS NOW. Your previous credentials are no longer valid.</p><label>NEW VERSELINK ID</label><code class="mg-secret">${esc(body.token)}</code><button type="button" data-copy-id>COPY VERSELINK ID</button><label>NEW RECOVERY KEY</label><code class="mg-secret">${esc(body.recovery_key)}</code><button type="button" data-copy-recovery>COPY RECOVERY KEY</button><p class="mg-auth-error" id="mg-copy-message"></p><button type="button" class="mg-auth-secondary" data-continue>CONTINUE TO LOGIN</button>`;
      const secrets = modal.querySelectorAll('.mg-secret'); const copySecret = async (event, secret) => { try { await copyText(secret.textContent); event.currentTarget.textContent = 'COPIED'; } catch { event.currentTarget.textContent = 'COPY BLOCKED — PRESS CTRL+C'; } };
      modal.querySelector('[data-copy-id]').onclick = event => copySecret(event, secrets[0]); modal.querySelector('[data-copy-recovery]').onclick = event => copySecret(event, secrets[1]); modal.querySelector('[data-continue]').onclick = () => modal.remove();
    } catch (reason) { modal.querySelector('#mg-recovery-error').textContent = reason.message; button.disabled = false; }
  };
};

const showRegistration = () => {
  const modal = dialog('<h2>CREATE NEW VERSELINK ID</h2><p>Create an independent VerseLink account. Your credentials will be shown once after registration.</p><form id="mg-vl-register"><label for="mg-vl-name">DISPLAY NAME</label><input id="mg-vl-name" maxlength="50" autocomplete="off" required><p class="mg-auth-error" id="mg-vl-register-error"></p><div class="mg-auth-dialog-actions"><button type="button" data-close>CANCEL</button><button type="submit">CREATE ACCOUNT</button></div></form>');
  modal.querySelector('[data-close]').onclick = () => modal.remove();
  modal.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type=submit]');
    button.disabled = true;
    const error = modal.querySelector('#mg-vl-register-error');
    try {
      const response = await fetch('/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ display_name: modal.querySelector('#mg-vl-name').value }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(errorText(response, body, 'Unable to create VerseLink account.'));
      if (typeof body.token !== 'string' || !body.token.startsWith('vl_') || typeof body.recovery_key !== 'string' || !body.recovery_key.startsWith('vlr_')) throw Error('Registration succeeded but credentials were not returned.');
      modal.querySelector('.mg-auth-panel').innerHTML = `<h2>VERSELINK CREDENTIALS</h2><p>SAVE BOTH CREDENTIALS NOW. Your Recovery Key will not be shown again.</p><label>YOUR VERSELINK ID</label><code class="mg-secret">${esc(body.token)}</code><button type="button" data-copy-id>COPY VERSELINK ID</button><label>YOUR RECOVERY KEY</label><code class="mg-secret">${esc(body.recovery_key)}</code><button type="button" data-copy-recovery>COPY RECOVERY KEY</button><p class="mg-auth-error" id="mg-copy-message"></p><button type="button" class="mg-auth-secondary" data-continue>CONTINUE TO VERSELINK</button>`;
      const secrets = modal.querySelectorAll('.mg-secret');
      const copySecret = async (event, secret) => { try { await copyText(secret.textContent); event.currentTarget.textContent = 'COPIED'; } catch { const selection = window.getSelection(); const range = document.createRange(); range.selectNodeContents(secret); selection.removeAllRanges(); selection.addRange(range); event.currentTarget.textContent = 'COPIED'; modal.querySelector('#mg-copy-message').textContent = ''; } };
      modal.querySelector('[data-copy-id]').onclick = event => copySecret(event, secrets[0]);
      modal.querySelector('[data-copy-recovery]').onclick = event => copySecret(event, secrets[1]);
      modal.querySelector('[data-continue]').onclick = () => { modal.remove(); location.reload(); };
    } catch (reason) { error.textContent = reason.message; button.disabled = false; }
  };
};

const mount = () => {
  const auth = document.querySelector('.main-grid .auth');
  if (!auth || document.querySelector('.mg-auth-entry')) return;
  if (!document.querySelector('#mg-auth-entry-css')) { const style = document.createElement('div'); style.id = 'mg-auth-entry-css'; style.innerHTML = authCss + dialogCss + entryMenuCss; document.head.append(...style.querySelectorAll('style')); }
  auth.classList.add('mg-auth-entry');
  auth.innerHTML = '<h1>VERSELINK AUTHENTICATION</h1><p>Sign in with VerseLink, recover an account, or create a new account.</p><div class="mg-auth-actions"><button type="button" id="mg-login">LOGIN WITH VERSELINK ID</button><button type="button" id="mg-recover">ACCOUNT RECOVERY</button><button type="button" id="mg-register">CREATE NEW VERSELINK ID</button></div>';
  auth.querySelector('#mg-login').onclick = showLogin;
  auth.querySelector('#mg-recover').onclick = showRecovery;
  auth.querySelector('#mg-register').onclick = showRegistration;
};

const observer = new MutationObserver(mount);
observer.observe(document.querySelector('#content'), { childList: true, subtree: true });
fetch('/api/me').then(response => response.json()).then(body => { if (!body.user) mount(); });
