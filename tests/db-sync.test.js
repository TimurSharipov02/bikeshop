import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDB, MergeConflict } from '../api/_db-merge.js';
import { updateDB, loadDB } from '../api/_atomic-db.js';
import { itemWorkValue } from '../web/pricing.js';
import { assertWorkAccess } from '../api/_work-access.js';

const order = () => ({ number: 'V1', items: [
  { code: 'A', done: false, workPrice: 100 },
  { code: 'B', done: false, workPrice: 200 },
] });
const db = () => ({ clients: [], bikes: [], orders: [order()], counters: { order: 1, bike: 0 } });
const copy = (v) => structuredClone(v);

// Implements the two small EVAL scripts in memory, including their CAS semantics.
function fakeRedis(initial = db()) {
  let data = copy(initial), version = 0;
  return { async eval(script, _keys, args) {
    if (!args.length) return [JSON.stringify(data), String(version)];
    if (Number(args[0]) !== version) return 0;
    data = JSON.parse(args[1]); version++;
    return 1;
  }, read: () => copy(data) };
}

test('simultaneous edits to different work items both survive', async () => {
  const r = fakeRedis(), base = db();
  const first = copy(base), second = copy(base);
  first.orders[0].items[0].done = true;
  second.orders[0].items[1].done = true;
  await Promise.all([
    updateDB(r, (current) => mergeDB(base, first, current)),
    updateDB(r, (current) => mergeDB(base, second, current)),
  ]);
  assert.deepEqual(r.read().orders[0].items.map((it) => it.done), [true, true]);
  assert.equal((await loadDB(r)).version, 2);
});

test('one master cannot alter or delete work claimed by another', () => {
  const current = db();
  current.orders[0].status = 'взята в работу';
  current.orders[0].items[0].agreed = true;
  current.orders[0].items[0].claimedBy = { masterId: 'one', masterName: 'One' };
  const other = { uid: 'two', role: 'master' };
  const edited = copy(current);
  edited.orders[0].items[0].done = true;
  assert.throws(() => assertWorkAccess(current, edited, other), MergeConflict);
  const deleted = copy(current);
  deleted.orders[0].items.shift();
  assert.throws(() => assertWorkAccess(current, deleted, other), MergeConflict);
  const own = copy(current);
  own.orders[0].items[0].done = true;
  assert.doesNotThrow(() => assertWorkAccess(current, own, { uid: 'one', role: 'master' }));
});

test('a stale handover cannot skip a newly added unfinished work item', () => {
  const base = db();
  base.orders[0].status = 'взята в работу';
  base.orders[0].items.forEach((item) => { item.agreed = true; item.done = true; });
  const current = copy(base), handover = copy(base);
  current.orders[0].items.push({ code: 'C', name: 'New work', agreed: true, done: false });
  handover.orders[0].status = 'выдан';
  const merged = mergeDB(base, handover, current);
  assert.throws(() => assertWorkAccess(current, merged, { uid: 'one', role: 'master' }), MergeConflict);
});

test('changes to different fields of one work item both survive', () => {
  const base = db(), first = copy(base), second = copy(base);
  first.orders[0].items[0].done = true;
  second.orders[0].items[0].workPrice = 120;
  const merged = mergeDB(base, second, mergeDB(base, first, base));
  assert.equal(merged.orders[0].items[0].done, true);
  assert.equal(merged.orders[0].items[0].workPrice, 120);
});

test('a stale browser cannot resurrect a deleted order', async () => {
  const r = fakeRedis(), base = db();
  await updateDB(r, (current) => ({ ...current, orders: [] }));
  const stale = copy(base);
  stale.clients.push({ phone: '123', name: 'Client' });
  await updateDB(r, (current) => mergeDB(base, stale, current));
  assert.equal(r.read().orders.length, 0);
  assert.equal(r.read().clients.length, 1);
});

test('changes to the same field require manual resolution', () => {
  const base = db(), current = copy(base), next = copy(base);
  current.orders[0].items[0].workPrice = 300;
  next.orders[0].items[0].workPrice = 400;
  assert.throws(() => mergeDB(base, next, current), MergeConflict);
});

test('an export flag is retained when an older client edits the order', () => {
  const base = db(), current = copy(base), next = copy(base);
  current.orders[0].exportedTo1C = true;
  next.orders[0].items[0].done = true;
  const merged = mergeDB(base, next, current).orders[0];
  assert.equal(merged.exportedTo1C, true);
  assert.equal(merged.items[0].done, true);
});

test('1C and the app share the calculation for repeated work', () => {
  assert.equal(itemWorkValue({ quantityMode: 'instances', qty: 2, workPrice: 100,
    difficulties: [{ state: 'yes', add: 50, qty: 1 }] }), 300);
});
