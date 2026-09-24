import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/1c-stock.js';
import { sanitizeStockItems } from '../api/stock.js';

const oldKey = process.env.INTEGRATION_1C_KEY;
process.env.INTEGRATION_1C_KEY = 'test-1c-key';

const req = (opts = {}) => ({ method: opts.method || 'POST', body: opts.body || {} });
const res = () => ({ statusCode: 200, body: null, status(n) { this.statusCode = n; return this; }, json(x) { this.body = x; return this; } });

function fakeRedis(initial = null) {
  let store = initial;
  return { async get() { return store; }, async set(_k, v) { store = v; }, read: () => store };
}

test('storage not configured -> 503', async () => {
  const response = res();
  await handler(req(), response, null);
  assert.equal(response.statusCode, 503);
});

test('INTEGRATION_1C_KEY unset -> 503', async () => {
  delete process.env.INTEGRATION_1C_KEY;
  const response = res();
  await handler(req({ body: { key: 'anything', items: [] } }), response, fakeRedis());
  assert.equal(response.statusCode, 503);
  process.env.INTEGRATION_1C_KEY = 'test-1c-key';
});

test('wrong key -> 401, store untouched', async () => {
  const r = fakeRedis({ items: [{ sku: 'OLD', name: 'старое', qty: 1 }], updatedAt: 't0', source: 'manual' });
  const response = res();
  await handler(req({ body: { key: 'wrong', items: [{ sku: 'NEW', name: 'новое', qty: 5 }] } }), response, r);
  assert.equal(response.statusCode, 401);
  assert.equal(r.read().items[0].sku, 'OLD');
});

test('method other than POST -> 405', async () => {
  const response = res();
  await handler(req({ method: 'GET' }), response, fakeRedis());
  assert.equal(response.statusCode, 405);
});

test('valid push replaces the store with source "1c" and a fresh updatedAt', async () => {
  const r = fakeRedis({ items: [{ sku: 'OLD', name: 'старое', qty: 1 }], updatedAt: 't0', source: 'manual' });
  const response = res();
  const items = [{ sku: 'TUBE-26', name: 'Камера 26"', qty: 12, unit: 'шт', price: 350, group: 'WHL', maxQty: 2 }];
  await handler(req({ body: { key: 'test-1c-key', items } }), response, r);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { ok: true, count: 1, updatedAt: r.read().updatedAt });
  assert.deepEqual(r.read().items, items);
  assert.equal(r.read().source, '1c');
  assert.notEqual(r.read().updatedAt, 't0');
});

test('field coercion matches sanitizeStockItems exactly', async () => {
  const r = fakeRedis({ items: [{ sku: 'X', name: 'x', qty: 1 }], updatedAt: 't0', source: 'manual' });
  const raw = [
    { sku: 'A1', name: 'Позиция', qty: '7' }, // missing unit/price/group/maxQty, string qty
    { sku: '  ', name: '  ' }, // filtered out: blank sku and name
  ];
  const response = res();
  await handler(req({ body: { key: 'test-1c-key', items: raw } }), response, r);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(r.read().items, sanitizeStockItems(raw));
});

test('empty list without force is rejected when the store was non-empty; force clears it', async () => {
  const r = fakeRedis({ items: [{ sku: 'A', name: 'a', qty: 1 }], updatedAt: 't0', source: 'manual' });
  const rejected = res();
  await handler(req({ body: { key: 'test-1c-key', items: [] } }), rejected, r);
  assert.equal(rejected.statusCode, 400);
  assert.equal(r.read().items.length, 1);

  const forced = res();
  await handler(req({ body: { key: 'test-1c-key', items: [], force: true } }), forced, r);
  assert.equal(forced.statusCode, 200);
  assert.deepEqual(r.read().items, []);
});

after(() => {
  if (oldKey === undefined) delete process.env.INTEGRATION_1C_KEY;
  else process.env.INTEGRATION_1C_KEY = oldKey;
});
