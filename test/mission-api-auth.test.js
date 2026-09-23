import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const missionRoutes = source.slice(source.indexOf('url.pathname === "/api/missions"'), source.indexOf('const miningAccess'));

test('mission routes require an active VerseLink session', () => {
  assert.match(missionRoutes, /getCurrentAppUser\(req\)/);
  assert.match(missionRoutes, /return json\(res, 401, \{ error: "login required" \}\)/);
});

test('mission creation uses the session identity and current group membership', () => {
  const create = missionRoutes.slice(missionRoutes.indexOf('if (req.method === "POST")'), missionRoutes.indexOf('const missionMatch'));
  assert.match(create, /group_members WHERE group_id=\$1 AND app_user_id=\$2/);
  assert.match(create, /\[groupId, current\.id\]/);
  assert.match(create, /INSERT INTO missions \(group_id,created_by,title,description\)[\s\S]*?\[groupId, current\.id, title, description\]/);
  assert.doesNotMatch(create, /data\.created_by/);
  assert.match(create, /uuidPattern\.test\(groupId\)/);
  assert.match(create, /validText\(title\)/);
});

test('mission list requires a valid group and deterministic member-scoped ordering', () => {
  const list = missionRoutes.slice(missionRoutes.indexOf('if (req.method === "GET")'), missionRoutes.indexOf('if (req.method === "POST")'));
  assert.match(list, /group_id required/);
  assert.match(list, /uuidPattern\.test\(groupId\)/);
  assert.match(list, /group member required/);
  assert.match(list, /WHERE m\.group_id=\$1 ORDER BY m\.created_at DESC,m\.id DESC/);
});

test('mission details do not leak across groups', () => {
  assert.match(missionRoutes, /LEFT JOIN group_members gm ON gm\.group_id=m\.group_id AND gm\.app_user_id=\$2/);
  assert.match(missionRoutes, /if \(!row\.role\) return json\(res, 404, \{ error: "mission not found" \}\)/);
});

test('mission patch permits only creators, group owners, and app admins to update metadata', () => {
  assert.match(missionRoutes, /!current\.is_admin && row\.created_by !== current\.id && row\.role !== "owner"/);
  assert.match(missionRoutes, /new Set\(\["title", "description"\]\)/);
  assert.match(missionRoutes, /only title and description can be changed/);
  assert.match(missionRoutes, /updated_at=now\(\)/);
});
