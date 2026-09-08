import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { filterOrders, normalizeStatus, orderSharePath, progressFor, scmdbUrl } from '../public/js/orders-core.js';

test('normalizes legacy in_progress status for the shared Orders UI',()=>assert.equal(normalizeStatus({status:'in_progress'}),'reported'));
test('calculates delivered and remaining quantities safely',()=>assert.deepEqual(progressFor({required_quantity:10,delivered_quantity:4}),{required:10,delivered:4,remaining:6,percentage:40}));
test('filters by status and material query',()=>assert.deepEqual(filterOrders([{id:1,status:'open',material_name:'Iron'},{id:2,status:'completed',material_name:'Gold'}],{status:'open',query:'iron'}).map(o=>o.id),[1]));
test('builds an encoded SCMDB link',()=>assert.match(scmdbUrl('Quantainium alloy'),/Quantainium%20alloy/));
test('builds a Mobiglass deep link from the immutable order and group IDs',()=>assert.equal(orderSharePath({group_id:'group 1',id:'order/1'}),'/mobiglass?group_id=group%201&order_id=order%2F1#orders'));

test('uses shared Mobiglass theme variables for Orders HUD accents',async()=>{
  const source=await readFile(new URL('../public/js/orders-mobiglass.js',import.meta.url),'utf8');
  for(const variable of ['var(--accent)','var(--bright)','var(--glow)','var(--muted)','var(--border)','var(--panel)','var(--panel2)','var(--text)'])assert.match(source,new RegExp(variable.replace(/[()]/g,'\\$&')));
  for(const legacy of ['#16718c','#00c8ff','#287f98','#08718f','#16c6ff','#81f5cf','#21bce9','#00bfff'])assert.doesNotMatch(source,new RegExp(legacy));
});
test('Classic and Mobiglass Orders share the unfiltered logo asset',async()=>{
  const [classic,mobiglass,server]=await Promise.all([readFile(new URL('../public/orders.html',import.meta.url),'utf8'),readFile(new URL('../public/js/orders-mobiglass.js',import.meta.url),'utf8'),readFile(new URL('../src/server.js',import.meta.url),'utf8')]);
  for(const source of [classic,mobiglass])assert.match(source,/src="\/assets\/apps\/orders\.png"/);
  assert.match(classic,/href="\/assets\/apps\/orders\.png"/);
  assert.match(classic,/\.orders-logo\{[^}]*object-fit:contain/);
  assert.match(mobiglass,/\.mg-orders-logo\{[^}]*object-fit:contain/);
  assert.doesNotMatch(mobiglass,/\.mg-orders-logo\{[^}]*\b(?:filter|opacity|mix-blend-mode)\s*:/);
  assert.match(server,/"\/assets\/apps\/orders\.png"/);
});
test('Orders expose public profile paths only for members who opted in',async()=>{
  const [mobiglass,server]=await Promise.all([readFile(new URL('../public/js/orders-mobiglass.js',import.meta.url),'utf8'),readFile(new URL('../src/server.js',import.meta.url),'utf8')]);
  assert.match(server,/CASE WHEN cu\.profile_public THEN '\/profile\/' \|\| cu\.id::text ELSE null END AS creator_profile_path/);
  assert.match(server,/CASE WHEN au\.profile_public THEN '\/profile\/' \|\| au\.id::text ELSE null END AS assignee_profile_path/);
  assert.match(server,/profile_path',CASE WHEN u\.profile_public THEN '\/profile\/' \|\| u\.id::text ELSE null END/);
  assert.match(server,/publicProfileApiMatch/);
  assert.match(server,/profile_public=true AND account_status='active'/);
  assert.match(mobiglass,/const profileName=.*mg-profile-link/);
  assert.match(mobiglass,/contributorNames/);
  assert.match(mobiglass,/const openProfile=async/);
  assert.match(mobiglass,/OPEN RSI PROFILE/);
  assert.match(mobiglass,/profile\.discord_name,'Not provided'/);
});
test('Mobiglass Orders copies deep links and focuses orders by immutable ID',async()=>{
  const [source,server]=await Promise.all([readFile(new URL('../public/js/orders-mobiglass.js',import.meta.url),'utf8'),readFile(new URL('../src/server.js',import.meta.url),'utf8')]);
  assert.match(source,/ORDER ID/);
  assert.match(source,/o\.order_number/);
  assert.match(source,/data-copy-order-link/);
  assert.match(source,/COPY LINK/);
  assert.match(source,/navigator\.clipboard\.writeText/);
  assert.match(source,/orderSharePath\(order\)/);
  assert.match(source,/state\.focusOrderId=target\?String\(target\.id\):null/);
  assert.match(source,/const visible=visibleOrders\(\)/);
  assert.match(source,/scrollIntoView\(\{block:'center',behavior:'smooth'\}\)/);
  for(const code of ['AGRI','ALUM','HEPH','QUAN','TUNG'])assert.match(server,new RegExp(`'${code}'`));
  assert.match(server,/materialOrderCode\(material\)/);
  assert.match(server,/order_number='ITEM-'/);
  assert.match(server,/order_number ~ '\^ORD-/);
});
