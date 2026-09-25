import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/1c-export.js';
import { orderFor1C } from '../web/pricing.js';

const oldKey = process.env.INTEGRATION_1C_KEY;
process.env.INTEGRATION_1C_KEY = 'test-1c-key';

const req = (opts = {}) => ({ method: opts.method || 'GET', query: opts.query || {}, body: opts.body });
const res = () => ({ statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; } });

// Implements the two small EVAL scripts in memory, same as tests/db-sync.test.js.
function fakeRedis(initial) {
  let data = structuredClone(initial), version = 0;
  return { async get() { return { users: [] }; }, async eval(script, _keys, args) {
    if (!args.length) return [JSON.stringify(data), String(version)];
    if (Number(args[0]) !== version) return 0;
    data = JSON.parse(args[1]); version++;
    return 1;
  } };
}

const sampleDb = () => ({
  clients: [{ phone: '+79990000000', name: 'Иван' }],
  bikes: [{ number: 'B1', name: 'Trek' }],
  orders: [
    {
      number: 'V1', clientPhone: '+79990000000', bikeNumber: 'B1', handedOverAt: '2026-09-20T10:00:00.000Z', exportedTo1C: false,
      items: [
        { code: 'a', agreed: true, workPrice: 500, qty: 1, doneBy: { masterId: 'm1', masterName: 'Тимур' }, difficulties: [], partsPrice: 75, parts: [{ sku: 'TUBE', name: 'Камера', qty: 1, price: 250 }] },
        { code: 'b', agreed: true, workPrice: 200, qty: 1, doneBy: { masterId: 'm2', masterName: 'Сергей' }, difficulties: [], parts: [] },
        { code: 'c', agreed: true, workPrice: 100, qty: 1, doneBy: { masterId: 'm1', masterName: 'Тимур' }, difficulties: [], parts: [] },
      ],
    },
    {
      number: 'V2', clientPhone: '+79990000000', bikeNumber: 'B1', handedOverAt: '2026-09-19T10:00:00.000Z', exportedTo1C: true,
      items: [{ code: 'b', agreed: true, workPrice: 300, qty: 1, difficulties: [], parts: [] }],
    },
    {
      number: 'V3', clientPhone: '+79990000000', bikeNumber: 'B1', handedOverAt: null, exportedTo1C: false,
      items: [{ code: 'c', agreed: true, workPrice: 100, qty: 1, difficulties: [], parts: [] }],
    },
  ],
  counters: { order: 3, bike: 1 },
});

test('storage not configured -> 503', async () => {
  const response = res();
  await handler(req(), response, null);
  assert.equal(response.statusCode, 503);
});

test('INTEGRATION_1C_KEY unset -> 503', async () => {
  delete process.env.INTEGRATION_1C_KEY;
  const response = res();
  await handler(req(), response, fakeRedis(sampleDb()));
  assert.equal(response.statusCode, 503);
  process.env.INTEGRATION_1C_KEY = 'test-1c-key';
});

test('missing or wrong key -> 401', async () => {
  const r1 = res();
  await handler(req(), r1, fakeRedis(sampleDb()));
  assert.equal(r1.statusCode, 401);

  const r2 = res();
  await handler(req({ query: { key: 'wrong' } }), r2, fakeRedis(sampleDb()));
  assert.equal(r2.statusCode, 401);
});

test('GET returns only handed-over, not-yet-exported orders with correct parts/laborSum', async () => {
  const response = res();
  await handler(req({ query: { key: 'test-1c-key' } }), response, fakeRedis(sampleDb()));
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.orders.length, 1);
  const o = response.body.orders[0];
  assert.equal(o.number, 'V1');
  assert.equal(o.clientName, 'Иван');
  assert.equal(o.bikeName, 'Trek');
  assert.deepEqual(o.parts, [{ sku: 'TUBE', name: 'Камера', qty: 1, price: 250 }]);
  assert.equal(o.laborSum, 800);
  assert.deepEqual(o.laborLines, [
    { masterId: 'm1', masterName: 'Тимур', serviceBarcode: '2000999796289', amount: 600 },
    { masterId: 'm2', masterName: 'Сергей', serviceBarcode: '2000999796371', amount: 200 },
  ]);
  assert.equal(o.partsSum, 325);
  assert.equal(o.unallocatedPartsSum, 75);
  assert.equal(o.total, 1125);
  assert.equal(o.exportedTo1C, false);
});

test('GET ?all=1 returns every handed-over order, including already-exported, without changing anything', async () => {
  const response = res();
  await handler(req({ query: { key: 'test-1c-key', all: '1' } }), response, fakeRedis(sampleDb()));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.orders.map((o) => [o.number, o.exportedTo1C]), [['V1', false], ['V2', true]]);
});

test('configured service barcode overrides the name fallback and Elnar has a distinct barcode', () => {
  const data = sampleDb();
  data.orders[0].items[0].doneBy = { masterId: 'm3', masterName: 'Эльнар' };
  assert.equal(orderFor1C(data, data.orders[0]).laborLines[0].serviceBarcode, '2000999806483');
  assert.equal(orderFor1C(data, data.orders[0], { barcodesByMaster: { m3: '2000000000008' } })
    .laborLines[0].serviceBarcode, '2000000000008');
});

test('POST marks the given numbers exported and is idempotent on re-POST', async () => {
  const r = fakeRedis(sampleDb());
  const first = res();
  await handler(req({ method: 'POST', body: { key: 'test-1c-key', numbers: ['V1'] } }), first, r);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body, { ok: true, marked: 1 });

  const check = res();
  await handler(req({ query: { key: 'test-1c-key', all: '1' } }), check, r);
  assert.equal(check.body.orders.find((o) => o.number === 'V1').exportedTo1C, true);

  const second = res();
  await handler(req({ method: 'POST', body: { key: 'test-1c-key', numbers: ['V1'] } }), second, r);
  assert.deepEqual(second.body, { ok: true, marked: 0 });
});

test('POST without numbers -> 400', async () => {
  const response = res();
  await handler(req({ method: 'POST', body: { key: 'test-1c-key', numbers: [] } }), response, fakeRedis(sampleDb()));
  assert.equal(response.statusCode, 400);
});

test('POST rejects unknown or unissued numbers without marking other orders', async () => {
  const r = fakeRedis(sampleDb());
  const response = res();
  await handler(req({ method: 'POST', body: { key: 'test-1c-key', numbers: ['V1', 'V3'] } }), response, r);
  assert.equal(response.statusCode, 400);
  const check = res();
  await handler(req({ query: { key: 'test-1c-key' } }), check, r);
  assert.deepEqual(check.body.orders.map((o) => o.number), ['V1']);
});

after(() => {
  if (oldKey === undefined) delete process.env.INTEGRATION_1C_KEY;
  else process.env.INTEGRATION_1C_KEY = oldKey;
});
