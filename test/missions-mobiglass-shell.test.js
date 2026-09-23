import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const [serverSource, shellSource, missionsSource, iconSource] = await Promise.all([
  readFile(new URL('../src/server.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/mobiglass.html', import.meta.url), 'utf8'),
  readFile(new URL('../public/js/missions-mobiglass.js', import.meta.url), 'utf8'),
  readFile(new URL('../public/assets/icons/missions.svg', import.meta.url), 'utf8')
]);

test('Missions launcher is authored in the shell and survives server transformation exactly once', () => {
  const count = (source, needle) => source.split(needle).length - 1;
  const tradeMaxApp = 'data-app="trademax"';
  const missionsApp = 'data-app="missions"';
  const tradeMaxNav = `<button data-view="trademax" title="TradeMax"><i class="nav-icon" style="--icon:url('/assets/icons/connection.svg')"></i></button>`;
  const missionsNav = `<button data-view="missions" title="Missions" aria-label="Missions"><i class="nav-icon" style="--icon:url('/assets/icons/missions.svg')"></i></button>`;
  const serverMissionsNav = String.raw`<button data-view="missions" title="Missions" aria-label="Missions"><i class="nav-icon" style="--icon:url(\'/assets/icons/missions.svg\')"></i></button>`;
  assert.equal(count(shellSource, missionsApp), 1);
  assert.ok(shellSource.indexOf(tradeMaxApp) < shellSource.indexOf(missionsApp));
  assert.ok(shellSource.includes('Plan and coordinate group objectives'));
  assert.equal(count(serverSource, missionsApp), 0);
  assert.equal(count(shellSource, 'data-view="missions"'), 0);
  assert.ok(serverSource.includes(serverMissionsNav));
  const renderedShell = shellSource.replace(tradeMaxNav, missionsNav + tradeMaxNav);
  assert.equal(count(renderedShell, missionsApp), 1);
  assert.equal(count(renderedShell, 'data-view="missions"'), 1);
  assert.ok(serverSource.includes("'groups','missions','trademax','material'"));
  assert.ok(shellSource.includes("if(v!=='home'&&!user)v='home'"));
  assert.ok(shellSource.includes("window.addEventListener('hashchange',()=>setView(location.hash.slice(1)||'home'))"));
  assert.ok(shellSource.includes("if(!views.has(v))v='home'"));
  assert.ok(shellSource.includes("activateApps(){document.querySelectorAll('.app[data-app]')"));
});

test('Missions is dynamically imported and explicitly served as a static module', () => {
  assert.ok(serverSource.includes("import('/js/missions-mobiglass.js').then(module=>module.mount(content))"));
  assert.ok(serverSource.includes('"/js/missions-mobiglass.js"'));
  assert.ok(missionsSource.includes('export async function mount'));
});

test('Missions shell uses only group context and has loading, ready, empty, and error states', () => {
  assert.ok(missionsSource.includes("fetch('/api/groups')"));
  assert.ok(!missionsSource.includes('/api/missions'));
  for (const label of [
    'INITIALIZING MISSION SYSTEM...',
    'MISSION SYSTEM READY',
    'NO GROUPS AVAILABLE',
    'MISSION SYSTEM UNAVAILABLE',
    'OPEN GROUP MANAGEMENT',
    'RETRY'
  ]) assert.ok(missionsSource.includes(label), `missing state: ${label}`);
  assert.ok(missionsSource.includes("response.status === 401"));
  assert.ok(missionsSource.includes("location.hash = 'home'"));
  assert.ok(missionsSource.includes("location.hash === '#missions'"));
  assert.ok(missionsSource.includes("location.hash = 'groups'"));
});

test('Missions shell is theme-safe, responsive, and safe across repeated mounts', () => {
  for (const variable of ['--bg', '--panel', '--panel2', '--accent', '--bright', '--muted', '--border', '--text', '--glow']) assert.ok(missionsSource.includes(`var(${variable})`));
  assert.doesNotMatch(missionsSource, /#[0-9a-f]{3,8}\b/i);
  assert.ok(missionsSource.includes('@media(max-width:680px)'));
  assert.ok(missionsSource.includes("document.getElementById(styleId)"));
  assert.ok(missionsSource.includes('root.innerHTML = shell(state)'));
});

test('Missions has its own currentColor waypoint icon and no classic page', async () => {
  assert.match(iconSource, /viewBox="0 0 64 64"/);
  assert.match(iconSource, /stroke="currentColor"/);
  assert.match(iconSource, /stroke-width="2\.4"/);
  assert.doesNotMatch(iconSource, /#[0-9a-f]/i);
  await assert.rejects(stat(new URL('../public/missions.html', import.meta.url)), { code: 'ENOENT' });
  await assert.rejects(stat(new URL('../public/mission.html', import.meta.url)), { code: 'ENOENT' });
});
