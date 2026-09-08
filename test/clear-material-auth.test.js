import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('clear material inventory uses VerseLink app-user ownership', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const route = server.slice(
    server.indexOf('url.pathname === "/api/groups/clear-material-inventory"'),
    server.length,
  );
  assert.match(route, /getSessionContext\(req\)/);
  assert.match(route, /app_user_id=\$2/);
  assert.doesNotMatch(route, /getSessionTokenHash\(req\)|scmdb_connections/);
});
