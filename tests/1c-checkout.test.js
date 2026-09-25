import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/1c-checkout.js';
import { assertWorkAccess } from '../api/_work-access.js';

const previousKey = process.env.INTEGRATION_1C_KEY;
const previousMode = process.env.INTEGRATION_1C_CHECKOUT;
const previousPreview = process.env.INTEGRATION_1C_PREVIEW;
process.env.INTEGRATION_1C_KEY = 'cashier-test-key';
process.env.INTEGRATION_1C_CHECKOUT = '1';
after(() => {
  if (previousKey === undefined) delete process.env.INTEGRATION_1C_KEY;
  else process.env.INTEGRATION_1C_KEY = previousKey;
  if (previousMode === undefined) delete process.env.INTEGRATION_1C_CHECKOUT;
  else process.env.INTEGRATION_1C_CHECKOUT = previousMode;
  if (previousPreview === undefined) delete process.env.INTEGRATION_1C_PREVIEW;
  else process.env.INTEGRATION_1C_PREVIEW = previousPreview;
});

const db = () => ({ clients: [], bikes: [], counters: {}, orders: [{
  number: 'V1', status: 'взята в работу', items: [{ code: 'a', agreed: true, done: true,
    doneBy: { masterId: 'm1', masterName: 'Тимур' },
    qty: 1, workPrice: 500, parts: [{ sku: 'A', name: 'Камера', qty: 1, price: 250 }], difficulties: [] }],
}] });
function fakeRedis() {
  let data = db(), version = 0;
  return { async get() { return { users: [] }; }, async eval(_script, _keys, args) {
    if (!args.length) return [JSON.stringify(data), String(version)];
    if (Number(args[0]) !== version) return 0;
    data = JSON.parse(args[1]); version++;
    return 1;
  }, read: () => data, change: (fn) => fn(data) };
}
const res = () => ({ statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; } });
async function call(redis, method, payload = {}) {
  const response = res();
  await handler({ method, headers: { 'x-1c-key': 'cashier-test-key' },
    query: { number: payload.number || 'V1' }, body: payload }, response, redis);
  return response;
}
const receipt = { fn: '1234567890123456', fd: '123', fp: '456789' };

test('1C retrieves an exact quote and confirms one fiscal receipt once', async () => {
  const r = fakeRedis();
  const quote = (await call(r, 'GET')).body.order;
  assert.equal(quote.total, 750);
  assert.deepEqual(quote.laborLines, [{ masterId: 'm1', masterName: 'Тимур', serviceBarcode: '2000999796289', amount: 500 }]);
  assert.match(quote.quoteId, /^[a-f0-9]{64}$/);
  const payment = { number: 'V1', quoteId: quote.quoteId, total: 750, receipt };
  const first = await call(r, 'POST', payment);
  assert.equal(first.statusCode, 200);
  assert.equal(first.body.alreadyConfirmed, false);
  assert.equal(r.read().orders[0].status, 'выдан');
  assert.equal(r.read().orders[0].exportedTo1C, true);
  assert.deepEqual(r.read().orders[0].fiscalReceipt, receipt);
  assert.equal((await call(r, 'POST', payment)).body.alreadyConfirmed, true);
  assert.equal((await call(r, 'GET')).statusCode, 409);
});

test('preview permits reading a quote while payment and direct issuance stay disabled', async () => {
  process.env.INTEGRATION_1C_CHECKOUT = '0';
  process.env.INTEGRATION_1C_PREVIEW = '1';
  try {
    const r = fakeRedis();
    const quote = await call(r, 'GET');
    assert.equal(quote.statusCode, 200);
    assert.equal(quote.body.order.total, 750);
    assert.equal((await call(r, 'POST', { number: 'V1', quoteId: quote.body.order.quoteId,
      total: 750, receipt })).statusCode, 503);
    assert.equal(r.read().orders[0].handedOverAt, undefined);
    const current = db(), next = structuredClone(current);
    next.orders[0].status = 'выдан';
    next.orders[0].handedOverAt = new Date().toISOString();
    assert.doesNotThrow(() => assertWorkAccess(current, next, { uid: 'admin', role: 'admin' }));
  } finally {
    process.env.INTEGRATION_1C_CHECKOUT = '1';
  }
});

