import assert from 'node:assert/strict';
import test from 'node:test';
import { appendTelemetryHistoryPage, groupTelemetryHistory, renderTelemetryHistory } from '../public/js/telemetry-history-view.js';

const makeEntry = (id, overrides = {}) => ({
  id,
  device_id: 'device-11111111',
  device_name: 'Windows Client',
  received_at: `2026-09-30T20:00:${String(Number(id) % 60).padStart(2, '0')}.000Z`,
  observed_at: `2026-09-30T19:59:${String(Number(id) % 60).padStart(2, '0')}.000Z`,
  location_raw: 'MIC-L1',
  jurisdiction: 'UEE',
  ship_name: 'Carrack',
  ...overrides
});

test('long history stays in API order and visual grouping retains every snapshot', () => {
  const entries = Array.from({ length: 120 }, (_, index) => makeEntry(120 - index, {
    location_raw: index < 60 ? 'MIC-L1' : 'Area18'
  }));
  const markup = renderTelemetryHistory(entries);
  assert.equal((markup.match(/data-history-id=/g) || []).length, 120);
  assert.equal((markup.match(/data-history-group-size="/g) || []).length, 2);
  assert.match(markup, /Location changed/);
  assert.ok(markup.indexOf('data-history-id="120"') < markup.indexOf('data-history-id="1"'));
});

test('adjacent repeated snapshots collapse into native keyboard-accessible details with each time retained', () => {
  const entries = [
    makeEntry('3', { received_at: '2026-09-30T20:10:00.000Z', observed_at: '2026-09-30T20:09:58.000Z' }),
    makeEntry('2', { received_at: '2026-09-30T20:09:00.000Z', observed_at: '2026-09-30T20:08:58.000Z' }),
    makeEntry('1', { received_at: '2026-09-30T20:08:00.000Z', observed_at: '2026-09-30T20:07:58.000Z' })
  ];
  const markup = renderTelemetryHistory(entries);
  assert.equal(groupTelemetryHistory(entries).length, 1);
  assert.match(markup, /<details class="profile-telemetry-history-entry" data-history-group-size="3">/);
  assert.match(markup, /3 repeated snapshots/);
  const summary = markup.match(/<summary>(.*?)<\/summary>/s)?.[1] || '';
  assert.match(summary, /Observed \(game\)/);
  assert.match(summary, /Received \(server\)/);
  assert.match(summary, /datetime="2026-09-30T20:09:58\.000Z"/);
  assert.match(summary, /datetime="2026-09-30T20:07:58\.000Z"/);
  assert.match(summary, /datetime="2026-09-30T20:10:00\.000Z"/);
  assert.match(summary, /datetime="2026-09-30T20:08:00\.000Z"/);
  for (const id of ['1', '2', '3']) assert.ok(markup.includes(`data-history-id="${id}"`));
  for (const observed of ['20:09:58', '20:08:58', '20:07:58']) assert.ok(markup.includes(observed));
  assert.match(markup, /Observed \(game\)/);
  assert.match(markup, /Received \(server\)/);
});

test('location, jurisdiction, and ship changes remain distinct and unknown values are explicit', () => {
  const entries = [
    makeEntry('5', { ship_name: 'Prospector' }),
    makeEntry('4', { ship_name: 'Cutlass Black' }),
    makeEntry('3', { jurisdiction: 'Crusader' }),
    makeEntry('2', { location_raw: 'Area18', jurisdiction: 'UEE' }),
    makeEntry('1', { location_raw: null, jurisdiction: null, ship_name: null, observed_at: null, received_at: null })
  ];
  const markup = renderTelemetryHistory(entries);
  assert.match(markup, /Ship changed/);
  assert.match(markup, /Location changed/);
  assert.match(markup, /Location and ship changed/);
  assert.match(markup, /Unknown location/);
  assert.match(markup, /Unknown ship/);
  assert.match(markup, /Observed \(game\)<\/span><span>Unknown/);
  assert.match(markup, /Received \(server\)<\/span><span>Unknown/);
  assert.doesNotMatch(markup, /logout|session ended|session end/i);
});

test('resolved catalog fields stay separate and conflicting telemetry jurisdiction remains Unknown', () => {
  const markup = renderTelemetryHistory([makeEntry('8', {
    location_raw: 'Pyro4_Outpost_col_m_scrp_indy_001',
    locationDisplay: 'Ruin Station',
    systemDisplay: 'Pyro',
    jurisdictionDisplay: 'Unknown',
    affiliationDisplay: 'Headhunters',
    resolutionStatus: 'conflict',
    jurisdiction: 'UEE'
  })]);
  assert.match(markup, /Ruin Station · System: Pyro · Jurisdiction: Unknown · Affiliation: Headhunters · Raw ID: Pyro4_Outpost_col_m_scrp_indy_001/);
  assert.match(markup, /Catalog verification required — stored jurisdiction conflicts\./);
  assert.doesNotMatch(markup, /Jurisdiction: UEE/);
});

test('device names are primary and short IDs disambiguate duplicate names', () => {
  const entries = [
    makeEntry('2', { device_id: '11111111-aaaa-bbbb-cccc-dddddddddddd', device_name: 'Shared name' }),
    makeEntry('1', { device_id: '22222222-aaaa-bbbb-cccc-dddddddddddd', device_name: 'Shared name' })
  ];
  const markup = renderTelemetryHistory(entries);
  assert.match(markup, /Shared name · 11111111/);
  assert.match(markup, /Shared name · 22222222/);
  assert.doesNotMatch(markup, /11111111-aaaa-bbbb-cccc-dddddddddddd/);
  assert.doesNotMatch(markup, /22222222-aaaa-bbbb-cccc-dddddddddddd/);
});

test('loading an older page appends without reordering and merges a repeated-state group across the page boundary', () => {
  const newest = [makeEntry('3'), makeEntry('2')];
  const olderPage = [makeEntry('1')];
  assert.equal(groupTelemetryHistory(newest).length, 1);
  const all = appendTelemetryHistoryPage(newest, olderPage);
  assert.deepEqual(all.map(entry => entry.id), ['3', '2', '1']);
  assert.equal(groupTelemetryHistory(all).length, 1);
  assert.equal((renderTelemetryHistory(all).match(/data-history-id=/g) || []).length, 3);
});

test('date boundaries create separate sections and do not collapse snapshots across days', () => {
  const entries = [
    makeEntry('2', { received_at: '2026-10-02T12:01:00.000Z' }),
    makeEntry('1', { received_at: '2026-09-30T12:01:00.000Z' })
  ];
  assert.equal(groupTelemetryHistory(entries).length, 2);
  assert.equal((renderTelemetryHistory(entries).match(/class="profile-telemetry-history-day"/g) || []).length, 2);
});

test('unknown devices and untrusted field text render safely', () => {
  const markup = renderTelemetryHistory([makeEntry('<img>', {
    id: '<img>', device_id: 'abcdef12-1234-1234-1234-123456789012', device_name: '', location_raw: '<script>alert(1)</script>'
  })]);
  assert.match(markup, /Unknown device · abcdef12/);
  assert.match(markup, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
  assert.match(markup, /data-history-id="&lt;img&gt;"/);
});

test('empty history is stated without fabricating entries', () => {
  assert.match(renderTelemetryHistory([]), /No presence history has been recorded yet/);
  assert.doesNotMatch(renderTelemetryHistory([]), /data-history-id=/);
});
