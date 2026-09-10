import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { capabilities, inviteUsageLabel, staleLabel } from '../public/js/groups-core.js';

test('maps owner and admin capabilities',()=>{assert.deepEqual(capabilities({role:'owner'},{is_admin:false}),{owner:true,admin:false,member:true});assert.equal(capabilities({role:'member'},{is_admin:true}).admin,true)});
test('uses API stale flag directly',()=>{assert.equal(staleLabel({stale:true}),'NO RECENT SYNC (24H)');assert.equal(staleLabel({stale:false}),'CURRENT')});
test('labels invite usage from max_uses',()=>{assert.equal(inviteUsageLabel({max_uses:null}),'REUSABLE');assert.equal(inviteUsageLabel({max_uses:1}),'ONE TIME')});
test('Classic and Mobiglass Groups share the unfiltered groups logo',async()=>{const [classic,mobiglass,server]=await Promise.all([readFile(new URL('../public/groups.html',import.meta.url),'utf8'),readFile(new URL('../public/js/groups-mobiglass.js',import.meta.url),'utf8'),readFile(new URL('../src/server.js',import.meta.url),'utf8')]);for(const source of [classic,mobiglass])assert.match(source,/src="\/assets\/apps\/groups\.png"/);assert.match(classic,/href="\/assets\/apps\/groups\.png"/);assert.match(mobiglass,/\.gg-logo\{[^}]*object-fit:contain/);assert.doesNotMatch(mobiglass,/\.gg-logo\{[^}]*\b(?:filter|opacity|mix-blend-mode)\s*:/);assert.match(server,/"\/assets\/apps\/groups\.png"/)});
test('invite creation supports reusable invites with a validated expiry period',async()=>{const [mobiglass,server]=await Promise.all([readFile(new URL('../public/js/groups-mobiglass.js',import.meta.url),'utf8'),readFile(new URL('../src/server.js',import.meta.url),'utf8')]);assert.match(mobiglass,/MULTI-USE/);assert.match(mobiglass,/expires_in_days/);assert.match(server,/expiryDays < 1 \|\| expiryDays > 365/);assert.match(server,/reusable \? null : 1/)});
