import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { MergeConflict } from '../api/_db-merge.js';
import { reopenIssuedOrder, assertOrderDeletable, canReopen, REOPEN_WINDOW_MS } from '../api/_issued-order.js';
import { signSession } from '../api/_lib.js';
import dbHandler from '../api/db.js';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const issued = (extra = {}) => ({
  number: 'V1', status: 'выдан', handedOverAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
  handedOverBy: { masterId: 'm1', masterName: 'Тимур' }, items: [{ code: 'A', agreed: true, done: true }], ...extra,
});
const db = (order) => ({ clients: [], bikes: [], orders: [order], counters: { order: 1, bike: 0 } });
const admin = { uid: 'a1', role: 'admin' };
const master = { uid: 'm1', role: 'master' };
const other = { uid: 'm2', role: 'master' };

test('admin can return an issued order to work; history keeps a trace', () => {
  const data = db(issued());
  reopenIssuedOrder(data, 'V1', admin, NOW);
  const o = data.orders[0];
  assert.equal(o.status, 'взята в работу');
  assert.equal(o.handedOverAt, undefined);
  assert.equal(o.handedOverBy, undefined);
  assert.deepEqual(o.history.map((h) => [h.by, h.what]), [['a1', 'выдача отменена']]);
});

test('a master may undo only their own handover and only within 15 minutes', () => {
  assert.equal(canReopen(issued(), master, NOW), true);
  assert.equal(canReopen(issued(), other, NOW), false, 'someone else\'s handover');
  const old = issued({ handedOverAt: new Date(NOW - REOPEN_WINDOW_MS - 1000).toISOString() });
  assert.equal(canReopen(old, master, NOW), false, 'too late');
  assert.equal(canReopen(old, admin, NOW), true, 'admin has no time limit');
  assert.throws(() => reopenIssuedOrder(db(old), 'V1', master, NOW), MergeConflict);
});

test('anything that went through 1C (receipt or export) is locked for everyone', () => {
  for (const extra of [{ exportedTo1C: true }, { fiscalReceipt: { fn: '1', fd: '2', fp: '3' } }]) {
    assert.throws(() => reopenIssuedOrder(db(issued(extra)), 'V1', admin, NOW), /1С/);
    assert.throws(() => assertOrderDeletable(issued(extra), admin), /1С/);
  }
});

test('an issued order can be deleted by an admin only; unissued orders are unaffected', () => {
  assert.doesNotThrow(() => assertOrderDeletable(issued(), admin));
  assert.throws(() => assertOrderDeletable(issued(), master), /администратор/);
  assert.doesNotThrow(() => assertOrderDeletable({ number: 'V2', status: 'взята в работу' }, master));
  assert.doesNotThrow(() => assertOrderDeletable(undefined, master));
});

// --- через сам обработчик /api/db (сессия, CAS-хранилище) ---------------------

const oldSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = 'test-only-secret';
function fakeRedis(initial) {
  let data = structuredClone(initial), version = 0;
  return { async eval(_s, _k, args) {
    if (!args.length) return [JSON.stringify(data), String(version)];
    if (Number(args[0]) !== version) return 0;
    data = JSON.parse(args[1]); version++;
    return 1;
  }, read: () => structuredClone(data) };
}
const users = { get: async () => ({ users: [{ id: 'a1', role: 'admin', active: true }, { id: 'm2', role: 'master', active: true }] }) };
const call = async (uid, method, body, r) => {
  const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; } };
  const role = uid === 'a1' ? 'admin' : 'master';
  await dbHandler({ method, body, headers: { cookie: `vella_session=${signSession({ uid, role })}` } }, res, r, users);
  return res;
};

test('POST action:reopen and DELETE of an issued order go through the handler with these rules', async () => {
  const r = fakeRedis(db(issued({ handedOverAt: new Date().toISOString() })));
  const denied = await call('m2', 'DELETE', { number: 'V1' }, r);
  assert.equal(denied.statusCode, 409);
  const reopened = await call('a1', 'POST', { action: 'reopen', number: 'V1' }, r);
  assert.equal(reopened.statusCode, 200);
  assert.equal(r.read().orders[0].status, 'взята в работу');

  const r2 = fakeRedis(db(issued()));
  const removed = await call('a1', 'DELETE', { number: 'V1' }, r2);
  assert.equal(removed.statusCode, 200);
  assert.equal(r2.read().orders.length, 0);
});

after(() => {
  if (oldSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = oldSecret;
});
