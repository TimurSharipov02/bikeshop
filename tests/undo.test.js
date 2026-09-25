import test from 'node:test';
import assert from 'node:assert/strict';
import { diffDB, applyUndo, revertValue, undoable, describeUndo } from '../web/undo.js';

const clone = (x) => JSON.parse(JSON.stringify(x));
const order = (items, extra = {}) => ({ number: '1', status: 'взята в работу', request: '', items, ...extra });
const work = (code, extra = {}) => ({ code, name: `Работа ${code}`, qty: 1, done: false, ...extra });

test('undoing an added work removes exactly that work', () => {
  const before = { orders: [order([work('a')])], clients: [], bikes: [] };
  const after = clone(before); after.orders[0].items.push(work('b'));
  const changes = diffDB(before, after);
  assert.equal(describeUndo(changes), 'добавление работы «Работа b»');
  const db = clone(after);
  applyUndo(db, changes);
  assert.deepEqual(db, before);
});

test('undo keeps changes to other works that arrived from the server afterwards', () => {
  const before = { orders: [order([work('a'), work('b')])] };
  const after = clone(before); after.orders[0].items[0].done = true; // мы отметили «a»
  const changes = diffDB(before, after);
  assert.equal(describeUndo(changes), 'отметку «готово» у «Работа a»');
  const current = clone(after); current.orders[0].items[1].qty = 3; // другой мастер поменял «b»
  applyUndo(current, changes);
  assert.equal(current.orders[0].items[0].done, false, 'our change is reverted');
  assert.equal(current.orders[0].items[1].qty, 3, 'the other master\'s change stays');
});

test('a removed work comes back in its old place; a created order disappears', () => {
  const before = { orders: [order([work('a'), work('b'), work('c')])] };
  const after = clone(before); after.orders[0].items.splice(1, 1);
  const db = clone(after);
  applyUndo(db, diffDB(before, after));
  assert.deepEqual(db.orders[0].items.map((i) => i.code), ['a', 'b', 'c']);

  const created = clone(before); created.orders.push(order([], { number: '2' }));
  const changes = diffDB(before, created);
  assert.equal(describeUndo(changes), 'создание обращения');
  applyUndo(created, changes);
  assert.deepEqual(created.orders.map((o) => o.number), ['1']);
});

test('field-level revert only touches fields the action changed', () => {
  const before = { request: 'старое', status: 'приём' };
  const after = { request: 'новое', status: 'приём' };
  const current = { request: 'новое', status: 'взята в работу' };
  assert.deepEqual(revertValue(current, before, after), { request: 'старое', status: 'взята в работу' });
});

test('handing an order over to the client is not undoable (the server locks issued orders)', () => {
  const before = { orders: [order([work('a', { done: true })])] };
  const after = clone(before); after.orders[0].status = 'выдан'; after.orders[0].handedOverAt = '2026-09-25T00:00:00Z';
  assert.equal(undoable(diffDB(before, after)), false);
  const edited = clone(before); edited.orders[0].request = 'x';
  assert.equal(undoable(diffDB(before, edited)), true);
  assert.equal(undoable([]), false, 'nothing changed — nothing to undo');
});

test('the description names what was tapped: a quantity change that also claims the work reads as "количество"', () => {
  const before = { orders: [order([work('a')])] };
  const after = clone(before);
  Object.assign(after.orders[0].items[0], { qty: 2, claimedBy: { masterId: 'u' } });
  assert.equal(describeUndo(diffDB(before, after)), 'количество у «Работа a»');
});

test('a handover is recognised so the undo button can ask the server to reopen the order', async () => {
  const { handoverOf } = await import('../web/undo.js');
  const before = { orders: [order([work('a', { done: true })])] };
  const after = clone(before); after.orders[0].status = 'выдан'; after.orders[0].handedOverAt = '2026-09-25T00:00:00Z';
  assert.equal(handoverOf(diffDB(before, after)), '1');
  const edited = clone(before); edited.orders[0].request = 'x';
  assert.equal(handoverOf(diffDB(before, edited)), null);
});
