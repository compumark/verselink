import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  apiRequest,
  createSession,
  createTestPool,
  resetMissionTestDatabase,
  startMissionTestServer,
  stopMissionTestServer
} from './helpers/mission-integration.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const pepper = 'mission-integration-test-pepper';

test('CI provides the PostgreSQL mission test database', () => {
  if (process.env.CI) assert.ok(databaseUrl, 'TEST_DATABASE_URL must be set in CI');
});

test('mission backend works through real HTTP and PostgreSQL', { skip: !databaseUrl }, async (t) => {
  let runtime;
  let pool;
  try {
    runtime = await startMissionTestServer({ databaseUrl, pepper });
    pool = await createTestPool(databaseUrl);
    await resetMissionTestDatabase(pool);

    const users = {
      owner: randomUUID(),
      member: randomUUID(),
      assignee: randomUUID(),
      outsider: randomUUID()
    };
    const groups = { a: randomUUID(), b: randomUUID() };

    await pool.query(
      `INSERT INTO app_users (id,email,display_name,verselink_name,account_status) VALUES
       ($1,$2,$3,$3,'active'),($4,$5,$6,$6,'active'),($7,$8,$9,$9,'active'),($10,$11,$12,$12,'active')`,
      [
        users.owner, `owner-${users.owner}@example.test`, 'Mission Owner',
        users.member, `member-${users.member}@example.test`, 'Mission Member',
        users.assignee, `assignee-${users.assignee}@example.test`, 'Mission Assignee',
        users.outsider, `outsider-${users.outsider}@example.test`, 'Mission Outsider'
      ]
    );
    await pool.query(
      'INSERT INTO blueprint_groups (id,name,created_by) VALUES ($1,$2,$3),($4,$5,$6)',
      [groups.a, 'Mission Group A', users.owner, groups.b, 'Mission Group B', users.outsider]
    );
    await pool.query(
      `INSERT INTO group_members (group_id,app_user_id,role) VALUES
       ($1,$2,'owner'),($1,$3,'member'),($1,$4,'member'),($5,$6,'owner')`,
      [groups.a, users.owner, users.member, users.assignee, groups.b, users.outsider]
    );

    const sessions = {
      owner: await createSession(pool, pepper, users.owner),
      member: await createSession(pool, pepper, users.member),
      assignee: await createSession(pool, pepper, users.assignee),
      outsider: await createSession(pool, pepper, users.outsider)
    };
    const request = (path, options) => apiRequest(runtime.baseUrl, path, options);
    const json = (session, method, path, body) => request(path, { session, method, json: body });
    const form = (session, path, body) => request(path, { session, method: 'POST', form: body });
    const createMission = async (title, groupId = groups.a) => {
      const response = await json(sessions.owner, 'POST', '/api/missions', { group_id: groupId, title });
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return response.body.mission;
    };
    const createTask = async (missionId, body) => {
      const response = await json(sessions.owner, 'POST', `/api/missions/${missionId}/tasks`, body);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      return response.body;
    };

    let coreMission;
    let checklistTask;
    let itemTask;

    await t.test('authenticates real sessions and enforces API and group isolation', async () => {
      coreMission = await createMission('Backend integration flow');
      let response = await request(`/api/missions/${coreMission.id}`, { session: sessions.owner });
      assert.equal(response.status, 200);
      assert.equal(response.body.mission.status, 'open');
      assert.equal(Number(response.body.mission.progress_percent), 0);
      assert.equal(response.body.mission.active_task_count, 0);

      checklistTask = (await createTask(coreMission.id, {
        type: 'checklist', title: 'Confirm route', assigned_to: users.assignee, sort_order: 1
      })).task;
      itemTask = (await createTask(coreMission.id, {
        type: 'item', title: 'Deliver cargo', assigned_to: users.assignee,
        target_quantity: 10, unit: 'SCU', sort_order: 2
      })).task;

      response = await request(`/api/missions?group_id=${groups.a}`, { session: sessions.member });
      assert.equal(response.status, 200);
      assert.ok(response.body.missions.some((mission) => mission.id === coreMission.id));
      response = await request(`/api/missions/${coreMission.id}`, { session: sessions.member });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.mission.tasks.map((task) => task.id), [checklistTask.id, itemTask.id]);

      for (const unauthenticated of [
        request(`/api/missions?group_id=${groups.a}`),
        json(undefined, 'POST', '/api/missions', { group_id: groups.a, title: 'No session' }),
        json(undefined, 'POST', `/api/missions/${coreMission.id}/tasks`, { type: 'checklist', title: 'No session' }),
        json(undefined, 'PATCH', `/api/missions/${coreMission.id}/tasks/${checklistTask.id}`, { status: 'completed' }),
        json(undefined, 'POST', `/api/missions/${coreMission.id}/tasks/${itemTask.id}/contributions`, { quantity: 1 })
      ]) assert.equal((await unauthenticated).status, 401);

      assert.equal((await request(`/api/missions?group_id=${groups.a}`, { session: sessions.outsider })).status, 403);
      assert.equal((await request(`/api/missions/${coreMission.id}`, { session: sessions.outsider })).status, 404);
      assert.equal((await json(sessions.outsider, 'PATCH', `/api/missions/${coreMission.id}/tasks/${checklistTask.id}`, { status: 'completed' })).status, 404);
      assert.equal((await json(sessions.outsider, 'POST', `/api/missions/${coreMission.id}/tasks/${itemTask.id}/contributions`, { quantity: 1 })).status, 404);

      assert.equal((await json(sessions.member, 'PATCH', `/api/missions/${coreMission.id}/tasks/${itemTask.id}`, { title: 'Denied' })).status, 403);
      assert.equal((await json(sessions.member, 'POST', `/api/missions/${coreMission.id}/tasks`, { type: 'checklist', title: 'Denied' })).status, 403);
      assert.equal((await json(sessions.member, 'PATCH', `/api/missions/${coreMission.id}/tasks/${checklistTask.id}`, { status: 'completed' })).status, 403);
      assert.equal((await json(sessions.member, 'POST', `/api/missions/${coreMission.id}/tasks/${itemTask.id}/contributions`, { quantity: 1 })).status, 403);
      assert.equal((await json(sessions.assignee, 'PATCH', `/api/missions/${coreMission.id}/tasks/${itemTask.id}`, { title: 'Denied' })).status, 403);
      assert.equal((await json(sessions.assignee, 'PATCH', `/api/missions/${coreMission.id}`, { title: 'Denied' })).status, 403);

      response = await form(sessions.member, '/api/groups/remove-member', { group_id: groups.a, member_id: users.assignee });
      assert.equal(response.status, 200);
      assert.equal((await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND app_user_id=$2', [groups.a, users.assignee])).rowCount, 1);

      const unknownMission = randomUUID();
      const unknownTask = randomUUID();
      assert.equal((await request('/api/missions/not-a-uuid', { session: sessions.owner })).status, 400);
      assert.equal((await request(`/api/missions/${unknownMission}`, { session: sessions.owner })).status, 404);
      assert.equal((await json(sessions.owner, 'PATCH', `/api/missions/${coreMission.id}/tasks/not-a-uuid`, { title: 'Invalid' })).status, 400);
      assert.equal((await json(sessions.owner, 'PATCH', `/api/missions/${coreMission.id}/tasks/${unknownTask}`, { title: 'Unknown' })).status, 404);

      const otherMission = await createMission('Other mission');
      const otherTask = (await createTask(otherMission.id, { type: 'checklist', title: 'Other task' })).task;
      assert.equal((await json(sessions.owner, 'PATCH', `/api/missions/${coreMission.id}/tasks/${otherTask.id}`, { title: 'Wrong parent' })).status, 404);
      assert.equal((await json(sessions.owner, 'POST', `/api/missions/${unknownMission}/tasks/${unknownTask}/contributions`, { quantity: 1 })).status, 404);
    });

    await t.test('runs the checklist, item, completion, and reopen flow end to end', async () => {
      let response = await json(sessions.assignee, 'PATCH', `/api/missions/${coreMission.id}/tasks/${checklistTask.id}`, { status: 'completed' });
      assert.equal(response.status, 200);
      assert.equal(response.body.task.status, 'completed');
      assert.ok(response.body.task.completed_at);
      assert.equal(Number(response.body.task.progress_percent), 100);
      assert.equal(response.body.mission.status, 'in_progress');

      response = await json(sessions.assignee, 'PATCH', `/api/missions/${coreMission.id}/tasks/${checklistTask.id}`, { status: 'open' });
      assert.equal(response.status, 200);
      assert.equal(response.body.task.status, 'open');
      assert.equal(response.body.task.completed_at, null);
      assert.equal(Number(response.body.task.progress_percent), 0);
      assert.equal(response.body.mission.status, 'open');

      response = await json(sessions.assignee, 'POST', `/api/missions/${coreMission.id}/tasks/${itemTask.id}/contributions`, { quantity: 3 });
      assert.equal(response.status, 201);
      assert.equal(Number(response.body.task.current_quantity), 3);
      assert.equal(Number(response.body.task.remaining_quantity), 7);
      assert.equal(Number(response.body.task.progress_percent), 30);
      assert.equal(response.body.task.status, 'in_progress');

      response = await json(sessions.assignee, 'POST', `/api/missions/${coreMission.id}/tasks/${itemTask.id}/contributions`, { quantity: 7 });
      assert.equal(response.status, 201);
      assert.equal(Number(response.body.task.current_quantity), 10);
      assert.equal(Number(response.body.task.remaining_quantity), 0);
      assert.equal(Number(response.body.task.progress_percent), 100);
      assert.equal(response.body.task.status, 'completed');
      assert.ok(response.body.task.completed_at);

      response = await json(sessions.assignee, 'PATCH', `/api/missions/${coreMission.id}/tasks/${checklistTask.id}`, { status: 'completed' });
      assert.equal(response.body.mission.status, 'completed');
      assert.equal(Number(response.body.mission.progress_percent), 100);
      assert.ok(response.body.mission.completed_at);

      response = await json(sessions.assignee, 'PATCH', `/api/missions/${coreMission.id}/tasks/${checklistTask.id}`, { status: 'open' });
      assert.equal(response.body.mission.status, 'in_progress');
      assert.equal(response.body.mission.completed_at, null);
      response = await json(sessions.assignee, 'PATCH', `/api/missions/${coreMission.id}/tasks/${checklistTask.id}`, { status: 'completed' });
      assert.equal(response.body.mission.status, 'completed');

      const cancelledTaskId = randomUUID();
      await pool.query(
        `INSERT INTO mission_tasks (id,mission_id,type,title,assigned_to,target_quantity,unit,status,completed_at)
         VALUES ($1,$2,'item','Cancelled historical task',$3,5,'SCU','cancelled',now())`,
        [cancelledTaskId, coreMission.id, users.assignee]
      );
      const newTask = (await createTask(coreMission.id, {
        type: 'checklist', title: 'Reopen completed mission', assigned_to: users.assignee, sort_order: 3
      })).task;
      response = await request(`/api/missions/${coreMission.id}`, { session: sessions.owner });
      assert.equal(response.body.mission.status, 'in_progress');
      response = await json(sessions.assignee, 'PATCH', `/api/missions/${coreMission.id}/tasks/${newTask.id}`, { status: 'completed' });
      assert.equal(response.body.mission.status, 'completed');
      assert.equal(Number(response.body.mission.progress_percent), 100);
      assert.equal(response.body.mission.active_task_count, 3);

      const history = await pool.query(
        'SELECT app_user_id,quantity FROM mission_task_contributions WHERE task_id=$1 ORDER BY created_at,id',
        [itemTask.id]
      );
      assert.deepEqual(history.rows.map((row) => Number(row.quantity)), [3, 7]);
      assert.ok(history.rows.every((row) => row.app_user_id === users.assignee));
    });

    await t.test('serializes concurrent item contributions and rolls back over-target requests', async () => {
      const raceMission = await createMission('Concurrent 6 plus 6');
      const raceTask = (await createTask(raceMission.id, {
        type: 'item', title: 'Race target', assigned_to: users.assignee, target_quantity: 10, unit: 'SCU'
      })).task;
      const racePath = `/api/missions/${raceMission.id}/tasks/${raceTask.id}/contributions`;
      const race = await Promise.all([
        json(sessions.assignee, 'POST', racePath, { quantity: 6 }),
        json(sessions.assignee, 'POST', racePath, { quantity: 6 })
      ]);
      assert.deepEqual(race.map((response) => response.status).sort(), [201, 409]);
      let persisted = await pool.query(
        'SELECT COUNT(*)::int AS count,COALESCE(SUM(quantity),0) AS total FROM mission_task_contributions WHERE task_id=$1',
        [raceTask.id]
      );
      assert.equal(persisted.rows[0].count, 1);
      assert.equal(Number(persisted.rows[0].total), 6);
      let response = await request(`/api/missions/${raceMission.id}`, { session: sessions.owner });
      const raced = response.body.mission.tasks.find((task) => task.id === raceTask.id);
      assert.equal(Number(raced.current_quantity), 6);
      assert.equal(raced.status, 'in_progress');

      response = await json(sessions.assignee, 'POST', racePath, { quantity: 5 });
      assert.equal(response.status, 409);
      persisted = await pool.query(
        'SELECT COUNT(*)::int AS count,COALESCE(SUM(quantity),0) AS total FROM mission_task_contributions WHERE task_id=$1',
        [raceTask.id]
      );
      assert.equal(persisted.rows[0].count, 1);
      assert.equal(Number(persisted.rows[0].total), 6);

      const exactMission = await createMission('Concurrent 5 plus 5');
      const exactTask = (await createTask(exactMission.id, {
        type: 'item', title: 'Exact target', assigned_to: users.assignee, target_quantity: 10, unit: 'SCU'
      })).task;
      const exactPath = `/api/missions/${exactMission.id}/tasks/${exactTask.id}/contributions`;
      const exact = await Promise.all([
        json(sessions.assignee, 'POST', exactPath, { quantity: 5 }),
        json(sessions.assignee, 'POST', exactPath, { quantity: 5 })
      ]);
      assert.deepEqual(exact.map((item) => item.status).sort(), [201, 201]);
      response = await request(`/api/missions/${exactMission.id}`, { session: sessions.owner });
      const completed = response.body.mission.tasks.find((task) => task.id === exactTask.id);
      assert.equal(Number(completed.current_quantity), 10);
      assert.equal(Number(completed.progress_percent), 100);
      assert.equal(completed.status, 'completed');
      persisted = await pool.query(
        'SELECT COUNT(*)::int AS count,COALESCE(SUM(quantity),0) AS total FROM mission_task_contributions WHERE task_id=$1',
        [exactTask.id]
      );
      assert.equal(persisted.rows[0].count, 2);
      assert.equal(Number(persisted.rows[0].total), 10);
    });

    await t.test('preserves target history and cancelled item state', async () => {
      const mission = await createMission('Target and cancellation regression');
      const targetTask = (await createTask(mission.id, {
        type: 'item', title: 'Adjustable target', assigned_to: users.assignee, target_quantity: 10, unit: 'SCU'
      })).task;
      let response = await json(sessions.assignee, 'POST', `/api/missions/${mission.id}/tasks/${targetTask.id}/contributions`, { quantity: 7 });
      assert.equal(response.status, 201);
      response = await json(sessions.owner, 'PATCH', `/api/missions/${mission.id}/tasks/${targetTask.id}`, { target_quantity: 9 });
      assert.equal(response.status, 200);
      assert.equal(Number(response.body.task.target_quantity), 9);
      assert.equal(response.body.task.status, 'in_progress');
      response = await json(sessions.owner, 'PATCH', `/api/missions/${mission.id}/tasks/${targetTask.id}`, { target_quantity: 7 });
      assert.equal(response.status, 200);
      assert.equal(response.body.task.status, 'completed');
      response = await json(sessions.owner, 'PATCH', `/api/missions/${mission.id}/tasks/${targetTask.id}`, { target_quantity: 6 });
      assert.equal(response.status, 409);
      const targetHistory = await pool.query(
        'SELECT COUNT(*)::int AS count,COALESCE(SUM(quantity),0) AS total FROM mission_task_contributions WHERE task_id=$1',
        [targetTask.id]
      );
      assert.equal(targetHistory.rows[0].count, 1);
      assert.equal(Number(targetHistory.rows[0].total), 7);

      const cancelled = (await createTask(mission.id, {
        type: 'item', title: 'Cancelled item', assigned_to: users.assignee, target_quantity: 5, unit: 'SCU'
      })).task;
      await pool.query(
        "UPDATE mission_tasks SET status='cancelled',completed_at='2026-01-02T03:04:05Z' WHERE id=$1",
        [cancelled.id]
      );
      const before = await pool.query('SELECT completed_at FROM mission_tasks WHERE id=$1', [cancelled.id]);
      response = await json(sessions.owner, 'PATCH', `/api/missions/${mission.id}/tasks/${cancelled.id}`, { title: 'Still cancelled' });
      assert.equal(response.status, 200);
      assert.equal(response.body.task.status, 'cancelled');
      assert.equal(new Date(response.body.task.completed_at).toISOString(), before.rows[0].completed_at.toISOString());
      assert.equal((await json(sessions.assignee, 'POST', `/api/missions/${mission.id}/tasks/${cancelled.id}/contributions`, { quantity: 1 })).status, 409);
      const after = await pool.query('SELECT status,completed_at FROM mission_tasks WHERE id=$1', [cancelled.id]);
      assert.equal(after.rows[0].status, 'cancelled');
      assert.equal(after.rows[0].completed_at.toISOString(), before.rows[0].completed_at.toISOString());
    });

    await t.test('leaving a group unassigns only open work and preserves contribution history', async () => {
      const mission = await createMission('Leave lifecycle');
      const open = (await createTask(mission.id, {
        type: 'checklist', title: 'Open leave task', assigned_to: users.assignee
      })).task;
      const active = (await createTask(mission.id, {
        type: 'item', title: 'Active leave task', assigned_to: users.assignee, target_quantity: 10, unit: 'SCU'
      })).task;
      assert.equal((await json(sessions.assignee, 'POST', `/api/missions/${mission.id}/tasks/${active.id}/contributions`, { quantity: 2 })).status, 201);
      const completed = (await createTask(mission.id, {
        type: 'checklist', title: 'Completed leave task', assigned_to: users.assignee
      })).task;
      assert.equal((await json(sessions.assignee, 'PATCH', `/api/missions/${mission.id}/tasks/${completed.id}`, { status: 'completed' })).status, 200);
      const cancelled = (await createTask(mission.id, {
        type: 'item', title: 'Cancelled leave task', assigned_to: users.assignee, target_quantity: 4, unit: 'SCU'
      })).task;
      await pool.query("UPDATE mission_tasks SET status='cancelled',completed_at=now() WHERE id=$1", [cancelled.id]);
      const progressBefore = await request(`/api/missions/${mission.id}`, { session: sessions.owner });

      const response = await form(sessions.assignee, '/api/groups/leave', { group_id: groups.a });
      assert.equal(response.status, 200);
      assert.equal((await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND app_user_id=$2', [groups.a, users.assignee])).rowCount, 0);
      const assignments = await pool.query(
        'SELECT id,status,assigned_to FROM mission_tasks WHERE id=ANY($1::uuid[]) ORDER BY id',
        [[open.id, active.id, completed.id, cancelled.id]]
      );
      const byId = new Map(assignments.rows.map((row) => [row.id, row]));
      assert.equal(byId.get(open.id).assigned_to, null);
      assert.equal(byId.get(active.id).assigned_to, null);
      assert.equal(byId.get(completed.id).assigned_to, users.assignee);
      assert.equal(byId.get(cancelled.id).assigned_to, users.assignee);
      const history = await pool.query('SELECT app_user_id,quantity FROM mission_task_contributions WHERE task_id=$1', [active.id]);
      assert.equal(history.rowCount, 1);
      assert.equal(history.rows[0].app_user_id, users.assignee);
      assert.equal(Number(history.rows[0].quantity), 2);
      const progressAfter = await request(`/api/missions/${mission.id}`, { session: sessions.owner });
      assert.equal(progressAfter.body.mission.status, progressBefore.body.mission.status);
      assert.equal(Number(progressAfter.body.mission.progress_percent), Number(progressBefore.body.mission.progress_percent));

      const ownerTask = (await createTask(mission.id, {
        type: 'checklist', title: 'Owner assignment', assigned_to: users.owner
      })).task;
      assert.equal((await form(sessions.owner, '/api/groups/leave', { group_id: groups.a })).status, 200);
      assert.equal((await pool.query("SELECT 1 FROM group_members WHERE group_id=$1 AND app_user_id=$2 AND role='owner'", [groups.a, users.owner])).rowCount, 1);
      assert.equal((await pool.query('SELECT assigned_to FROM mission_tasks WHERE id=$1', [ownerTask.id])).rows[0].assigned_to, users.owner);
    });

    await t.test('owner removal unassigns open work but keeps final assignments and history', async () => {
      const mission = await createMission('Remove member lifecycle');
      const open = (await createTask(mission.id, {
        type: 'checklist', title: 'Open removal task', assigned_to: users.member
      })).task;
      const active = (await createTask(mission.id, {
        type: 'item', title: 'Active removal task', assigned_to: users.member, target_quantity: 10, unit: 'SCU'
      })).task;
      assert.equal((await json(sessions.member, 'POST', `/api/missions/${mission.id}/tasks/${active.id}/contributions`, { quantity: 4 })).status, 201);
      const completed = (await createTask(mission.id, {
        type: 'checklist', title: 'Completed removal task', assigned_to: users.member
      })).task;
      assert.equal((await json(sessions.member, 'PATCH', `/api/missions/${mission.id}/tasks/${completed.id}`, { status: 'completed' })).status, 200);
      const cancelled = (await createTask(mission.id, {
        type: 'item', title: 'Cancelled removal task', assigned_to: users.member, target_quantity: 4, unit: 'SCU'
      })).task;
      await pool.query("UPDATE mission_tasks SET status='cancelled',completed_at=now() WHERE id=$1", [cancelled.id]);

      let response = await form(sessions.owner, '/api/groups/remove-member', { group_id: groups.a, member_id: users.member });
      assert.equal(response.status, 200);
      assert.equal((await pool.query('SELECT 1 FROM group_members WHERE group_id=$1 AND app_user_id=$2', [groups.a, users.member])).rowCount, 0);
      const assignments = await pool.query(
        'SELECT id,status,assigned_to FROM mission_tasks WHERE id=ANY($1::uuid[]) ORDER BY id',
        [[open.id, active.id, completed.id, cancelled.id]]
      );
      const byId = new Map(assignments.rows.map((row) => [row.id, row]));
      assert.equal(byId.get(open.id).assigned_to, null);
      assert.equal(byId.get(active.id).assigned_to, null);
      assert.equal(byId.get(completed.id).assigned_to, users.member);
      assert.equal(byId.get(cancelled.id).assigned_to, users.member);
      const history = await pool.query('SELECT app_user_id,quantity FROM mission_task_contributions WHERE task_id=$1', [active.id]);
      assert.equal(history.rowCount, 1);
      assert.equal(history.rows[0].app_user_id, users.member);
      assert.equal(Number(history.rows[0].quantity), 4);

      const untouched = randomUUID();
      await pool.query(
        "INSERT INTO mission_tasks (id,mission_id,type,title,assigned_to,status) VALUES ($1,$2,'checklist','No membership row',$3,'open')",
        [untouched, mission.id, users.outsider]
      );
      response = await form(sessions.owner, '/api/groups/remove-member', { group_id: groups.a, member_id: users.outsider });
      assert.equal(response.status, 200);
      assert.equal((await pool.query('SELECT assigned_to FROM mission_tasks WHERE id=$1', [untouched])).rows[0].assigned_to, users.outsider);
    });
  } finally {
    if (pool) {
      await resetMissionTestDatabase(pool).catch(() => {});
      await pool.end();
    }
    await stopMissionTestServer(runtime);
  }
});
