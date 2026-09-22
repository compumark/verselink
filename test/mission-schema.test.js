import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const schema = async () => readFile(new URL('../src/server.js', import.meta.url), 'utf8');

test('defines repeat-safe mission tables with UUID primary keys', async () => {
  const source = await schema();
  for (const table of ['missions', 'mission_tasks', 'mission_task_contributions']) {
    assert.match(source, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?id uuid PRIMARY KEY DEFAULT gen_random_uuid\\(\\)`));
  }
});

test('binds missions to groups and preserves mission history when users are deleted', async () => {
  const source = await schema();
  assert.match(source, /group_id uuid NOT NULL REFERENCES blueprint_groups\(id\) ON DELETE CASCADE/);
  assert.match(source, /created_by uuid REFERENCES app_users\(id\) ON DELETE SET NULL/);
  assert.match(source, /title text NOT NULL CHECK \(btrim\(title\) <> ''\)/);
  assert.match(source, /status text NOT NULL DEFAULT 'open' CHECK \(status IN \('open','in_progress','completed','cancelled'\)\)/);
});

test('limits direct mission tasks to valid checklist and item combinations', async () => {
  const source = await schema();
  assert.match(source, /mission_id uuid NOT NULL REFERENCES missions\(id\) ON DELETE CASCADE/);
  assert.match(source, /type text NOT NULL CHECK \(type IN \('checklist','item'\)\)/);
  assert.match(source, /assigned_to uuid REFERENCES app_users\(id\) ON DELETE SET NULL/);
  assert.match(source, /\(type = 'checklist' AND target_quantity IS NULL\)\s+OR \(type = 'item' AND target_quantity > 0\)/);
  assert.match(source, /sort_order integer NOT NULL DEFAULT 0/);
});

test('stores positive item progress as separate contribution history', async () => {
  const source = await schema();
  assert.match(source, /task_id uuid NOT NULL REFERENCES mission_tasks\(id\) ON DELETE CASCADE/);
  assert.match(source, /app_user_id uuid REFERENCES app_users\(id\) ON DELETE SET NULL/);
  assert.match(source, /quantity numeric NOT NULL CHECK \(quantity > 0\)/);
  assert.doesNotMatch(source, /mission_tasks[\s\S]*?current_quantity/);
});

test('creates indexes for mission, task, and contribution lookups', async () => {
  const source = await schema();
  for (const index of [
    'missions_group_idx ON missions(group_id)',
    'missions_status_idx ON missions(status)',
    'mission_tasks_mission_idx ON mission_tasks(mission_id)',
    'mission_tasks_assigned_to_idx ON mission_tasks(assigned_to)',
    'mission_tasks_status_idx ON mission_tasks(status)',
    'mission_task_contributions_task_idx ON mission_task_contributions(task_id)',
    'mission_task_contributions_app_user_idx ON mission_task_contributions(app_user_id)'
  ]) assert.ok(source.includes(`CREATE INDEX IF NOT EXISTS ${index};`), `missing index: ${index}`);
});
