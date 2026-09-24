import test from 'node:test';
import assert from 'node:assert/strict';
import {
  quantityModeOf, usesQuantity, repeatsWholeItem, instanceLimitOf, workQuantityLimitOf,
  WORK_INSTANCE_LIMIT, WORK_QUANTITY_LIMIT,
  itemRange, itemMinutes, orderRange, orderRangeAll, orderMinutes,
  orderAllDone, orderWaitingForPart, orderPausedForPart, orderHasFreeWork, waitingLast, orderWaitingLast,
  customFaultRange,
} from '../web/order-calc.js';

// --- режим количества ------------------------------------------------------

test('quantityModeOf defaults an unknown or missing mode to "single"', () => {
  assert.equal(quantityModeOf({}), 'single');
  assert.equal(quantityModeOf({ quantityMode: 'bogus' }), 'single');
  assert.equal(quantityModeOf({ quantityMode: 'instances' }), 'instances');
  assert.equal(quantityModeOf({ quantityMode: 'quantity' }), 'quantity');
});

test('usesQuantity/repeatsWholeItem only apply to instances and quantity modes', () => {
  assert.equal(usesQuantity({ quantityMode: 'single' }), false);
  assert.equal(usesQuantity({ quantityMode: 'quantity' }), true);
  assert.equal(usesQuantity({ quantityMode: 'instances' }), true);
  // Только "instances" повторяет ВЕСЬ пункт (запчасти/усложнения тоже);
  // "quantity" умножает только саму операцию — это разница, из-за которой
  // существуют две ветки в itemRange (см. ниже).
  assert.equal(repeatsWholeItem({ quantityMode: 'quantity' }), false);
  assert.equal(repeatsWholeItem({ quantityMode: 'instances' }), true);
});

test('workQuantityLimitOf uses the work\'s own maxInstances for "instances", falls back to the shared caps otherwise', () => {
  assert.equal(workQuantityLimitOf({ quantityMode: 'instances', maxInstances: 3 }), 3);
  assert.equal(workQuantityLimitOf({ quantityMode: 'instances', maxInstances: 0 }), WORK_INSTANCE_LIMIT);
  assert.equal(workQuantityLimitOf({ quantityMode: 'quantity' }), WORK_QUANTITY_LIMIT);
  assert.equal(instanceLimitOf({ quantityMode: 'instances' }), WORK_INSTANCE_LIMIT);
  assert.equal(instanceLimitOf({ quantityMode: 'quantity' }), 0);
});

// --- itemRange ---------------------------------------------------------------

test('itemRange: plain work with no qty/difficulties is just its price, min == max', () => {
  const it = { workPrice: 600, qty: 1, difficulties: [] };
  assert.deepEqual(itemRange(it), { min: 600, max: 600 });
});

test('itemRange: quantityMode "quantity" multiplies only the work price by qty, not parts or difficulties', () => {
  const it = {
    quantityMode: 'quantity', qty: 3, workPrice: 100, partsPrice: 10,
    parts: [{ price: 5, qty: 2 }], // partsCost = 10
    difficulties: [{ add: 50, qty: 1, state: 'yes' }],
  };
  // workPrice*qty = 300; parts (10+10)=20 добавляются один раз (wholeItemQty=1);
  // усложнение тоже один раз (50), а не x3 — только сама операция множится.
  assert.deepEqual(itemRange(it), { min: 370, max: 370 });
});

test('itemRange: quantityMode "instances" multiplies the whole item — price, parts and difficulties — by qty', () => {
  const it = {
    quantityMode: 'instances', qty: 3, workPrice: 100, partsPrice: 10,
    parts: [{ price: 5, qty: 2 }], // partsCost = 10
    difficulties: [{ add: 50, qty: 1, state: 'yes' }],
  };
  // (100*3) + (10+10)*3 + 50*3 = 300 + 60 + 150 = 510
  assert.deepEqual(itemRange(it), { min: 510, max: 510 });
});

test('itemRange: difficulty state yes affects both min and max, unknown only max, no affects neither', () => {
  const base = { workPrice: 100, qty: 1 };
  const yes = itemRange({ ...base, difficulties: [{ add: 40, qty: 1, state: 'yes' }] });
  const unknown = itemRange({ ...base, difficulties: [{ add: 40, qty: 1, state: 'unknown' }] });
  const no = itemRange({ ...base, difficulties: [{ add: 40, qty: 1, state: 'no' }] });
  assert.deepEqual(yes, { min: 140, max: 140 });
  assert.deepEqual(unknown, { min: 100, max: 140 });
  assert.deepEqual(no, { min: 100, max: 100 });
});

test('itemRange: a difficulty\'s own qty (multiple:true) multiplies its addon', () => {
  const it = { workPrice: 0, qty: 1, difficulties: [{ add: 40, qty: 3, state: 'yes' }] };
  assert.deepEqual(itemRange(it), { min: 120, max: 120 });
});

// --- itemMinutes ---------------------------------------------------------------

test('itemMinutes: unlike itemRange, "unknown" difficulties are always counted in (pessimistic single number, not a range)', () => {
  const base = { estimateMinutes: 20, qty: 1 };
  assert.equal(itemMinutes({ ...base, difficulties: [{ addMinutes: 10, qty: 1, state: 'yes' }] }), 30);
  assert.equal(itemMinutes({ ...base, difficulties: [{ addMinutes: 10, qty: 1, state: 'unknown' }] }), 30);
  assert.equal(itemMinutes({ ...base, difficulties: [{ addMinutes: 10, qty: 1, state: 'no' }] }), 20);
});

