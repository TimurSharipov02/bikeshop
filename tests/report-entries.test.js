import test from 'node:test';
import assert from 'node:assert/strict';
import { reportEntries } from '../web/report-entries.js';

test('chart and history credit all completed work on the handover date', () => {
  const orders = [{ number: 'V1', handedOverAt: '2026-09-24T12:00:00Z', items: [
    { code: 'A', doneBy: { masterId: 'timur', at: '2026-09-21T12:00:00Z' } },
    { code: 'B', doneBy: { masterId: 'timur', at: '2026-09-24T09:00:00Z' } },
    { code: 'C', doneBy: { masterId: 'other', at: '2026-09-21T10:00:00Z' } },
  ] }];
  const beforePayment = reportEntries(orders, 'timur', new Date('2026-09-21T00:00:00Z'), new Date('2026-09-22T00:00:00Z'));
  assert.deepEqual(beforePayment, []);
  const paid = reportEntries(orders, 'timur', new Date('2026-09-24T00:00:00Z'), new Date('2026-09-25T00:00:00Z'));
  assert.deepEqual(paid.map(({ item }) => item.code), ['A', 'B']);
  assert.ok(paid.every(({ at }) => at.getTime() === Date.parse(orders[0].handedOverAt)));
  assert.equal(reportEntries(orders, 'timur').length, 2);
});
