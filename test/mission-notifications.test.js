import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [server, ui] = await Promise.all([
  readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/js/notifications-mobiglass.js', import.meta.url), 'utf8')
]);

test('mission notification references migrate repeat-safely with cascading foreign keys and indexes', () => {
  assert.match(server, /ALTER TABLE app_notifications ADD COLUMN IF NOT EXISTS mission_id uuid/);
  assert.match(server, /ALTER TABLE app_notifications ADD COLUMN IF NOT EXISTS mission_task_id uuid/);
  assert.match(server, /app_notifications_mission_fk[\s\S]*FOREIGN KEY \(mission_id\) REFERENCES missions\(id\) ON DELETE CASCADE/);
  assert.match(server, /app_notifications_mission_task_fk[\s\S]*FOREIGN KEY \(mission_task_id\) REFERENCES mission_tasks\(id\) ON DELETE CASCADE/);
  assert.match(server, /mission_task_id IS NULL OR mission_id IS NOT NULL/);
  assert.match(server, /CREATE INDEX IF NOT EXISTS app_notifications_mission_idx ON app_notifications\(mission_id\)/);
  assert.match(server, /CREATE INDEX IF NOT EXISTS app_notifications_mission_task_idx ON app_notifications\(mission_task_id\)/);
});

test('mission notification helpers enforce active group membership, self suppression, and completion deduplication', () => {
  const helpers = server.slice(server.indexOf('const missionActorName'), server.indexOf('const loadMissionAccess'));
  assert.match(helpers, /recipientId === actorId/);
  assert.match(helpers, /JOIN group_members gm ON gm\.app_user_id=u\.id AND gm\.group_id=\$3/);
  assert.match(helpers, /u\.account_status='active'/);
  assert.match(helpers, /SELECT DISTINCT candidates\.app_user_id/);
  assert.match(helpers, /m\.created_by AS app_user_id/);
  assert.match(helpers, /t\.status<>'cancelled'/);
  assert.match(helpers, /owner_member\.role='owner'/);
  assert.doesNotMatch(helpers, /is_admin/);
});

test('mission mutations emit stable kinds transactionally after validation', () => {
  for (const kind of [
    'mission_task_assigned', 'mission_task_reassigned', 'mission_task_unassigned',
    'mission_task_completed', 'mission_task_reopened', 'mission_item_contribution', 'mission_completed'
  ]) assert.ok(server.includes(`'${kind}'`), `missing kind: ${kind}`);
  assert.match(server, /BEGIN[\s\S]*INSERT INTO mission_tasks[\s\S]*insertMissionNotification[\s\S]*COMMIT/);
  assert.match(server, /contribution exceeds target quantity[\s\S]*INSERT INTO mission_task_contributions[\s\S]*insertMissionNotification[\s\S]*COMMIT/);
  assert.match(server, /previousStatus !== 'completed' && mission\?\.status === 'completed'/);
  assert.match(server, /missionActorName = current => current\.verselink_name \|\| current\.display_name \|\| "A member"/);
  assert.match(server, /order_claimed/);
  assert.match(server, /order_completed/);
});

test('notification API adds mission context without removing order context', () => {
  const route = server.slice(server.indexOf('url.pathname === "/api/notifications"'), server.indexOf('url.pathname === "/api/notifications/read"'));
  for (const field of ['n.order_id', 'n.mission_id', 'n.mission_task_id', 'o.order_number', 'm.title AS mission_title', 'mt.title AS mission_task_title']) assert.ok(route.includes(field), `missing notification field: ${field}`);
  assert.match(route, /COALESCE\(o\.group_id,m\.group_id\) AS group_id/);
  assert.match(route, /mt\.id=n\.mission_task_id AND mt\.mission_id=n\.mission_id/);
  assert.match(route, /WHERE n\.app_user_id=\$1/);
});

test('notification center renders mission context and keeps mission navigation distinct from orders', () => {
  assert.match(ui, /MISSION · \$\{esc\(n\.mission_title\)\}/);
  assert.match(ui, /TASK · \$\{esc\(n\.mission_task_title\)\}/);
  assert.match(ui, /pendingMissionNavigation=/);
  assert.match(ui, /mission_id/);
  assert.match(ui, /mission_task_id/);
  assert.match(ui, /url\.hash='missions'/);
  assert.match(ui, /pendingOrderNavigation=n\.order_id/);
  assert.match(ui, /markNotificationRead/);
  assert.match(ui, /notification-badge/);
  assert.match(ui, /NOTIFICATION_POLL_INTERVAL_MS/);
});
