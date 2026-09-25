import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createTestPool,
  startMissionTestServer,
  stopMissionTestServer
} from './helpers/mission-integration.js';

const serverSource = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const databaseUrl = process.env.TEST_DATABASE_URL;
const pepper = 'telemetry-persistence-test-pepper';

const tableDefinition = (tableName) => {
  const match = serverSource.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${tableName} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(match, `${tableName} startup DDL exists`);
  return match[0];
};

test('C2 startup DDL defines the bounded telemetry persistence contract', () => {
  const devices = tableDefinition('telemetry_devices');
  assert.match(devices, /id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
  assert.match(devices, /app_user_id uuid NOT NULL REFERENCES app_users\(id\) ON DELETE CASCADE/i);
  assert.match(devices, /name text NOT NULL DEFAULT 'Telemetry device' CHECK \(char_length\(name\) <= 64\)/i);
  assert.match(devices, /credential_hash text NOT NULL UNIQUE CHECK \(credential_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(devices, /created_at timestamptz NOT NULL DEFAULT now\(\)/i);
  assert.match(devices, /last_seen_at timestamptz/i);
  assert.match(devices, /revoked_at timestamptz/i);
  assert.match(devices, /last_presence_revision bigint NOT NULL DEFAULT 0 CHECK \(last_presence_revision BETWEEN 0 AND 9007199254740991\)/i);
  assert.match(serverSource, /CREATE INDEX IF NOT EXISTS telemetry_devices_app_user_id_idx ON telemetry_devices\(app_user_id\)/i);
  assert.doesNotMatch(devices, /^\s*(?:credential|token|secret|raw_code|code)\s+text\b/im);

  const pairing = tableDefinition('telemetry_pairing_codes');
  assert.match(pairing, /id uuid PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
  assert.match(pairing, /app_user_id uuid NOT NULL REFERENCES app_users\(id\) ON DELETE CASCADE/i);
  assert.match(pairing, /code_hash text NOT NULL UNIQUE CHECK \(code_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(pairing, /created_at timestamptz NOT NULL DEFAULT now\(\)/i);
  assert.match(pairing, /expires_at timestamptz NOT NULL/i);
  assert.match(pairing, /consumed_at timestamptz/i);
  assert.match(pairing, /invalidated_at timestamptz/i);
  assert.match(pairing, /CHECK \(expires_at > created_at\)/i);
  assert.match(pairing, /CHECK \(NOT \(consumed_at IS NOT NULL AND invalidated_at IS NOT NULL\)\)/i);
  assert.match(serverSource, /CREATE UNIQUE INDEX IF NOT EXISTS telemetry_pairing_codes_active_account_idx\s+ON telemetry_pairing_codes\(app_user_id\)\s+WHERE consumed_at IS NULL AND invalidated_at IS NULL/i);
  assert.match(serverSource, /CREATE INDEX IF NOT EXISTS telemetry_pairing_codes_expires_at_idx ON telemetry_pairing_codes\(expires_at\)/i);
  assert.doesNotMatch(pairing, /^\s*(?:credential|token|secret|raw_code|code)\s+text\b/im);
});

test('C2 PostgreSQL schema is repeat-safe and enforces persistence constraints', { skip: !databaseUrl }, async () => {
  let runtime;
  let pool;
  let adminPool;
  let schemaName;
  const userIds = [randomUUID(), randomUUID(), randomUUID()];
  const hash = () => randomBytes(32).toString('hex');

  try {
    adminPool = await createTestPool(databaseUrl);
    schemaName = `c2_test_${randomUUID().replaceAll('-', '')}`;
    await adminPool.query(`CREATE SCHEMA "${schemaName}"`);
    const isolatedDatabaseUrl = new URL(databaseUrl);
    isolatedDatabaseUrl.searchParams.set('options', `-c search_path=${schemaName},public`);
    const isolatedUrl = isolatedDatabaseUrl.toString();

    const firstStart = await startMissionTestServer({ databaseUrl: isolatedUrl, pepper });
    await stopMissionTestServer(firstStart);
    runtime = await startMissionTestServer({ databaseUrl: isolatedUrl, pepper });
    pool = await createTestPool(isolatedUrl);

    if (process.env.CI) {
      const tables = await pool.query(
        `SELECT to_regclass($1) AS devices,
                to_regclass($2) AS pairing`,
        [`${schemaName}.telemetry_devices`, `${schemaName}.telemetry_pairing_codes`]
      );
      assert.ok(tables.rows[0].devices);
      assert.ok(tables.rows[0].pairing);
    }

    await pool.query(
      `INSERT INTO app_users (id,email,display_name) VALUES
       ($1,$2,'Telemetry C2 test owner'),
       ($3,$4,'Telemetry C2 test secondary'),
       ($5,$6,'Telemetry C2 cascade owner')`,
      [userIds[0], `c2-${userIds[0]}@example.test`, userIds[1], `c2-${userIds[1]}@example.test`, userIds[2], `c2-${userIds[2]}@example.test`]
    );

    const device = await pool.query(
      'INSERT INTO telemetry_devices (app_user_id,credential_hash) VALUES ($1,$2) RETURNING id,name,last_presence_revision,created_at',
      [userIds[0], hash()]
    );
    assert.match(device.rows[0].id, /^[0-9a-f-]{36}$/i);
    assert.equal(device.rows[0].name, 'Telemetry device');
    assert.equal(device.rows[0].last_presence_revision, '0');
    assert.ok(device.rows[0].created_at instanceof Date);

    const ownerIndex = await pool.query(
      'SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname=$2',
      [schemaName, 'telemetry_devices_app_user_id_idx']
    );
    const activeIndex = await pool.query(
      'SELECT indexdef FROM pg_indexes WHERE schemaname=$1 AND indexname=$2',
      [schemaName, 'telemetry_pairing_codes_active_account_idx']
    );
    const expiryIndex = await pool.query(
      'SELECT 1 FROM pg_indexes WHERE schemaname=$1 AND indexname=$2',
      [schemaName, 'telemetry_pairing_codes_expires_at_idx']
    );
    assert.equal(ownerIndex.rowCount, 1);
    assert.match(activeIndex.rows[0].indexdef, /consumed_at IS NULL/i);
    assert.match(activeIndex.rows[0].indexdef, /invalidated_at IS NULL/i);
    assert.doesNotMatch(activeIndex.rows[0].indexdef, /expires_at/i);
    assert.equal(expiryIndex.rowCount, 1);

    await assert.rejects(
      pool.query('INSERT INTO telemetry_devices (app_user_id,credential_hash) VALUES ($1,$2)', [randomUUID(), 'b'.repeat(64)]),
      (error) => error.code === '23503'
    );
    await assert.rejects(
      pool.query('INSERT INTO telemetry_devices (app_user_id,credential_hash) VALUES ($1,$2)', [userIds[0], 'not-a-hash']),
      (error) => error.code === '23514'
    );
    await assert.rejects(
      pool.query('INSERT INTO telemetry_devices (app_user_id,credential_hash) VALUES ($1,$2)', [userIds[0], 'A'.repeat(64)]),
      (error) => error.code === '23514'
    );
    const duplicateCredentialHash = hash();
    await pool.query(
      'INSERT INTO telemetry_devices (app_user_id,credential_hash) VALUES ($1,$2)',
      [userIds[0], duplicateCredentialHash]
    );
    await assert.rejects(
      pool.query('INSERT INTO telemetry_devices (app_user_id,credential_hash) VALUES ($1,$2)', [userIds[0], duplicateCredentialHash]),
      (error) => error.code === '23505'
    );
    await assert.rejects(
      pool.query('INSERT INTO telemetry_devices (app_user_id,name,credential_hash) VALUES ($1,$2,$3)', [userIds[0], 'x'.repeat(65), hash()]),
      (error) => error.code === '23514'
    );

    const validRevisions = ['0', '1', '9007199254740991'];
    for (const revision of validRevisions) {
      const inserted = await pool.query(
        'INSERT INTO telemetry_devices (app_user_id,credential_hash,last_presence_revision) VALUES ($1,$2,$3) RETURNING last_presence_revision',
        [userIds[0], hash(), revision]
      );
      assert.equal(inserted.rows[0].last_presence_revision, revision);
    }
    for (const revision of ['-1', '9007199254740992']) {
      await assert.rejects(
        pool.query(
          'INSERT INTO telemetry_devices (app_user_id,credential_hash,last_presence_revision) VALUES ($1,$2,$3)',
          [userIds[0], hash(), revision]
        ),
        (error) => error.code === '23514'
      );
    }

    const expiredCode = await pool.query(
      `INSERT INTO telemetry_pairing_codes (app_user_id,code_hash,created_at,expires_at)
       VALUES ($1,$2,now()-interval '2 hours',now()-interval '1 hour') RETURNING id`,
      [userIds[0], hash()]
    );
    const blockedExpiredHash = hash();
    await assert.rejects(
      pool.query(
        "INSERT INTO telemetry_pairing_codes (app_user_id,code_hash,expires_at) VALUES ($1,$2,now()+interval '10 minutes')",
        [userIds[0], blockedExpiredHash]
      ),
      (error) => error.code === '23505'
    );
    await pool.query('UPDATE telemetry_pairing_codes SET invalidated_at=now() WHERE id=$1', [expiredCode.rows[0].id]);
    await pool.query(
      "INSERT INTO telemetry_pairing_codes (app_user_id,code_hash,expires_at) VALUES ($1,$2,now()+interval '10 minutes')",
      [userIds[0], hash()]
    );

    const globallyUniqueCodeHash = hash();
    await pool.query(
      "INSERT INTO telemetry_pairing_codes (app_user_id,code_hash,expires_at) VALUES ($1,$2,now()+interval '10 minutes')",
      [userIds[1], globallyUniqueCodeHash]
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO telemetry_pairing_codes (app_user_id,code_hash,expires_at) VALUES ($1,$2,now()+interval '10 minutes')",
        [userIds[2], globallyUniqueCodeHash]
      ),
      (error) => error.code === '23505'
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO telemetry_pairing_codes (app_user_id,code_hash,expires_at) VALUES ($1,$2,now()+interval '10 minutes')",
        [userIds[2], 'not-a-hash']
      ),
      (error) => error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO telemetry_pairing_codes (app_user_id,code_hash,expires_at) VALUES ($1,$2,now()+interval '10 minutes')",
        [userIds[2], 'B'.repeat(64)]
      ),
      (error) => error.code === '23514'
    );
    await assert.rejects(
      pool.query(
        "INSERT INTO telemetry_pairing_codes (app_user_id,code_hash,expires_at) VALUES ($1,$2,now()+interval '10 minutes')",
        [randomUUID(), '1'.repeat(64)]
      ),
      (error) => error.code === '23503'
    );

    const cascadeDevice = await pool.query(
      'INSERT INTO telemetry_devices (app_user_id,credential_hash) VALUES ($1,$2) RETURNING id',
      [userIds[2], hash()]
    );
    const cascadePairing = await pool.query(
      "INSERT INTO telemetry_pairing_codes (app_user_id,code_hash,expires_at) VALUES ($1,$2,now()+interval '10 minutes') RETURNING id",
      [userIds[2], hash()]
    );
    await pool.query('DELETE FROM app_users WHERE id=$1', [userIds[2]]);
    const cascaded = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM telemetry_devices WHERE id=$1) AS devices,
         (SELECT count(*)::int FROM telemetry_pairing_codes WHERE id=$2) AS pairing`,
      [cascadeDevice.rows[0].id, cascadePairing.rows[0].id]
    );
    assert.deepEqual(cascaded.rows[0], { devices: 0, pairing: 0 });
  } finally {
    try {
      if (pool) {
        try {
          await pool.query('DELETE FROM app_users WHERE id=ANY($1::uuid[])', [userIds]);
        } finally {
          await pool.end();
        }
      }
    } finally {
      try {
        await stopMissionTestServer(runtime);
      } finally {
        if (adminPool) {
          try {
            if (schemaName) await adminPool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
          } finally {
            await adminPool.end();
          }
        }
      }
    }
  }
});

test('CI provides the PostgreSQL C2 test database', () => {
  if (process.env.CI) assert.ok(databaseUrl, 'TEST_DATABASE_URL must be set in CI');
});
