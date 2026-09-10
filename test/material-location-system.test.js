import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('material matrix recognizes systems stored in UEX display labels', async () => {
  const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  const helper = server.slice(
    server.indexOf('const materialSystemName'),
    server.indexOf('const materialInventoryNetRows'),
  );
  const materialSystemForLocation = new Function('normalizeMaterialLocation', `${helper}; return materialSystemForLocation;`)(
    value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' '),
  );

  assert.equal(materialSystemForLocation('ARC-L2 Lively Pathway Station | ArcCorp | Stanton', new Map()), 'Stanton');
  assert.equal(materialSystemForLocation('Ruin Station | Terminus | Pyro', new Map()), 'Pyro');
  assert.equal(materialSystemForLocation('Levski | Nyx', new Map()), 'Nyx');
  assert.equal(materialSystemForLocation('Stanton / Hurston / HUR-L1', new Map()), 'Stanton');
  assert.equal(materialSystemForLocation('Custom location', new Map([['custom location', 'Pyro']])), 'Pyro');
});
