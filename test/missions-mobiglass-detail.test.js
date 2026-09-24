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

test('detail refreshes group context before the selected mission and keeps the search focus fix intact', () => {
  assert.match(source, /if \(state\.selectedMissionId\) \{ const missionId = state\.selectedMissionId, groupId = state\.groupId; await loadGroups\(groupId\)/);
  assert.match(source, /data-mission-refresh/);
  const handler = source.match(/data-missions-search\]'\)\?\.addEventListener\('input', event => \{[^}]+\}/)?.[0] || '';
  assert.match(handler, /renderMissionResults\(\)/);
  assert.doesNotMatch(handler, /\brender\(\)|fetch\(|innerHTML/);
  assert.doesNotMatch(source, /location\.reload/);
});

test('creator labels distinguish active members, former members, and hard-deleted users', () => {
  assert.match(source, /const missionCreatorLabel = mission => !mission\?\.created_by \? 'FORMER USER' : memberName\(mission, mission\.created_by\) \|\| 'FORMER MEMBER'/);
  assert.doesNotMatch(source, /memberName\(mission, mission\.created_by\) \|\| 'UNKNOWN'/);
});

test('task section keeps its heading separate from the compact add-task control', () => {
  assert.match(source, /<div class="mission-tasks-head"><div class="missions-label">TASKS<\/div>\$\{manage \? '<button type="button" class="mission-task-add" data-task-create>/);
  assert.match(source, /<div class="mission-tasks">/);
  assert.match(source, /\.mission-tasks-head\{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:10px\}/);
  assert.match(source, /\.mission-task-add\{min-height:31px;padding:5px 9px;font-size:11px/);
  assert.match(source, /@media\(max-width:680px\)\{\.mission-tasks-head\{display:grid;gap:8px\}\.mission-task-add\{width:100%;min-height:38px\}\}/);
});

test('task add focus-return selector remains wired to the dialog lifecycle', () => {
  assert.match(source, /data-task-create.*openDialog/);
  assert.match(source, /: '\[data-task-create\]'/);
  assert.match(source, /mountedRoot\?\.querySelector\(selector\)/);
});
