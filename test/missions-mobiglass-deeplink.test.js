import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/js/missions-mobiglass.js', import.meta.url), 'utf8');

test('mission locators use the documented URL parameters and native URL APIs', () => {
  assert.match(source, /new URLSearchParams\(location\.search\)/);
  for (const key of ['group_id', 'mission_id', 'task_id']) assert.ok(source.includes(key));
  assert.match(source, /url\.hash = 'missions'/);
  assert.match(source, /const uuid =/);
});

test('mission navigation syncs history and clears locator state on overview navigation', () => {
  assert.match(source, /setMissionLocation/);
  assert.match(source, /clearMissionLocation/);
  assert.match(source, /mode === 'replace' \? 'replaceState' : 'pushState'/);
  assert.match(source, /const backToMissions[\s\S]*focusTaskId = null[\s\S]*clearMissionLocation/);
  assert.doesNotMatch(source, /location\.reload/);
});

test('direct and pending locators resolve only through groups and authorized mission detail', () => {
  assert.match(source, /window\.pendingMissionNavigation \|\| missionLocatorFromUrl\(\)/);
  assert.match(source, /window\.pendingMissionNavigation = null/);
  assert.match(source, /loadGroups\(locator\.groupId\)/);
  assert.match(source, /mission\.group_id !== options\.requestedGroupId/);
  assert.match(source, /MISSION ACCESS CHANGED/);
  assert.match(source, /MISSION NOT FOUND/);
});

test('task targeting stays within the loaded mission detail and scrolls only a matching task', () => {
  assert.match(source, /data-mission-task-id/);
  assert.match(source, /mission-task-focus/);
  assert.match(source, /mission\.tasks\?\.some\(task => task\.id === options\.taskId\)/);
  assert.match(source, /TASK NO LONGER AVAILABLE/);
  assert.match(source, /scrollIntoView\(\{ block: 'center', behavior: 'smooth' \}\)/);
  assert.doesNotMatch(source, /missions\/${encodeURIComponent\(missionId\)}\/tasks/);
});

test('browser history reevaluates locators without pushing a new state', () => {
  assert.match(source, /window\.addEventListener\('popstate'/);
  const handler = source.match(/window\.addEventListener\('popstate',[\s\S]*?\n/)?.[0] || '';
  assert.doesNotMatch(handler, /setMissionLocation/);
});
