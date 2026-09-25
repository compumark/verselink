import { createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const reservePort = () => new Promise((resolve, reject) => {
  const socket = createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const { port } = socket.address();
    socket.close((error) => error ? reject(error) : resolve(port));
  });
});

export const createTestPool = async (databaseUrl) => {
  const { default: pg } = await import('pg');
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
};

export const resetMissionTestDatabase = async (pool) => {
  await pool.query('TRUNCATE TABLE app_users, blueprint_groups CASCADE');
};

export const createSession = async (pool, pepper, appUserId) => {
  const session = randomBytes(32).toString('hex');
  const sessionHash = createHmac('sha256', pepper).update(`session:${session}`).digest('hex');
  await pool.query(
    "INSERT INTO dashboard_sessions (session_hash,app_user_id,expires_at) VALUES ($1,$2,now()+interval '1 day')",
    [sessionHash, appUserId]
  );
  return session;
};

export const startMissionTestServer = async ({ databaseUrl, pepper, extraEnv = {} }) => {
  const lockPool = await createTestPool(databaseUrl);
  let lockClient;
  let lockAcquired = false;
  let child;
  const stopChild = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  };

  try {
    lockClient = await lockPool.connect();
    await lockClient.query(
      'SELECT pg_advisory_lock(hashtext($1))',
      ['verselink-test-server-schema-startup']
    );
    lockAcquired = true;

    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const output = [];
    const logDirectory = join(tmpdir(), `verselink-mission-test-${process.pid}`);
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: new URL('../..', import.meta.url),
      env: {
        ...process.env,
        APP_ENVIRONMENT: 'Mission integration test',
        APP_PORT: String(port),
        DATABASE_URL: databaseUrl,
        LOG_DIR: logDirectory,
        LOG_LEVEL: 'ERROR',
        NODE_ENV: 'test',
        SINK_TOKEN_PEPPER: pepper,
        SCMDB_SINK_BASE_URL: '',
        DISCORD_BOT_TOKEN: '',
        DISCORD_ADMIN_USER_ID: '',
        DISCORD_ORDERS_WEBHOOKS: '{}',
        DISCORD_WEBHOOK_URL: '',
        UEX_API_TOKEN: '',
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const remember = (chunk) => {
      output.push(chunk.toString());
      if (output.length > 100) output.shift();
    };
    child.stdout.on('data', remember);
    child.stderr.on('data', remember);

    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`test server exited early (${child.exitCode})\n${output.join('')}`);
      try {
        const response = await fetch(`${baseUrl}/healthz`);
        if (response.ok) return { baseUrl, child, output, logDirectory };
      } catch {}
      await delay(100);
    }
    throw new Error(`test server did not become ready\n${output.join('')}`);
  } catch (error) {
    await stopChild();
    throw error;
  } finally {
    try {
      if (lockAcquired) {
        try {
          await lockClient.query(
            'SELECT pg_advisory_unlock(hashtext($1))',
            ['verselink-test-server-schema-startup']
          );
        } catch (error) {
          await stopChild();
          throw error;
        }
      }
    } finally {
      lockClient?.release();
      await lockPool.end();
    }
  }
};

export const stopMissionTestServer = async (runtime) => {
  if (!runtime?.child || runtime.child.exitCode !== null) return;
  runtime.child.kill('SIGTERM');
  const exited = once(runtime.child, 'exit');
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(resolve, 5_000);
  });
  await Promise.race([exited, timeout]);
  clearTimeout(timeoutId);
  if (runtime.child.exitCode === null) {
    runtime.child.kill('SIGKILL');
    await exited;
  }
};

export const apiRequest = async (baseUrl, path, { method = 'GET', session, json, form } = {}) => {
  const headers = {};
  if (session) headers.cookie = `bp_session=${session}`;
  let body;
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body });
  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch { payload = text; }
  }
  return { status: response.status, body: payload, headers: response.headers };
};
