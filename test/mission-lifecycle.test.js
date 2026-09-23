import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');

test('membership cleanup keeps historical task assignments and contributions intact', () => {
  const helper = source.slice(source.indexOf('const unassignOpenMissionTasksForFormerMember'), source.indexOf('const unassignOpenMissionTasksForInactiveUser'));
  assert.match(helper, /status IN \('open','in_progress'\)/);
  assert.match(helper, /SET assigned_to=NULL/);
  assert.doesNotMatch(helper, /mission_task_contributions|app_notifications/);
});

test('non-active account status atomically clears only active mission assignments', () => {
  const route = source.slice(source.indexOf('url.pathname === "\/api\/admin\/users\/status"'), source.indexOf('url.pathname === "\/api\/admin\/users\/delete"'));
  assert.match(source, /const unassignOpenMissionTasksForInactiveUser/);
  assert.match(source, /WHERE assigned_to=\$1 AND status IN \('open','in_progress'\)/);
  assert.match(route, /BEGIN/);
  assert.match(route, /UPDATE app_users SET account_status=\$1 WHERE id=\$2 AND id<>\$3 RETURNING id/);
  assert.match(route, /if \(!updated\.rowCount\) \{ await client\.query\("ROLLBACK"\); return json\(res, 400/);
  assert.match(route, /DELETE FROM dashboard_sessions/);
  assert.match(route, /unassignOpenMissionTasksForInactiveUser\(client, userId\)/);
  assert.match(route, /COMMIT/);
  assert.match(route, /ROLLBACK/);
});

test('hard delete removes groups only for the current owner, not historical creators', () => {
  const route = source.slice(source.indexOf('url.pathname === "\/api\/admin\/users\/delete"'));
  assert.match(route, /DELETE FROM blueprint_groups g WHERE EXISTS/);
  assert.match(route, /gm\.app_user_id=\$1 AND gm\.role='owner'/);
  assert.doesNotMatch(route, /DELETE FROM blueprint_groups WHERE created_by/);
  assert.match(route, /UPDATE blueprint_groups SET created_by=NULL WHERE created_by=\$1/);
});
