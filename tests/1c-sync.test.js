import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { signSession } from '../api/_lib.js';
import handler from '../api/1c-sync.js';

const oldSecret = process.env.SESSION_SECRET;
process.env.SESSION_SECRET = 'test-only-secret';

const req = (opts = {}) => ({
  method: opts.method || 'GET',
  headers: { cookie: opts.uid ? `vella_session=${signSession({ uid: opts.uid })}` : '' },
});
const res = () => ({ statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; } });

// requireAdmin looks up the caller's role in the "vella:users" store through
// the same injected redis client — this fake serves both that lookup and
// the db-merge CAS eval, so the whole handler runs against one fake client
// exactly as it does against one real Redis connection in production.
function fakeRedis(initial, userRole = 'admin') {
  let data = structuredClone(initial), version = 0;
  return {
    async eval(script, _keys, args) {
      if (!args.length) return [JSON.stringify(data), String(version)];
      if (Number(args[0]) !== version) return 0;
      data = JSON.parse(args[1]); version++;
      return 1;
    },
    async get(key) { return key === 'vella:users' ? { users: [{ id: 'admin1', role: userRole, active: true }] } : null; },
  };
}

const sampleDb = () => ({
  clients: [], bikes: [],
  orders: [
    { number: 'V1', clientPhone: '', bikeNumber: '', handedOverAt: '2026-09-14T10:00:00.000Z', exportedTo1C: false, items: [] },
    { number: 'V2', clientPhone: '', bikeNumber: '', handedOverAt: '2026-09-15T10:00:00.000Z', exportedTo1C: true, items: [] },
    { number: 'V3', clientPhone: '', bikeNumber: '', handedOverAt: null, exportedTo1C: false, items: [] },
  ],
  counters: { order: 3, bike: 0 },
});

test('storage not configured -> 503', async () => {
  const response = res();
  await handler(req({ uid: 'admin1' }), response, null);
  assert.equal(response.statusCode, 503);
});

test('not logged in -> 401', async () => {
  const response = res();
  await handler(req(), response, fakeRedis(sampleDb()));
  assert.equal(response.statusCode, 401);
});

test('logged in but not admin -> 403', async () => {
  const response = res();
  await handler(req({ uid: 'admin1' }), response, fakeRedis(sampleDb(), 'master'));
  assert.equal(response.statusCode, 403);
});

test('GET returns only handed-over, not-yet-exported orders', async () => {
  const response = res();
  await handler(req({ uid: 'admin1' }), response, fakeRedis(sampleDb()));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.orders.map((o) => o.number), ['V1']);
});

test('POST marks every currently pending order exported, recomputed fresh', async () => {
  const r = fakeRedis(sampleDb());
  const response = res();
  await handler(req({ uid: 'admin1', method: 'POST' }), response, r);
  assert.deepEqual(response.body, { ok: true, marked: 1 });

  const check = res();
  await handler(req({ uid: 'admin1' }), check, r);
  assert.deepEqual(check.body.orders, []);
});

test('POST is idempotent when nothing is pending', async () => {
  const r = fakeRedis(sampleDb());
  await handler(req({ uid: 'admin1', method: 'POST' }), res(), r);
  const second = res();
  await handler(req({ uid: 'admin1', method: 'POST' }), second, r);
  assert.deepEqual(second.body, { ok: true, marked: 0 });
});

after(() => {
  if (oldSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = oldSecret;
});
