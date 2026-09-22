import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const taskRoutes = source.slice(source.indexOf('const loadMissionAccess'), source.indexOf('const miningAccess'));

test('task mutations require an active VerseLink session and mission management access', () => {
  assert.ok(taskRoutes.includes('getCurrentAppUser(req)'));
  assert.ok(taskRoutes.includes('return json(res, 401, { error: "login required" })'));
  assert.ok(taskRoutes.includes('current.is_admin || mission.created_by === current.id || mission.role === "owner"'));
  assert.ok(taskRoutes.includes('mission creator, group owner, or app admin required'));
});

test('task routes hide cross-group missions and require matching mission and task ids', () => {
  assert.ok(taskRoutes.includes('!mission || (!mission.role && !current.is_admin)'));
  assert.ok(taskRoutes.includes('return json(res, 404, { error: "mission not found" })'));
  assert.ok(taskRoutes.includes('WHERE id=$1 AND mission_id=$2'));
  assert.ok(taskRoutes.includes('return json(res, 404, { error: "task not found" })'));
});

test('checklist and item task creation preserve schema invariants', () => {
  assert.ok(taskRoutes.includes("['checklist', 'item'].includes(type)"));
  assert.ok(taskRoutes.includes("type === 'checklist' && (data.target_quantity !== undefined && data.target_quantity !== null || unit !== null)"));
  assert.ok(taskRoutes.includes("type === 'item' && (!Number.isFinite(targetQuantity) || targetQuantity <= 0)"));
  assert.ok(taskRoutes.includes("VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8)"));
  assert.ok(taskRoutes.includes('sort_order === undefined ? 0'));
});

test('assignment accepts only active members of the mission group and supports null', () => {
  assert.ok(taskRoutes.includes("if (assignedTo === null) return true"));
  assert.ok(taskRoutes.includes('uuidPattern.test(assignedTo)'));
  assert.ok(taskRoutes.includes("gm.group_id=$2 AND u.account_status='active'"));
  assert.ok(taskRoutes.includes('assignee must be an active group member'));
});

test('task patch permits metadata only and revalidates item invariants', () => {
  assert.ok(taskRoutes.includes('new Set(["title", "description", "assigned_to", "target_quantity", "unit", "sort_order"])'));
  assert.ok(taskRoutes.includes('only task metadata can be changed'));
  assert.ok(taskRoutes.includes("existing.type === 'item' && (!Number.isFinite(targetQuantity) || targetQuantity <= 0)"));
  assert.ok(taskRoutes.includes('Object.hasOwn(data, "assigned_to") && !await validateAssignee(assignedTo)'));
  assert.ok(taskRoutes.includes('updated_at=now()'));
});
