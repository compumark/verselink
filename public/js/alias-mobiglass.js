const updateAuthenticatedUserState = user => {
  const state = document.querySelector('#userState');
  document.querySelectorAll('[data-verselink-name]').forEach(element => element.remove());
  if (state) state.innerHTML = user ? 'VERIFIED <i class="dot"></i>' : 'NOT AUTHENTICATED';
  if (!user) {
    document.querySelectorAll('#notificationCenter, #notificationButton').forEach(element => element.remove());
  }
  if (user) {
    const status = document.querySelector('.user-status');
    if (status) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'verselink-name-button'; button.dataset.verselinkName = 'true';
      button.textContent = 'EDIT PROFILE'; button.title = 'Open your VerseLink profile';
      button.onclick = () => { location.hash = '#profile'; }; status.append(button);
    }
    if (state) state.textContent = `HALLO, ${user.display_name}`;
  }
  document.dispatchEvent(new CustomEvent('verselink-user-state-changed', { detail: user || null }));
};
window.updateAuthenticatedUserState = updateAuthenticatedUserState;
document.addEventListener('verselink-profile-updated', event => updateAuthenticatedUserState(event.detail));
document.addEventListener('click', event => { if (event.target.closest('#logout')) updateAuthenticatedUserState(null); });
const install = async () => { const response = await fetch('/api/me', { cache: 'no-store' }); const body = await response.json(); updateAuthenticatedUserState(response.ok ? body.user : null); };
window.addEventListener('load', () => { install().catch(() => updateAuthenticatedUserState(null)); });
document.head.insertAdjacentHTML('beforeend', '<style>.verselink-name-button{display:block;margin-top:6px;padding:0;border:0;background:transparent;color:var(--accent);font:9px inherit;letter-spacing:.1em;cursor:pointer}.verselink-name-button:hover{text-decoration:underline;color:var(--bright)}</style>');
import('/js/material-scu-format.js').catch(() => {});
