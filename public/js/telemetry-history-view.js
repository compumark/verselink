const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

const displayValue = value => value == null ? '' : String(value);
const normalizeEntry = entry => entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
const sameSnapshotState = (left, right) => left.device_id === right.device_id
  && displayValue(left.device_name) === displayValue(right.device_name)
  && displayValue(left.location_raw) === displayValue(right.location_raw)
  && displayValue(left.jurisdiction) === displayValue(right.jurisdiction)
  && displayValue(left.ship_name) === displayValue(right.ship_name);

let nextDayGroupId = 0;

export const appendTelemetryHistoryPage = (existing, page) => {
  const seen = new Set(existing.filter(entry => entry?.id != null).map(entry => String(entry.id)));
  return [...existing, ...page.filter(entry => {
    if (entry?.id == null) return true;
    const id = String(entry.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  })];
};

export const rememberTelemetryHistoryDayStates = (container, expandedDays) => {
  container.querySelectorAll('.profile-telemetry-history-day[data-history-day-key]').forEach(day => {
    expandedDays.set(day.dataset.historyDayKey, day.open);
  });
  return expandedDays;
};

export const groupTelemetryHistory = entries => {
  const safeEntries = entries.map(normalizeEntry);
  const groups = [];
  for (let index = 0; index < safeEntries.length;) {
    const first = safeEntries[index];
    const records = [first];
    let next = index + 1;
    while (next < safeEntries.length && sameSnapshotState(first, safeEntries[next]) && dateSectionKey(first) === dateSectionKey(safeEntries[next])) {
      records.push(safeEntries[next]);
      next += 1;
    }
    groups.push({ records, olderNeighbor: safeEntries[next] || null });
    index = next;
  }
  return groups;
};

const parsedDate = value => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const formatTime = value => {
  const date = parsedDate(value);
  return date ? date.toLocaleString() : 'Unknown';
};

const dateSectionKey = entry => {
  const date = parsedDate(entry.received_at);
  return date ? date.toLocaleDateString() : 'Unknown date';
};

const locationText = entry => {
  const rawLocation = displayValue(entry.location_raw);
  const location = rawLocation ? `Location ID (unresolved): ${rawLocation}` : 'Unknown location';
  const jurisdiction = displayValue(entry.jurisdiction);
  return jurisdiction ? `${location} · ${jurisdiction}` : location;
};

const shipText = entry => displayValue(entry.ship_name) || 'Unknown ship';

const deviceLabels = entries => {
  const idsByName = new Map();
  for (const entry of entries) {
    const name = displayValue(entry.device_name).trim();
    if (!name) continue;
    if (!idsByName.has(name)) idsByName.set(name, new Set());
    idsByName.get(name).add(entry.device_id);
  }
  return new Map(entries.map(entry => {
    const name = displayValue(entry.device_name).trim();
    const shortId = displayValue(entry.device_id).replaceAll('-', '').slice(0, 8);
    if (!name) return [entry.id, shortId ? `Unknown device · ${shortId}` : 'Unknown device'];
    return [entry.id, idsByName.get(name)?.size > 1 ? `${name} · ${shortId}` : name];
  }));
};

const changeLabel = (entry, older) => {
  if (!older) return 'Snapshot';
  const locationChanged = displayValue(entry.location_raw) !== displayValue(older.location_raw)
    || displayValue(entry.jurisdiction) !== displayValue(older.jurisdiction);
  const shipChanged = displayValue(entry.ship_name) !== displayValue(older.ship_name);
  if (locationChanged && shipChanged) return 'Location and ship changed';
  if (locationChanged) return 'Location changed';
  if (shipChanged) return 'Ship changed';
  return 'Snapshot';
};

const timeMarkup = (label, value) => {
  const date = parsedDate(value);
  const time = date ? `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(formatTime(value))}</time>` : '<span>Unknown</span>';
  return `<span class="profile-telemetry-history-time"><span>${label}</span>${time}</span>`;
};

const timeRangeMarkup = (label, first, last) => {
  const timestampMarkup = value => {
    const date = parsedDate(value);
    return date ? `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(formatTime(value))}</time>` : '<span>Unknown</span>';
  };
  const firstMarkup = timestampMarkup(first);
  const lastMarkup = timestampMarkup(last);
  const range = first != null && first === last ? firstMarkup : `${firstMarkup} – ${lastMarkup}`;
  return `<span class="profile-telemetry-history-time"><span>${label}</span><span>${range}</span></span>`;
};

const snapshotMarkup = (entry, label, deviceLabel) => `<li class="profile-telemetry-history-snapshot" data-history-id="${escapeHtml(entry.id)}">
  <span class="profile-telemetry-history-change">${escapeHtml(label)}</span>
  <span class="profile-telemetry-history-location">${escapeHtml(locationText(entry))}</span>
  <span class="profile-telemetry-history-ship">${escapeHtml(shipText(entry))}</span>
  <span class="profile-telemetry-history-device">Device: ${escapeHtml(deviceLabel)}</span>
  <span class="profile-telemetry-history-times">${timeMarkup('Observed (game)', entry.observed_at)}${timeMarkup('Received (server)', entry.received_at)}</span>
</li>`;

const groupMarkup = (group, deviceLabel) => {
  const [newest, ...remaining] = group.records;
  const groupLabel = group.records.length > 1 ? `${group.records.length} repeated snapshots` : changeLabel(newest, group.olderNeighbor);
  if (group.records.length === 1) {
    return `<article class="profile-telemetry-history-entry" data-history-group-size="1"><ol>${snapshotMarkup(newest, groupLabel, deviceLabel)}</ol></article>`;
  }
  const olderEdge = group.records.at(-1);
  return `<details class="profile-telemetry-history-entry" data-history-group-size="${group.records.length}">
    <summary><span class="profile-telemetry-history-change">${escapeHtml(groupLabel)}</span><span>${escapeHtml(locationText(newest))}</span><span>${escapeHtml(shipText(newest))}</span><span>Device: ${escapeHtml(deviceLabel)}</span><span class="profile-telemetry-history-times">${timeRangeMarkup('Observed (game)', newest.observed_at, olderEdge.observed_at)}${timeRangeMarkup('Received (server)', newest.received_at, olderEdge.received_at)}</span></summary>
    <ol>${group.records.map((entry, index) => snapshotMarkup(entry, changeLabel(entry, remaining[index] || group.olderNeighbor), deviceLabel)).join('')}</ol>
  </details>`;
};

export const renderTelemetryHistory = (entries, expandedDays = new Map()) => {
  if (!entries.length) return '<p class="profile-note profile-telemetry-history-empty">No presence history has been recorded yet.</p>';
  const safeEntries = entries.map(normalizeEntry);
  const labels = deviceLabels(safeEntries);
  const groups = groupTelemetryHistory(safeEntries);
  const sections = [];
  for (const group of groups) {
    const entry = group.records[0];
    const key = dateSectionKey(entry);
    let section = sections.at(-1);
    if (!section || section.key !== key) {
      section = { key, date: entry.received_at, groups: [] };
      sections.push(section);
    }
    section.groups.push(group);
  }
  const newestSection = sections.reduce((newest, section) => {
    const date = parsedDate(section.date);
    return date && (!newest.date || date > newest.date) ? { key: section.key, date } : newest;
  }, { key: null, date: null });
  const newestDayKey = newestSection.key || sections[0]?.key;
  return `<div class="profile-telemetry-history-list" aria-label="Private presence history">${sections.map(section => {
    const date = parsedDate(section.date);
    const heading = date ? `<time datetime="${escapeHtml(date.toISOString())}">${escapeHtml(date.toLocaleDateString(undefined, { dateStyle: 'full' }))}</time>` : 'Unknown date';
    const dayKey = section.key;
    const groupId = `profile-telemetry-history-day-${++nextDayGroupId}`;
    const entriesId = `${groupId}-entries`;
    const entryCount = section.groups.reduce((total, group) => total + group.records.length, 0);
    const isOpen = expandedDays.has(dayKey) ? expandedDays.get(dayKey) : dayKey === newestDayKey;
    return `<details class="profile-telemetry-history-day" id="${groupId}" data-history-day-key="${escapeHtml(dayKey)}"${isOpen ? ' open' : ''}><summary aria-controls="${entriesId}"><h3>${heading}</h3><span class="profile-telemetry-history-day-count">${entryCount} ${entryCount === 1 ? 'entry' : 'entries'}</span><span class="profile-telemetry-history-day-indicator" aria-hidden="true"></span></summary><ol id="${entriesId}">${section.groups.map(group => `<li>${groupMarkup(group, labels.get(group.records[0].id) || 'Unknown device')}</li>`).join('')}</ol></details>`;
  }).join('')}</div>`;
};
