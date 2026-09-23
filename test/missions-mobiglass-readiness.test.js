import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/js/missions-mobiglass.js', import.meta.url), 'utf8');

test('missions memoize /api/me across remounts without changing authentication behavior', () => {
  assert.match(source, /let meRequest = null/);
  assert.match(source, /if \(state\.me\) return state\.me/);
  assert.match(source, /if \(meRequest\) return meRequest/);
  assert.match(source, /fetch\('\/api\/me'\)/);
  assert.match(source, /finally \{ meRequest = null; \}/);
  assert.match(source, /response\.status === 401/);
});

test('mission dialogs retain native keyboard-modal focus safety', () => {
  assert.match(source, /role="dialog" aria-modal="true" aria-labelledby="missions-dialog-title"/);
  assert.match(source, /event\.key !== 'Tab'/);
  assert.match(source, /button:not\(\[disabled\]\),input:not\(\[disabled\]\),select:not\(\[disabled\]\),textarea:not\(\[disabled\]\)/);
  assert.match(source, /event\.shiftKey/);
  assert.match(source, /focusable\.at\(-1\)/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /state\.mutationPending/);
});
