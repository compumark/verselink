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

    await t.test('creates mission collaboration notifications transactionally for active group recipients', async () => {
      const schema = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='app_notifications' AND column_name IN ('mission_id','mission_task_id') ORDER BY column_name`
      );
      assert.deepEqual(schema.rows.map((row) => row.column_name), ['mission_id', 'mission_task_id']);
      const constraints = await pool.query(
        `SELECT conname,confdeltype FROM pg_constraint
         WHERE conname IN ('app_notifications_mission_fk','app_notifications_mission_task_fk') ORDER BY conname`
      );
      assert.equal(constraints.rowCount, 2);
      assert.ok(constraints.rows.every((row) => row.confdeltype === 'c'));

      await pool.query('DELETE FROM app_notifications');
      const assignmentMission = await createMission('Notification assignment');
      const assigned = (await createTask(assignmentMission.id, {
        type: 'checklist', title: 'Assigned checklist', assigned_to: users.assignee
      })).task;
      let notifications = await pool.query(
        'SELECT app_user_id,kind,mission_id,mission_task_id FROM app_notifications ORDER BY created_at,id'
      );
      assert.deepEqual(notifications.rows, [{
        app_user_id: users.assignee, kind: 'mission_task_assigned',
        mission_id: assignmentMission.id, mission_task_id: assigned.id
      }]);
      let response = await request('/api/notifications', { session: sessions.assignee });
      assert.equal(response.status, 200);
      assert.equal(response.body.notifications[0].mission_id, assignmentMission.id);
      assert.equal(response.body.notifications[0].mission_task_id, assigned.id);
      assert.equal(response.body.notifications[0].mission_title, 'Notification assignment');
      assert.equal(response.body.notifications[0].mission_task_title, 'Assigned checklist');
      assert.equal(response.body.notifications[0].group_id, groups.a);
      assert.equal((await request('/api/notifications', { session: sessions.member })).body.notifications.length, 0);

      await pool.query('DELETE FROM app_notifications');
      response = await json(sessions.owner, 'PATCH', `/api/missions/${assignmentMission.id}/tasks/${assigned.id}`, { assigned_to: users.member });
      assert.equal(response.status, 200);
      notifications = await pool.query('SELECT app_user_id,kind FROM app_notifications ORDER BY kind,app_user_id');
      assert.deepEqual(new Set(notifications.rows.map((row) => `${row.app_user_id}:${row.kind}`)), new Set([
        `${users.member}:mission_task_reassigned`, `${users.assignee}:mission_task_unassigned`
      ]));

      const selfTask = (await createTask(assignmentMission.id, {
        type: 'checklist', title: 'Owner self assignment', assigned_to: users.owner
      })).task;
      assert.equal((await pool.query("SELECT 1 FROM app_notifications WHERE app_user_id=$1 AND kind='mission_task_assigned'", [users.owner])).rowCount, 0);
      await pool.query('DELETE FROM app_notifications');
      response = await json(sessions.owner, 'PATCH', `/api/missions/${assignmentMission.id}/tasks/${selfTask.id}`, { assigned_to: users.owner });
      assert.equal(response.status, 200);
      assert.equal((await pool.query('SELECT 1 FROM app_notifications')).rowCount, 0);
      response = await json(sessions.owner, 'PATCH', `/api/missions/${assignmentMission.id}/tasks/${selfTask.id}`, { assigned_to: null });
      assert.equal(response.status, 200);
      assert.equal((await pool.query('SELECT 1 FROM app_notifications')).rowCount, 0);

      await pool.query('DELETE FROM app_notifications');
      response = await json(sessions.owner, 'PATCH', `/api/missions/${assignmentMission.id}/tasks/${assigned.id}`, { status: 'completed' });
      assert.equal(response.status, 200);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM app_notifications WHERE app_user_id=$1 AND kind='mission_task_completed'", [users.member])).rows[0].count, 1);
      response = await json(sessions.owner, 'PATCH', `/api/missions/${assignmentMission.id}/tasks/${assigned.id}`, { status: 'open' });
      assert.equal(response.status, 200);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM app_notifications WHERE app_user_id=$1 AND kind='mission_task_reopened'", [users.member])).rows[0].count, 1);
      response = await json(sessions.owner, 'PATCH', `/api/missions/${assignmentMission.id}/tasks/${assigned.id}`, { status: 'open' });
      assert.equal(response.status, 200);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM app_notifications WHERE app_user_id=$1 AND kind='mission_task_reopened'", [users.member])).rows[0].count, 1);

      const contributionMission = await createMission('Notification contribution');
      const contributionTask = (await createTask(contributionMission.id, {
        type: 'item', title: 'Bring ore', assigned_to: users.assignee, target_quantity: 5, unit: 'SCU'
      })).task;
      await pool.query('DELETE FROM app_notifications');
      response = await json(sessions.owner, 'POST', `/api/missions/${contributionMission.id}/tasks/${contributionTask.id}/contributions`, { quantity: 3 });
      assert.equal(response.status, 201);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM app_notifications WHERE app_user_id=$1 AND kind='mission_item_contribution'", [users.assignee])).rows[0].count, 1);
      response = await json(sessions.assignee, 'POST', `/api/missions/${contributionMission.id}/tasks/${contributionTask.id}/contributions`, { quantity: 1 });
      assert.equal(response.status, 201);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM app_notifications WHERE kind='mission_item_contribution'")).rows[0].count, 1);
      response = await json(sessions.owner, 'POST', `/api/missions/${contributionMission.id}/tasks/${contributionTask.id}/contributions`, { quantity: 2 });
      assert.equal(response.status, 409);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM app_notifications WHERE kind='mission_item_contribution'")).rows[0].count, 1);

      const completionMission = await createMission('Completion recipient set');
      const ownerTask = (await createTask(completionMission.id, {
        type: 'checklist', title: 'Owner role overlap', assigned_to: users.owner
      })).task;
      assert.equal((await json(sessions.owner, 'PATCH', `/api/missions/${completionMission.id}/tasks/${ownerTask.id}`, { status: 'completed' })).status, 200);
      const removedTask = (await createTask(completionMission.id, {
        type: 'checklist', title: 'Former member candidate', assigned_to: users.member
      })).task;
      assert.equal((await json(sessions.owner, 'PATCH', `/api/missions/${completionMission.id}/tasks/${removedTask.id}`, { status: 'completed' })).status, 200);
      const finalTask = (await createTask(completionMission.id, {
        type: 'checklist', title: 'Final completion', assigned_to: users.assignee
      })).task;
      const inactiveUser = randomUUID();
      await pool.query(
        "INSERT INTO app_users (id,email,display_name,account_status) VALUES ($1,$2,'Inactive Candidate','blocked')",
        [inactiveUser, `inactive-${inactiveUser}@example.test`]
      );
      await pool.query("INSERT INTO group_members (group_id,app_user_id,role) VALUES ($1,$2,'member')", [groups.a, inactiveUser]);
      await pool.query(
        "INSERT INTO mission_tasks (mission_id,type,title,assigned_to,status,completed_at) VALUES ($1,'checklist','Inactive completed task',$2,'completed',now())",
        [completionMission.id, inactiveUser]
      );
      await pool.query('DELETE FROM app_notifications');
      await pool.query('UPDATE app_users SET is_admin=true WHERE id=$1', [users.outsider]);
      assert.equal((await form(sessions.owner, '/api/groups/remove-member', { group_id: groups.a, member_id: users.member })).status, 200);
      response = await json(sessions.assignee, 'PATCH', `/api/missions/${completionMission.id}/tasks/${finalTask.id}`, { status: 'completed' });
      assert.equal(response.status, 200);
      assert.equal(response.body.mission.status, 'completed');
      notifications = await pool.query("SELECT app_user_id,kind FROM app_notifications WHERE kind='mission_completed'");
      assert.deepEqual(notifications.rows, [{ app_user_id: users.owner, kind: 'mission_completed' }]);
      assert.equal((await pool.query('SELECT 1 FROM app_notifications WHERE app_user_id=$1', [users.member])).rowCount, 0);
      assert.equal((await pool.query('SELECT 1 FROM app_notifications WHERE app_user_id=$1', [users.outsider])).rowCount, 0);
      assert.equal((await pool.query('SELECT 1 FROM app_notifications WHERE app_user_id=$1', [inactiveUser])).rowCount, 0);
      await pool.query('UPDATE app_users SET is_admin=false WHERE id=$1', [users.outsider]);

      response = await json(sessions.assignee, 'PATCH', `/api/missions/${completionMission.id}/tasks/${finalTask.id}`, { status: 'open' });
      assert.equal(response.status, 200);
      response = await json(sessions.assignee, 'PATCH', `/api/missions/${completionMission.id}/tasks/${finalTask.id}`, { status: 'completed' });
      assert.equal(response.status, 200);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM app_notifications WHERE app_user_id=$1 AND kind='mission_completed'", [users.owner])).rows[0].count, 2);
      response = await json(sessions.assignee, 'PATCH', `/api/missions/${completionMission.id}/tasks/${finalTask.id}`, { status: 'completed' });
      assert.equal(response.status, 200);
      assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM app_notifications WHERE app_user_id=$1 AND kind='mission_completed'", [users.owner])).rows[0].count, 2);

      await pool.query(
        "INSERT INTO group_members (group_id,app_user_id,role) VALUES ($1,$2,'member') ON CONFLICT (group_id,app_user_id) DO NOTHING",
        [groups.a, users.member]
      );
      await pool.query('DELETE FROM app_notifications');
    });

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

    await t.test('returns ordered contribution history in authorized mission detail', async () => {
      const mission = await createMission('Contribution history detail');
      const task = (await createTask(mission.id, {
        type: 'item', title: 'Shared delivery', assigned_to: users.assignee,
        target_quantity: 10, unit: 'SCU'
      })).task;

      let response = await json(sessions.owner, 'POST', `/api/missions/${mission.id}/tasks/${task.id}/contributions`, { quantity: 1.25 });
      assert.equal(response.status, 201);

      response = await request(`/api/missions/${mission.id}`, { session: sessions.member });
      assert.equal(response.status, 200);
      let detailTask = response.body.mission.tasks.find((candidate) => candidate.id === task.id);
      assert.deepEqual(detailTask.contributions.map((entry) => Number(entry.quantity)), [1.25]);
      assert.equal(detailTask.contributions[0].app_user_id, users.owner);
      assert.equal(detailTask.contributions[0].contributor_name, 'Mission Owner');

      response = await json(sessions.assignee, 'POST', `/api/missions/${mission.id}/tasks/${task.id}/contributions`, { quantity: 2.5 });
      assert.equal(response.status, 201);
      response = await request(`/api/missions/${mission.id}`, { session: sessions.member });
      assert.equal(response.status, 200);
      detailTask = response.body.mission.tasks.find((candidate) => candidate.id === task.id);
      assert.deepEqual(detailTask.contributions.map((entry) => Number(entry.quantity)), [1.25, 2.5]);
      assert.deepEqual(detailTask.contributions.map((entry) => entry.app_user_id), [users.owner, users.assignee]);
      assert.deepEqual(detailTask.contributions.map((entry) => entry.contributor_name), ['Mission Owner', 'Mission Assignee']);
      assert.ok(detailTask.contributions.every((entry) => entry.id && entry.task_id === task.id && entry.created_at));

      assert.equal((await request(`/api/missions/${mission.id}`, { session: sessions.outsider })).status, 404);
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

    await t.test('mission lifecycle survives former-owner hard delete through real HTTP and PostgreSQL', async () => {
      const creator = randomUUID(), successor = randomUUID(), admin = randomUUID(), groupId = randomUUID();
      await pool.query("INSERT INTO app_users (id,email,display_name,account_status,is_admin) VALUES ($1,$2,'Former owner','active',false),($3,$4,'Successor','active',false),($5,$6,'Lifecycle admin','active',true)", [creator, `creator-${creator}@example.test`, successor, `successor-${successor}@example.test`, admin, `admin-${admin}@example.test`]);
      await pool.query("INSERT INTO blueprint_groups (id,name,created_by) VALUES ($1,'Transferred lifecycle group',$2)", [groupId, creator]);
      await pool.query("INSERT INTO group_members (group_id,app_user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')", [groupId, creator, successor]);
      const creatorSession = await createSession(pool, pepper, creator), adminSession = await createSession(pool, pepper, admin);
      const missionResponse = await json(creatorSession, 'POST', '/api/missions', { group_id: groupId, title: 'Former owner survives' });
      assert.equal(missionResponse.status, 201);
      assert.equal((await form(creatorSession, '/api/groups/transfer-owner', { group_id: groupId, member_id: successor })).status, 200);
      assert.equal((await form(adminSession, '/api/admin/users/delete', { user_id: creator })).status, 200);
      assert.equal((await pool.query('SELECT 1 FROM app_users WHERE id=$1', [creator])).rowCount, 0);
      assert.equal((await pool.query('SELECT created_by FROM blueprint_groups WHERE id=$1', [groupId])).rows[0].created_by, null);
      assert.equal((await pool.query("SELECT role FROM group_members WHERE group_id=$1 AND app_user_id=$2", [groupId, successor])).rows[0].role, 'owner');
      assert.equal((await pool.query('SELECT created_by FROM missions WHERE id=$1', [missionResponse.body.mission.id])).rows[0].created_by, null);
    });

    await t.test('mission lifecycle rejects self status changes without cleanup side effects', async () => {
      await pool.query('UPDATE app_users SET is_admin=true WHERE id=$1', [users.owner]);
      const task = (await createTask(coreMission.id, { type: 'checklist', title: 'Self guard', assigned_to: users.owner })).task;
      assert.equal((await form(sessions.owner, '/api/admin/users/status', { user_id: users.owner, status: 'blocked' })).status, 400);
      assert.equal((await pool.query('SELECT account_status FROM app_users WHERE id=$1', [users.owner])).rows[0].account_status, 'active');
      assert.equal((await pool.query('SELECT assigned_to FROM mission_tasks WHERE id=$1', [task.id])).rows[0].assigned_to, users.owner);
    });

    await t.test('mission lifecycle clears active assignments for blocked and deleted accounts', async () => {
      for (const status of ['blocked', 'deleted']) {
        const userId = randomUUID(), groupId = randomUUID(), adminId = randomUUID();
        await pool.query("INSERT INTO app_users (id,email,display_name,account_status,is_admin) VALUES ($1,$2,'Lifecycle user','active',false),($3,$4,'Lifecycle admin','active',true)", [userId, `${userId}@example.test`, adminId, `${adminId}@example.test`]);
        await pool.query("INSERT INTO blueprint_groups (id,name,created_by) VALUES ($1,'Lifecycle status group',$2)", [groupId, users.owner]);
        await pool.query("INSERT INTO group_members (group_id,app_user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')", [groupId, users.owner, userId]);
        const userSession = await createSession(pool, pepper, userId), adminSession = await createSession(pool, pepper, adminId);
        const mission = (await json(sessions.owner, 'POST', '/api/missions', { group_id: groupId, title: `Status ${status}` })).body.mission;
        const open = (await createTask(mission.id, { type: 'checklist', title: 'Open', assigned_to: userId })).task;
        const completed = (await createTask(mission.id, { type: 'checklist', title: 'Done', assigned_to: userId })).task;
        await pool.query("UPDATE mission_tasks SET status='completed',completed_at=now() WHERE id=$1", [completed.id]);
        assert.equal((await form(adminSession, '/api/admin/users/status', { user_id: userId, status })).status, 200);
        const rows = await pool.query('SELECT id,assigned_to FROM mission_tasks WHERE id=ANY($1::uuid[])', [[open.id, completed.id]]);
        const byId = new Map(rows.rows.map(row => [row.id, row.assigned_to])); assert.equal(byId.get(open.id), null); assert.equal(byId.get(completed.id), userId);
        assert.equal((await request(`/api/missions/${mission.id}`, { session: userSession })).status, 401);
        assert.equal((await pool.query("SELECT 1 FROM app_notifications WHERE kind='mission_task_unassigned' AND app_user_id=$1", [userId])).rowCount, 0);
        if (status === 'blocked') { assert.equal((await form(adminSession, '/api/admin/users/status', { user_id: userId, status: 'active' })).status, 200); assert.equal((await pool.query('SELECT assigned_to FROM mission_tasks WHERE id=$1', [open.id])).rows[0].assigned_to, null); }
      }
    });

    await t.test('mission lifecycle cascades current-owner hard and explicit group deletion', async () => {
      for (const mode of ['hard-delete', 'group-delete']) {
        const ownerId = randomUUID(), adminId = randomUUID(), groupId = randomUUID();
        await pool.query("INSERT INTO app_users (id,email,display_name,account_status,is_admin) VALUES ($1,$2,'Cascade owner','active',false),($3,$4,'Cascade admin','active',true)", [ownerId, `${ownerId}@example.test`, adminId, `${adminId}@example.test`]);
        await pool.query("INSERT INTO blueprint_groups (id,name,created_by) VALUES ($1,'Cascade group',$2)", [groupId, ownerId]); await pool.query("INSERT INTO group_members (group_id,app_user_id,role) VALUES ($1,$2,'owner')", [groupId, ownerId]);
        const ownerSession = await createSession(pool, pepper, ownerId), adminSession = await createSession(pool, pepper, adminId);
        const mission = (await json(ownerSession, 'POST', '/api/missions', { group_id: groupId, title: `Cascade ${mode}` })).body.mission;
        const task = (await json(ownerSession, 'POST', `/api/missions/${mission.id}/tasks`, { type: 'item', title: 'Contribution', target_quantity: 2, unit: 'SCU' })).body.task;
        await pool.query("INSERT INTO mission_task_contributions (task_id,app_user_id,quantity) VALUES ($1,$2,1)", [task.id, ownerId]);
        await pool.query("INSERT INTO app_notifications (app_user_id,kind,title,message,mission_id,mission_task_id) VALUES ($1,'mission_task_completed','Mission','Cascade',$2,$3),($1,'system','Other','Keep',NULL,NULL)", [adminId, mission.id, task.id]);
        const response = mode === 'hard-delete' ? await form(adminSession, '/api/admin/users/delete', { user_id: ownerId }) : await form(ownerSession, '/api/groups/delete', { group_id: groupId }); assert.equal(response.status, 200);
        assert.equal((await pool.query('SELECT 1 FROM blueprint_groups WHERE id=$1', [groupId])).rowCount, 0); assert.equal((await pool.query('SELECT 1 FROM missions WHERE id=$1', [mission.id])).rowCount, 0);
        assert.equal((await pool.query('SELECT 1 FROM app_notifications WHERE mission_id=$1', [mission.id])).rowCount, 0); assert.equal((await pool.query("SELECT 1 FROM app_notifications WHERE app_user_id=$1 AND kind='system'", [adminId])).rowCount, 1);
      }
    });
  } finally {
    if (pool) {
      await resetMissionTestDatabase(pool).catch(() => {});
      await pool.end();
    }
    await stopMissionTestServer(runtime);
  }
});
