// Расчёт цены/времени работы и статуса заявки — чистые функции без DOM,
// сети или хранилища, поэтому их можно проверять обычными юнит-тестами
// (см. tests/order-calc.test.js) без браузера и без jsdom.

export const quantityModeOf = (x) => {
  if (["single", "instances", "quantity"].includes(x?.quantityMode)) return x.quantityMode;
  return "single";
};
// И одинаковые экземпляры, и общее количество живут одной строкой и имеют
// счётчик. Разница в расчёте: экземпляр повторяет всю работу целиком, а
// общее количество умножает только саму операцию (например, несколько спиц).
export const usesQuantity = (x) => ["instances", "quantity"].includes(quantityModeOf(x));
export const repeatsWholeItem = (x) => quantityModeOf(x) === "instances";
export const WORK_INSTANCE_LIMIT = 5;
export const WORK_QUANTITY_LIMIT = 64;
export const instanceLimitOf = (x) => quantityModeOf(x) === "instances" ? WORK_INSTANCE_LIMIT : 0;
export const workQuantityLimitOf = (x) => repeatsWholeItem(x) ? (x.maxInstances || WORK_INSTANCE_LIMIT) : WORK_QUANTITY_LIMIT;

// qty у работы и у каждого усложнения — сколько раз это сделано (несколько
// колёс, несколько спиц и т.п.); значимо только когда у работы/усложнения
// стоит галочка «несколько», иначе всегда 1 и ни на что не влияет.
export const partsCost = (parts) => (parts || []).reduce((s, p) => s + (p.price || 0) * (p.qty || 1), 0);
// Сколько из цены работы приходится на запчасти (они не зависят от
// усложнений, поэтому одно число, а не вилка) — для отдельного пузыря цены
// запчастей рядом с ценой самой работы.
export const itemPartsCost = (it) =>
  ((it.partsPrice || 0) + partsCost(it.parts)) * (repeatsWholeItem(it) ? (it.qty || 1) : 1);
export function itemRange(it) {
  const qty = it.qty || 1;
  const wholeItemQty = repeatsWholeItem(it) ? qty : 1;
  const base = (it.workPrice || 0) * qty + ((it.partsPrice || 0) + partsCost(it.parts)) * wholeItemQty;
  let min = base, max = base;
  for (const d of it.difficulties || []) {
    const amt = (d.add || 0) * (d.qty || 1) * wholeItemQty;
    if (d.state === "yes") { min += amt; max += amt; }
    else if (d.state === "unknown") max += amt;
  }
  return { min, max };
}

// Ориентировочное время работы с учётом отмеченных трудностей (будет/неизвестно
// тоже добавляют время, как и цену — на «неизвестно» берём время по максимуму).
export function itemMinutes(it) {
  const qty = it.qty || 1;
  const wholeItemQty = repeatsWholeItem(it) ? qty : 1;
  let m = (it.estimateMinutes || 0) * qty;
  for (const d of it.difficulties || []) {
    if (d.state === "yes" || d.state === "unknown") m += (d.addMinutes || 0) * (d.qty || 1) * wholeItemQty;
  }
  return m;
}
export const orderRange = (o) =>
  o.items.filter((i) => i.agreed).reduce(
    (a, it) => { const r = itemRange(it); return { min: a.min + r.min, max: a.max + r.max }; },
    { min: 0, max: 0 });
// До согласования ничего ещё не отмечено agreed — считаем по всему списку целиком.
export const orderRangeAll = (o) =>
  o.items.reduce((a, it) => { const r = itemRange(it); return { min: a.min + r.min, max: a.max + r.max }; }, { min: 0, max: 0 });
// Ориентировочное время — не для мастера в интерфейсе наравне с ценой, а тихой строкой для клиента.
export const orderMinutes = (o, onlyAgreed) =>
  o.items.filter((i) => !onlyAgreed || i.agreed).reduce((s, it) => s + itemMinutes(it), 0);

// Все согласованные работы отмечены готовыми — заявка фактически готова к
// выдаче, даже если статус в базе всё ещё «взята в работу» (отдельной
// стадии для этого больше нет). Используется и на самом экране «Ремонт»
// (когда включать «Выдать клиенту»), и в списке обращений (какой тег
// показать).
export const orderAllDone = (o) => {
  const agreed = o.items.filter((i) => i.agreed);
  return agreed.length > 0 && agreed.length === o.items.length && agreed.every((i) => i.done);
};
// Хотя бы одна согласованная и ещё не готовая работа помечена «ждёт
// запчасть» (см. openRepairSheet) — заявка фактически стоит, даже если
// статус в базе всё ещё «взята в работу»: отдельной стадии для этого нет,
// это только отображаемый тег (см. orderStatusTag), как и «Готово к выдаче».
export const orderWaitingForPart = (o) => o.items.some((i) => i.agreed && !i.done && i.waitingForPart);
export const orderPausedForPart = (o) => o.items.length > 0 &&
  o.items.every((i) => i.agreed && (i.done || i.waitingForPart)) && orderWaitingForPart(o);
// «Свободна» в orderStatusTag — есть работа, которую прямо сейчас может
// взять любой мастер: ещё не готова, никем не занята. Работа, вставшая
// из-за детали, этому не подходит, даже если её никто формально не
// «занял» (например, отметили «жду запчасть» без claimedBy, старые
// данные) — иначе тег «Свободна» перекрывает «Ожидает запчасть» и
// пользователь не видит, что заявка на самом деле стоит.
export const orderHasFreeWork = (o) => !o.items.length || o.items.some((i) => !i.done && !i.claimedBy && !i.waitingForPart);
// Встали, ждём деталь — работа пока не актуальна, не должна мешать сканировать
// список того, что реально ещё предстоит сделать: опускаем её в конец
// (sort стабильный, порядок остального не трогает). Сортировать нужно уже
// СГРУППИРОВАННЫЙ список (по одной позиции на карточку/экземпляр), а не
// сырые order.items до группировки — иначе экземпляры одной и той же
// повторяющейся работы перемешиваются между собой (см. историю багов).
export const waitingLast = (a, b) => (a.waitingForPart && !a.done ? 1 : 0) - (b.waitingForPart && !b.done ? 1 : 0);
// То же самое, но для списка обращений целиком (главный экран) — заявка,
// которая стоит из-за запчасти, не должна закрывать собой те, что можно
// делать прямо сейчас.
export const orderWaitingLast = (a, b) => (orderWaitingForPart(a) ? 1 : 0) - (orderWaitingForPart(b) ? 1 : 0);

// То же для неисправности, заведённой админом вручную (цена лежит в ней самой).
export function customFaultRange(f) {
  const base = f.price || 0;
  return { min: base, max: base };
}
