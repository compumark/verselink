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

test('mission navigation restores useful focus without disrupting refreshes', () => {
  assert.match(source, /data-mission-detail-focus/);
  assert.match(source, /target\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /target\?\.scrollIntoView/);
  assert.match(source, /focusTarget = options\.focusTarget !== false/);
  assert.match(source, /focusTarget: true/);
  assert.match(source, /dialogReturnFocus = trigger\.hasAttribute\('data-mission-create'\)/);
  assert.match(source, /dialogActiveField = select\.name/);
});

test('dialog return focus waits for its target and preserves create navigation focus', () => {
  assert.match(source, /const restoreDialogFocus = selector =>/);
  assert.match(source, /const target = selector && mountedRoot\?\.querySelector\(selector\)/);
  assert.match(source, /if \(!target\) return false/);
  assert.match(source, /dialogReturnFocus = '';/);
  assert.match(source, /restoreDialogFocus\(restoreFocus\)/);
  assert.match(source, /if \(focusTarget\) dialogReturnFocus = ''/);
});

test('mission readiness CSS and state panels preserve accessible small-screen behavior', () => {
  assert.doesNotMatch(source, /aria-live="polite"/);
  assert.match(source, /button:hover:not\(:disabled\)/);
  assert.match(source, /button:hover:disabled/);
  assert.match(source, /@media\(max-width:960px\)/);
  assert.match(source, /title === 'MISSION NOT FOUND'/);
  assert.match(source, /role="status"/);
  assert.match(source, /role="alert"/);
});

test('task action controls use compact desktop sizing and flexible mobile controls', () => {
  assert.match(source, /\.mission-task-actions input,\.mission-task-actions select,\.mission-task-actions button\{min-height:33px;padding:6px 9px\}/);
  assert.match(source, /\.mission-task-actions select\{width:clamp\(150px,16vw,180px\)\}/);
  assert.match(source, /\[data-task-contribution\] input\{width:90px\}/);
  assert.match(source, /\.mission-task-actions form\{display:flex;align-items:flex-end;flex-wrap:wrap;gap:8px;min-width:0\}/);
  assert.match(source, /@media\(max-width:680px\)\{\.mission-task-actions,.mission-task-actions form\{display:grid;grid-template-columns:1fr\}/);
});
