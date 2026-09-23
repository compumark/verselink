import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/js/missions-mobiglass.js', import.meta.url), 'utf8');

test('task actions use a dedicated state and prevent duplicate requests', () => {
  assert.match(source, /taskAction: \{ key: '', pending: false, error: '', success: '', draft: '' \}/);
  assert.match(source, /if \(state\.taskAction\.pending && state\.taskAction\.key === key\) return/);
  assert.match(source, /pending \? 'disabled' : ''/);
});

test('assignment is manager-only, same-group, supports unassign and historical display', () => {
  assert.match(source, /const assignment = manage \?/);
  assert.match(source, /members = groupFor\(mission\)\?\.members \|\| \[\]/);
  assert.match(source, /<option value="">UNASSIGNED<\/option>/);
  assert.match(source, /<option selected disabled>FORMER MEMBER<\/option>/);
  assert.match(source, /APPLY ASSIGNMENT/);
  assert.match(source, /new FormData\(assignment\)\.get\('assignee'\) \|\| null/);
  assert.match(source, /\{ \[assignmentField\]: new FormData\(assignment\)\.get\('assignee'\) \|\| null \}/);
});

test('manager or current assignee may act on a task', () => {
  assert.match(source, /const canActOnTask = \(mission, task\) => Boolean\(canManageMission\(mission\) \|\| state\.me\?\.id && taskAssignee\(task\) === state\.me\.id\)/);
  assert.match(source, /task\.status !== 'cancelled' && act/);
});

test('checklist complete and reopen requests carry status only', () => {
  assert.match(source, /MARK COMPLETE/);
  assert.match(source, /REOPEN/);
  assert.match(source, /data-status="\$\{task\.status === 'completed' \? 'open' : 'completed'\}"/);
  assert.match(source, /requestTaskAction\([^\n]+, 'checklist',[^\n]+, 'PATCH', \{ status \}/);
});

test('item contribution accepts positive decimals and guards remaining quantity', () => {
  assert.match(source, /data-task-contribution/);
  assert.match(source, /type="number" step="any"/);
  assert.match(source, /Number\.isFinite\(quantity\) \|\| quantity <= 0/);
  assert.match(source, /quantity > Number\(task\?\.remaining_quantity\)/);
  assert.match(source, /'POST', \{ quantity \}, 'CONTRIBUTION ADDED'/);
  assert.match(source, /TARGET REACHED/);
  assert.doesNotMatch(source, /\{ quantity,\s*(app_user_id|user_id|contributor)/);
});

test('successful actions refresh authoritative detail and overview', () => {
  assert.match(source, /async function refreshAfterTaskMutation\(\)/);
  assert.match(source, /await loadMissionDetail\(missionId\)/);
  assert.match(source, /await loadMissions\(state\.groupId\)/);
  assert.match(source, /await refreshAfterTaskMutation\(\)/);
  assert.doesNotMatch(source, /location\.reload/);
});

test('action feedback handles authentication, authorization, disappearance and conflicts', () => {
  for (const label of ['ASSIGNMENT UPDATED', 'TASK COMPLETED', 'TASK REOPENED', 'CONTRIBUTION ADDED', 'ACTION NOT PERMITTED', 'TASK OR MISSION NO LONGER AVAILABLE']) assert.ok(source.includes(label));
  assert.match(source, /response\.status === 401/);
  assert.match(source, /\[403,404,409\]\.includes\(error\.status\)/);
  assert.match(source, /draft: kind === 'contribution' \? String\(payload\.quantity \?\? ''\) : ''/);
});

test('history preserves server order and renders safe read-only contributor data', () => {
  for (const label of ['CONTRIBUTIONS', 'FORMER USER', 'contributor_name', 'entry.quantity', 'entry.created_at']) assert.ok(source.includes(label));
  assert.match(source, /historyRows\.map\(entry =>/);
  assert.doesNotMatch(source, /historyRows\.sort|task\[['"]contrib[^\]]+\]\.sort/);
  assert.doesNotMatch(source, /data-contribution-(edit|delete)/);
});

test('existing navigation, search, former-member and creation contracts remain present', () => {
  assert.match(source, /renderMissionResults\(\)/);
  assert.match(source, /memberName\(mission, userId\) \|\| 'FORMER MEMBER'/);
  assert.match(source, /data-mission-create/);
  assert.match(source, /data-task-create/);
  assert.doesNotMatch(source, /#missions\/|#mission\/|\?mission=/);
});
