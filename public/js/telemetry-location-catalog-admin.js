const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export const installTelemetryLocationCatalog = () => {
  const root = document.querySelector('.admin-view');
  if (!root || root.querySelector('.admin-location-catalog')) return;
  const panel = document.createElement('section');
  panel.className = 'admin-panel admin-location-catalog';
  panel.innerHTML = `<h2>TELEMETRY LOCATION CATALOG</h2>
    <p class="admin-label">Only an exact, manually verified Game.log key is used for resolution. External reference data is proposal-only; it never supplies or guesses a raw key. This panel contains no personal telemetry. Wiki proposals require operator enablement after source terms are reviewed; credit api.star-citizen.wiki when enabled.</p>
    <div class="admin-actions"><button type="button" data-import="wiki">IMPORT WIKI PROPOSALS</button><button type="button" data-import="uex">IMPORT UEX PROPOSALS</button><span data-catalog-state class="admin-label"></span></div>
    <label class="admin-label">SEARCH CATALOG<input class="admin-search" data-catalog-search type="search" placeholder="RAW KEY, PLACE, SYSTEM, JURISDICTION, AFFILIATION"></label>
    <div data-catalog-rows class="admin-groups"></div>
    <h3>EXTERNAL PROPOSALS</h3><label class="admin-label">SEARCH PROPOSALS<input class="admin-search" data-proposal-search type="search"></label><div data-proposals class="admin-groups"></div>
    <form data-catalog-form class="admin-location-form"><h3>ADD / EDIT EXACT LOCATION MAPPING</h3>
      <label>Raw Game.log key <input name="location_raw" maxlength="256" required></label>
      <label>Display place <input name="display_name" maxlength="256" required></label>
      <label>System (not jurisdiction) <input name="system_name" maxlength="128"></label>
      <label>Parent place <input name="parent_name" maxlength="256"></label>
      <label>Jurisdiction — only if confirmed <input name="jurisdiction" maxlength="128"></label>
      <label>Faction / affiliation — separate field <input name="affiliation" maxlength="128"></label>
      <label>Source / provenance <input name="source" maxlength="128" value="admin"></label>
      <label>Match type <select name="match_type"><option value="manual">Manual exact key</option><option value="exact">Exact game key source verified</option></select></label>
      <label>Review status <select name="status"><option value="suggested">Suggested / unresolved</option><option value="verified">Verified</option></select></label>
      <div class="admin-actions"><button type="submit">SAVE MAPPING</button><button type="button" data-preview>TEST RAW KEY</button></div><div data-preview-result class="admin-label"></div><div data-save-result class="admin-label"></div>
    </form>`;
  root.append(panel);
  const search = panel.querySelector('[data-catalog-search]'), proposalSearch = panel.querySelector('[data-proposal-search]');
  const rows = panel.querySelector('[data-catalog-rows]'), proposals = panel.querySelector('[data-proposals]'), state = panel.querySelector('[data-catalog-state]');
  const form = panel.querySelector('[data-catalog-form]');
  const request = async (url, options) => {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(body.error || 'Request failed');
    return body;
  };
  const loadCatalog = async () => {
    const data = await request(`/api/admin/telemetry/location-catalog?q=${encodeURIComponent(search.value)}`);
    state.textContent = `CATALOG VERSION ${data.version} · ${data.entries.length} MATCHES`;
    rows.innerHTML = data.entries.map(entry => `<article class="admin-group"><strong>${esc(entry.display_name)}</strong><span class="admin-label">${esc(entry.location_raw)} · ${esc(entry.system_name || 'System unknown')} · Jurisdiction: ${esc(entry.jurisdiction || 'Unknown')} · Affiliation: ${esc(entry.affiliation || 'Unknown')}</span><span class="admin-label">${esc(entry.status)} · ${esc(entry.match_type)} · ${esc(entry.source)} · Updated ${esc(entry.updated_at)}</span><button type="button" data-edit="${esc(entry.location_raw)}">EDIT / REVIEW</button></article>`).join('') || '<div class="admin-notice">NO CATALOG ENTRIES</div>';
    rows.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => {
      const entry = data.entries.find(item => item.location_raw === button.dataset.edit);
      for (const [key, value] of Object.entries(entry)) if (form.elements[key]) form.elements[key].value = value ?? '';
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
  const loadProposals = async () => {
    const data = await request(`/api/admin/telemetry/location-catalog/suggestions?q=${encodeURIComponent(proposalSearch.value)}`);
    proposals.innerHTML = data.proposals.map((item, index) => `<article class="admin-group"><strong>${esc(item.display_name)}</strong><span class="admin-label">${esc(item.source)} · external ref ${esc(item.external_id)} · ${esc(item.system_name || 'System unknown')}</span><span class="admin-label">Jurisdiction: ${esc(item.jurisdiction || 'Unknown')} · Affiliation: ${esc(item.affiliation || 'Unknown')} · proposal only — no raw key match</span><button type="button" data-proposal="${index}">USE AS UNVERIFIED DRAFT</button></article>`).join('') || '<div class="admin-notice">NO EXTERNAL PROPOSALS</div>';
    proposals.querySelectorAll('[data-proposal]').forEach(button => button.onclick = () => {
      const item = data.proposals[Number(button.dataset.proposal)];
      form.elements.display_name.value = item.display_name || '';
      form.elements.system_name.value = item.system_name || '';
      form.elements.parent_name.value = item.parent_name || '';
      form.elements.jurisdiction.value = item.jurisdiction || '';
      form.elements.affiliation.value = item.affiliation || '';
      form.elements.location_raw.value = '';
      form.elements.source.value = `${item.source}:${item.external_id}`.slice(0, 128);
      form.elements.match_type.value = 'manual';
      form.elements.status.value = 'suggested';
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
  const refresh = () => Promise.all([loadCatalog(), loadProposals()]).catch(error => { state.textContent = `LOCATION CATALOG UNAVAILABLE: ${error.message}`; });
  search.oninput = loadCatalog; proposalSearch.oninput = loadProposals;
  panel.querySelectorAll('[data-import]').forEach(button => button.onclick = async () => {
    button.disabled = true; state.textContent = 'IMPORTING PROPOSALS...';
    try { const data = await request(`/api/admin/telemetry/location-catalog/import/${button.dataset.import}`, { method: 'POST' }); state.textContent = `${data.proposals} PROPOSALS IMPORTED · EXACT KEY MATCHES: 0`; await refresh(); }
    catch (error) { state.textContent = `IMPORT FAILED: ${error.message}`; }
    finally { button.disabled = false; }
  });
  form.onsubmit = async event => {
    event.preventDefault(); const result = panel.querySelector('[data-save-result]');
    try { await request('/api/admin/telemetry/location-catalog', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }); result.textContent = 'SAVED; VERIFIED ENTRIES ARE NOW AVAILABLE TO HISTORY AND CLIENTS.'; await refresh(); }
    catch (error) { result.textContent = `SAVE FAILED: ${error.message}`; }
  };
  panel.querySelector('[data-preview]').onclick = async () => {
    const raw = form.elements.location_raw.value, target = panel.querySelector('[data-preview-result]');
    if (!raw) { target.textContent = 'ENTER AN EXACT RAW KEY FIRST.'; return; }
    try {
      const data = await request(`/api/admin/telemetry/location-catalog?q=${encodeURIComponent(raw)}`);
      const exact = data.entries.find(item => item.location_raw === raw && item.status === 'verified');
      target.textContent = exact ? `${exact.display_name} · System ${exact.system_name || 'Unknown'} · Jurisdiction ${exact.jurisdiction || 'Unknown'} · Affiliation ${exact.affiliation || 'Unknown'}` : `${raw} · System Unknown · Jurisdiction Unknown · Affiliation Unknown · unresolved`;
    } catch { target.textContent = 'PREVIEW UNAVAILABLE; NO VALUES INFERRED.'; }
  };
  refresh();
};

setInterval(installTelemetryLocationCatalog, 100);
document.head.insertAdjacentHTML('beforeend', '<style>.admin-location-form{display:grid;gap:10px;max-width:760px}.admin-location-form label{display:grid;gap:5px;color:var(--muted);font-size:11px}.admin-location-form input,.admin-location-form select{padding:9px;border:1px solid var(--border);background:rgba(1,9,16,.68);color:var(--text);font:inherit}.admin-location-catalog h3{color:var(--bright);font-size:13px;margin-top:24px}.admin-location-catalog .admin-groups{max-height:340px;overflow:auto}</style>');