test('stale quote and wrong sum never mark the order paid', async () => {
  const r = fakeRedis();
  const quote = (await call(r, 'GET')).body.order;
  assert.equal((await call(r, 'POST', { number: 'V1', quoteId: quote.quoteId, total: 749, receipt })).statusCode, 409);
  r.change((d) => { d.orders[0].items[0].workPrice = 600; });
  assert.equal((await call(r, 'POST', { number: 'V1', quoteId: quote.quoteId, total: 750, receipt })).statusCode, 409);
  assert.equal(r.read().orders[0].handedOverAt, undefined);
});

test('normal user cannot issue directly when 1C checkout is enabled', () => {
  const current = db(), next = structuredClone(current);
  next.orders[0].status = 'выдан'; next.orders[0].handedOverAt = new Date().toISOString();
  assert.throws(() => assertWorkAccess(current, next, { uid: 'admin', role: 'admin' }), /1С/);
});

test('a fiscal receipt cannot be used for a second order', async () => {
  const r = fakeRedis();
  r.change((d) => { d.orders.push({ ...structuredClone(d.orders[0]), number: 'V2' }); });
  const first = (await call(r, 'GET')).body.order;
  const second = (await call(r, 'GET', { number: 'V2' })).body.order;
  assert.equal((await call(r, 'POST', { number: 'V1', quoteId: first.quoteId, total: 750, receipt })).statusCode, 200);
  // Та же операция в списке УНФ может отображаться как 00000123.
  const sameReceiptWithZeros = { ...receipt, fd: '00000123', fp: '0000456789' };
  assert.equal((await call(r, 'POST', { number: 'V2', quoteId: second.quoteId,
    total: 750, receipt: sameReceiptWithZeros })).statusCode, 409);
  assert.equal(r.read().orders[1].handedOverAt, undefined);
  assert.equal((await call(r, 'POST', { number: 'V1', quoteId: first.quoteId,
    total: 750, receipt: sameReceiptWithZeros })).body.alreadyConfirmed, true);
});

test('fiscal receipt fields must contain the printed numeric identifiers', async () => {
  const r = fakeRedis(), quote = (await call(r, 'GET')).body.order;
  const response = await call(r, 'POST', { number: 'V1', quoteId: quote.quoteId,
    total: 750, receipt: { ...receipt, fn: 'not-a-fiscal-number' } });
  assert.equal(response.statusCode, 400);
  assert.equal(r.read().orders[0].handedOverAt, undefined);
});

test('incomplete work cannot be paid; missing integration key is unauthorized', async () => {
  const r = fakeRedis();
  r.change((d) => { d.orders[0].items[0].done = false; });
  assert.equal((await call(r, 'GET')).statusCode, 409);
  const response = res();
  await handler({ method: 'GET', headers: {}, query: { number: 'V1' } }, response, r);
  assert.equal(response.statusCode, 401);
});

test('cashier receives a separate service amount for each master', async () => {
  const r = fakeRedis();
  r.change((d) => {
    d.orders[0].items.push({ code: 'b', agreed: true, done: true, workPrice: 300, qty: 1,
      doneBy: { masterId: 'm2', masterName: 'Сергей' }, difficulties: [], parts: [] });
  });
  const response = await call(r, 'GET');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.order.laborLines.map((line) => [line.masterName, line.amount]),
    [['Тимур', 500], ['Сергей', 300]]);
  assert.equal(response.body.order.total, 1050);
});

test('an unknown master cannot be charged through another master service', async () => {
  const r = fakeRedis();
  r.change((d) => { d.orders[0].items[0].doneBy = { masterId: 'm3', masterName: 'Другой мастер' }; });
  const response = await call(r, 'GET');
  assert.equal(response.statusCode, 400);
  assert.match(response.body.error, /штрихкодом/);
});