// --- итоги по заявке -----------------------------------------------------------

test('orderRange only counts agreed items, orderRangeAll counts everything', () => {
  const o = {
    items: [
      { workPrice: 100, qty: 1, agreed: true, difficulties: [] },
      { workPrice: 200, qty: 1, agreed: false, difficulties: [] },
    ],
  };
  assert.deepEqual(orderRange(o), { min: 100, max: 100 });
  assert.deepEqual(orderRangeAll(o), { min: 300, max: 300 });
});

test('orderMinutes respects the onlyAgreed flag the same way', () => {
  const o = {
    items: [
      { estimateMinutes: 10, qty: 1, agreed: true, difficulties: [] },
      { estimateMinutes: 15, qty: 1, agreed: false, difficulties: [] },
    ],
  };
  assert.equal(orderMinutes(o, true), 10);
  assert.equal(orderMinutes(o, false), 25);
});

test('orderAllDone requires every item to be agreed AND done — not just the agreed ones', () => {
  const done = (agreed) => ({ agreed, done: true });
  assert.equal(orderAllDone({ items: [done(true), done(true)] }), true);
  assert.equal(orderAllDone({ items: [] }), false, 'empty order is not "all done"');
  assert.equal(orderAllDone({ items: [done(true), { agreed: false, done: false }] }), false,
    'an unagreed item still pending blocks handover, even though every AGREED item is done');
  assert.equal(orderAllDone({ items: [{ agreed: true, done: false }] }), false);
});

test('orderWaitingForPart/orderPausedForPart: paused means every agreed item is either done or waiting, and at least one is waiting', () => {
  const waiting = { agreed: true, done: false, waitingForPart: true };
  const done = { agreed: true, done: true };
  const pending = { agreed: true, done: false };
  assert.equal(orderWaitingForPart({ items: [waiting, done] }), true);
  assert.equal(orderPausedForPart({ items: [waiting, done] }), true);
  // Кто-то ещё реально работает (pending, не ждёт и не готово) — заявка не «встала».
  assert.equal(orderPausedForPart({ items: [waiting, pending] }), false);
  assert.equal(orderPausedForPart({ items: [done, done] }), false);
});

test('orderHasFreeWork: an item waiting for a part is never "free", even if nobody formally claimed it (legacy data without claimedBy)', () => {
  const untouched = { done: false, claimedBy: null };
  const claimed = { done: false, claimedBy: { masterId: 'u1' } };
  const waitingClaimed = { done: false, claimedBy: { masterId: 'u1' }, waitingForPart: { masterId: 'u1' } };
  const waitingUnclaimed = { done: false, claimedBy: null, waitingForPart: { masterId: 'u1' } };
  assert.equal(orderHasFreeWork({ items: [] }), true, 'an order with no items at all still counts as "free" (nothing blocks it)');
  assert.equal(orderHasFreeWork({ items: [untouched] }), true);
  assert.equal(orderHasFreeWork({ items: [claimed] }), false);
  // Баг из скриншота пользователя: работу пометили «ждёт запчасть», но
  // claimedBy почему-то не выставился — раньше именно это заставляло тег
  // на главном экране показывать «Свободна» вместо «Ожидает запчасть».
  assert.equal(orderHasFreeWork({ items: [waitingUnclaimed] }), false);
  assert.equal(orderHasFreeWork({ items: [waitingClaimed] }), false);
  assert.equal(orderHasFreeWork({ items: [waitingClaimed, untouched] }), true,
    'one item stuck on a part does not hide that another item in the same order is still free to pick up');
});

test('waitingLast keeps a stable relative order and only pushes waiting-for-part items to the end', () => {
  // Тот самый баг из истории: сортировать нужно уже сгруппированный список
  // по одной позиции на карточку, а не сырые order.items до группировки —
  // иначе экземпляры одной и той же повторяющейся работы (например, три
  // спицы) физически перемешиваются местами внутри своей же группы, и
  // «Экземпляр 2 из 3» на карусели от перерисовки к перерисовке указывает
  // на разные физические экземпляры.
  const items = [
    { code: 'a', done: false, waitingForPart: false },
    { code: 'b', done: false, waitingForPart: true },
    { code: 'c', done: false, waitingForPart: false },
    { code: 'd', done: false, waitingForPart: true },
    { code: 'e', done: false, waitingForPart: false },
  ];
  const sorted = [...items].sort(waitingLast);
  assert.deepEqual(sorted.map((i) => i.code), ['a', 'c', 'e', 'b', 'd']);
});

test('waitingLast does not defer an item that is already done, even if waitingForPart is still set on it', () => {
  const items = [
    { code: 'a', done: true, waitingForPart: true }, // done — не считается "ждущим"
    { code: 'b', done: false, waitingForPart: false },
  ];
  assert.deepEqual([...items].sort(waitingLast).map((i) => i.code), ['a', 'b']);
});

test('orderWaitingLast sorts whole orders the same way, by whether any of their items are paused for a part', () => {
  const waitingOrder = { items: [{ agreed: true, done: false, waitingForPart: true }] };
  const activeOrder = { items: [{ agreed: true, done: false, waitingForPart: false }] };
  assert.deepEqual([waitingOrder, activeOrder].sort(orderWaitingLast), [activeOrder, waitingOrder]);
});

test('customFaultRange is just the flat admin-set price, no range', () => {
  assert.deepEqual(customFaultRange({ price: 450 }), { min: 450, max: 450 });
  assert.deepEqual(customFaultRange({}), { min: 0, max: 0 });
});
