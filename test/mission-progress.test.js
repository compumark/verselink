import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const progress = source.slice(source.indexOf('const taskResponseColumns'), source.indexOf('const miningAccess'));

test('mission reads expose derived task and mission progress', () => {
  for (const field of ['current_quantity', 'remaining_quantity', 'progress_percent', 'active_task_count']) assert.ok(progress.includes(field));
  assert.ok(progress.includes('COALESCE(SUM(quantity),0) AS current_quantity'));
  assert.ok(progress.includes("WHERE t.mission_id=m.id AND t.status<>'cancelled'"));
  assert.ok(progress.includes('ORDER BY t.sort_order ASC,t.created_at ASC,t.id ASC'));
  assert.ok(progress.includes('mission: { ...response, tasks }'));
});

test('mission recalculation averages active task progress and handles completion boundaries', () => {
  assert.ok(progress.includes('AVG(CASE WHEN t.type=\'checklist\''));
  assert.ok(progress.includes("WHERE t.mission_id=$1 AND t.status<>'cancelled'"));
  assert.ok(progress.includes("WHEN s.active_task_count=0 THEN 'open'"));
  assert.ok(progress.includes("WHEN s.completed_task_count=s.active_task_count THEN 'completed'"));
  assert.ok(progress.includes("WHEN s.progressed_task_count>0 THEN 'in_progress'"));
  assert.ok(progress.includes("WHEN m.status='cancelled' THEN m.status"));
});

test('checklist progress is status-only and authorized for assignees or mission managers', () => {
  assert.ok(progress.includes('status changes must be status-only'));
  assert.ok(progress.includes('existing.type !== "checklist"'));
  assert.ok(progress.includes('["open", "completed"].includes(data.status)'));
  assert.ok(progress.includes('existing.assigned_to !== current.id'));
  assert.ok(progress.includes("completed_at=CASE WHEN $1='completed' THEN COALESCE(completed_at,now()) ELSE NULL END"));
  assert.ok(progress.includes('cancelled checklist cannot be changed'));
});

test('item contributions use session identity and a row-locked transaction', () => {
  assert.ok(progress.includes('/contributions$/'));
  assert.ok(progress.includes('const client = await pool.connect()'));
  assert.ok(progress.includes('await client.query("BEGIN")'));
  assert.ok(progress.includes('FOR UPDATE'));
  assert.ok(progress.includes('await client.query("COMMIT")'));
  assert.ok(progress.includes('await client.query("ROLLBACK")'));
  assert.ok(progress.includes('client.release()'));
  assert.ok(progress.includes('[taskId, current.id, data.quantity]'));
  assert.ok(!progress.includes('data.app_user_id'));
  assert.ok(!progress.includes('data.contributor_id'));
});

test('item contributions enforce type, authorization, positivity, and numeric over-target checks', () => {
  assert.ok(progress.includes('typeof data.quantity !== "number"'));
  assert.ok(progress.includes('!Number.isFinite(data.quantity) || data.quantity <= 0'));
  assert.ok(progress.includes('existing.type !== "item"'));
  assert.ok(progress.includes('cancelled item cannot receive contributions'));
  assert.ok(progress.includes('existing.assigned_to !== current.id'));
  assert.ok(progress.includes('COALESCE(SUM(quantity),0)+$2::numeric <= $3::numeric AS within_target'));
  assert.ok(progress.includes('contribution exceeds target quantity'));
  assert.ok(progress.includes('INSERT INTO mission_task_contributions (task_id,app_user_id,quantity)'));
});

test('item status and target changes remain server-authoritative', () => {
  assert.ok(progress.includes("WHEN contribution_total.current_quantity=0 THEN 'open'"));
  assert.ok(progress.includes("WHEN contribution_total.current_quantity>=target_quantity THEN 'completed' ELSE 'in_progress'"));
  assert.ok(progress.includes('target quantity cannot be below current quantity'));
  assert.ok(progress.includes('COALESCE(SUM(quantity),0) <= $2::numeric AS valid'));
  assert.ok(progress.includes('completed_at=CASE WHEN type=\'item\''));
  assert.ok(progress.includes('new Set(["title", "description", "assigned_to", "target_quantity", "unit", "sort_order"])'));
});

test('task creation and every progress mutation recalculate mission status', () => {
  assert.ok(progress.includes('const recalculateMissionStatus'));
  assert.ok(progress.includes('SELECT id FROM missions WHERE id=$1 FOR UPDATE'));
  assert.ok(progress.includes('const missionResponse = await recalculateMissionStatus(client, missionId)'));
  assert.ok(progress.includes('return json(res, 201, { task: taskResponse, mission: missionResponse })'));
  assert.ok(progress.includes('return json(res, 200, { task: taskResponse, mission: missionResponse })'));
});
