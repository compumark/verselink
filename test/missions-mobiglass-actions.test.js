import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/js/missions-mobiglass.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));

test('group, mission-list, and mission-detail reads use independent freshness generations', () => {
  for (const counter of ['groupRequestGeneration', 'missionListRequestGeneration', 'missionDetailRequestGeneration']) assert.match(source, new RegExp(`let ${counter} = 0`));
  assert.doesNotMatch(source, /let requestGeneration = 0/);
  const groups = section('async function loadGroups(', 'async function loadMissions(');
  const list = section('async function loadMissions(', 'async function submitDialog(');
  const detail = section('async function loadMissionDetail(', 'async function refreshAfterTaskMutation(');
  assert.match(groups, /\+\+groupRequestGeneration/);
  assert.doesNotMatch(groups, /missionDetailRequestGeneration/);
  assert.match(list, /\+\+missionListRequestGeneration/);
  assert.match(list, /isMissionListRequestLive\(generation, groupId\)/);
  assert.doesNotMatch(list, /groupRequestGeneration|missionDetailRequestGeneration/);
  assert.match(detail, /\+\+missionDetailRequestGeneration/);
  assert.match(detail, /isMissionDetailRequestLive\(generation, missionId\)/);
  assert.doesNotMatch(detail, /groupRequestGeneration|missionListRequestGeneration/);
  assert.match(source, /const backToMissions = \(\) => \{ \+\+missionDetailRequestGeneration/);
});

test('task actions are isolated by key and block only duplicate requests', () => {
  assert.match(source, /taskActions: \{\}/);
  assert.match(source, /const actionKey = \(taskId, kind\) => `\$\{taskId\}:\$\{kind\}`/);
  assert.match(source, /const taskActionFor = \(taskId, kind\) => state\.taskActions\[actionKey\(taskId, kind\)\] \|\| \{\}/);
  assert.match(source, /const isTaskPending = taskId => Object\.entries\(state\.taskActions\)\.some/);
  assert.match(source, /if \(existing\.pending\) return/);
  assert.match(source, /state\.taskActions = \{ \.\.\.state\.taskActions, \[key\]:/);
  assert.match(source, /Object\.entries\(state\.taskActions\)\.filter/);
});

test('former-member assignment requires an explicit selection before it can mutate', () => {
  assert.match(source, /const assignment = manage \?/);
  assert.match(source, /members = groupFor\(mission\)\?\.members \|\| \[\]/);
  assert.match(source, /<option value="__former__"/);
  assert.match(source, /disabled>FORMER MEMBER<\/option>/);
  assert.match(source, /assignmentBlocked = former && assignmentDraft === undefined/);
  assert.match(source, /pending \|\| assignmentBlocked \? 'disabled' : ''/);
  assert.match(source, /APPLY ASSIGNMENT/);
  assert.match(source, /selected === '__former__'/);
  assert.match(source, /former && taskActionFor\(taskId, 'assignment'\)\.draft === undefined/);
  assert.match(source, /\{ \[assignmentField\]: selected \|\| null \}/);
  assert.match(source, /draft: assignment\.value/);
  assert.doesNotMatch(source, /\{ \[assignmentField\]: '__former__'/);
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
  assert.match(source, /const missionId = state\.selectedMissionId, groupId = state\.groupId/);
  assert.match(source, /state\.selectedMissionId === missionId && state\.groupId === groupId/);
  assert.match(source, /await loadMissions\(groupId\)/);
  assert.match(source, /await refreshAfterTaskMutation\(\)/);
  assert.doesNotMatch(source, /location\.reload/);
});

test('action feedback handles authentication, authorization, disappearance and conflicts', () => {
  for (const label of ['ASSIGNMENT UPDATED', 'TASK COMPLETED', 'TASK REOPENED', 'CONTRIBUTION ADDED', 'ACTION NOT PERMITTED', 'TASK OR MISSION NO LONGER AVAILABLE']) assert.ok(source.includes(label));
  assert.match(source, /response\.status === 401/);
  assert.match(source, /\[403,404,409\]\.includes\(error\.status\)/);
  assert.match(source, /error: error\.message, success: '', draft/);
  assert.match(source, /state\.taskActions = \{ \.\.\.state\.taskActions, \[key\]:/);
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
  assert.doesNotMatch(source, /#missions\/|#mission\//);
});
