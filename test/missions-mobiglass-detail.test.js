import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/js/missions-mobiglass.js', import.meta.url), 'utf8');

test('mission overview opens a read-only detail view with a stable query locator', () => {
  assert.match(source, /data-mission-open/);
  assert.match(source, /selectedMissionId/);
  assert.match(source, /const backToMissions/);
  assert.match(source, /data-mission-back/);
  assert.match(source, /missionLocatorFromUrl/);
  assert.match(source, /mission_id/);
  assert.match(source, /group_id/);
  assert.match(source, /history\[mode === 'replace' \? 'replaceState' : 'pushState'\]/);
});

test('detail reads exactly one mission and handles neutral read states', () => {
  assert.match(source, /missionApi \+ '\/' \+ encodeURIComponent\(missionId\)/);
  for (const label of ['LOADING MISSION...', 'MISSION NOT FOUND', 'MISSION DATA UNAVAILABLE', 'MISSION ACCESS CHANGED', 'RETRY', 'BACK TO MISSIONS']) assert.ok(source.includes(label));
  assert.match(source, /response\.status === 401/);
  assert.match(source, /response\.status === 404/);
  assert.match(source, /response\.status === 403/);
  assert.doesNotMatch(source, /\/tasks\/|\/contributions|fetch\([^\n]*PATCH/);
});

test('detail renders server-provided mission and task values without client ordering or progress calculations', () => {
  for (const field of ['mission.tasks', 'active_task_count', 'target_quantity', 'current_quantity', 'remaining_quantity', 'progress_percent', 'completed_at']) assert.ok(source.includes(field));
  assert.match(source, /taskAssigneeLabel\(mission, task\)/);
  assert.match(source, /task\.type === 'item'/);
  assert.match(source, /task\.status === 'cancelled'/);
  assert.doesNotMatch(source, /tasks\.sort\(/);
  assert.match(source, /const formatQuantity/);
});

test('historical task assignments remain distinct from unassigned tasks', () => {
  assert.match(source, /const taskAssigneeLabel/);
  assert.match(source, /!userId \? 'UNASSIGNED'/);
  assert.match(source, /memberName\(mission, userId\) \|\| 'FORMER MEMBER'/);
  assert.doesNotMatch(source, /memberName\(mission, userId\) \|\| 'UNASSIGNED'/);
});

test('detail refreshes the selected mission and keeps the search focus fix intact', () => {
  assert.match(source, /if \(state\.selectedMissionId\) return loadMissionDetail\(state\.selectedMissionId\)/);
  assert.match(source, /data-mission-refresh/);
  const handler = source.match(/data-missions-search\]'\)\?\.addEventListener\('input', event => \{[^}]+\}/)?.[0] || '';
  assert.match(handler, /renderMissionResults\(\)/);
  assert.doesNotMatch(handler, /\brender\(\)|fetch\(|innerHTML/);
  assert.doesNotMatch(source, /location\.reload/);
});
