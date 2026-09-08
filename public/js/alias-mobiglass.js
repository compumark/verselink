const install = async () => {
  const status = document.querySelector('.user-status');
  if (!status || status.querySelector('[data-verselink-name]')) return;
  const response = await fetch('/api/me');
  const body = await response.json();
  if (!response.ok || !body.user) return;
  const showName = user => { const state = document.querySelector('#userState'); if (state) state.textContent = `HALLO, ${user.display_name}`; };
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'verselink-name-button';
  button.dataset.verselinkName = 'true';
  button.textContent = 'EDIT PROFILE';
  button.title = 'Open your VerseLink profile';
  button.onclick = () => { location.hash = '#profile'; };
  status.append(button);
  showName(body.user);
  document.addEventListener('verselink-profile-updated', event => showName(event.detail));
  document.head.insertAdjacentHTML('beforeend', '<style>.verselink-name-button{display:block;margin-top:6px;padding:0;border:0;background:transparent;color:var(--accent);font:9px inherit;letter-spacing:.1em;cursor:pointer}.verselink-name-button:hover{text-decoration:underline;color:var(--bright)}</style>');
};

window.addEventListener('load', () => { install().catch(() => {}); });
