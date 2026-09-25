import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { stopMissionTestServer } from './mission-integration.js';

test('test server shutdown captures an immediate signal exit and is idempotent', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  let exited = false;
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (exited) return false;
    exited = true;
    child.signalCode = signal;
    child.emit('exit', null, signal);
    return true;
  };

  const runtime = { child };
  await stopMissionTestServer(runtime);
  await stopMissionTestServer(runtime);

  assert.deepEqual(signals, ['SIGTERM']);
});
