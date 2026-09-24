// Отмена последних действий («встряхнуть, чтобы отменить» и кнопка
// «Отменить»). Чистые функции без DOM и сети — проверяются юнит-тестами
// (tests/undo.test.js).
//
// Запоминаем не весь снимок базы, а только то, что изменило действие: по
// каждой затронутой записи — «до» и «после». При отмене возвращаем только те
// поля, которые это действие поменяло (для работ в обращении — по коду
// работы), — чужие правки, пришедшие с сервера после (другой мастер отметил
// другую работу), при этом не затираются.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const isObject = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

const COLLECTIONS = [["orders", "number"], ["clients", "phone"], ["bikes", "number"]];

// Что изменилось между двумя состояниями базы: [{ coll, key, id, before, after }],
// before/after = null — записи не было / её убрали.
export function diffDB(before, after) {
  const changes = [];
  for (const [coll, key] of COLLECTIONS) {
    const was = new Map((before?.[coll] || []).map((x) => [x[key], x]));
    const now = new Map((after?.[coll] || []).map((x) => [x[key], x]));
    for (const id of new Set([...was.keys(), ...now.keys()])) {
      const b = was.get(id) ?? null, a = now.get(id) ?? null;
      if (!same(b, a)) changes.push({ coll, key, id, before: clone(b), after: clone(a) });
    }
  }
  return changes;
}

// Работы в обращении — список по коду: откатываем по одной работе.
function revertList(cur, before, after) {
  const b = new Map((before || []).map((x) => [x.code, x]));
  const a = new Map((after || []).map((x) => [x.code, x]));
  let out = [...(cur || [])];
  for (const code of new Set([...b.keys(), ...a.keys()])) {
    const bi = b.get(code), ai = a.get(code);
    if (same(bi, ai)) continue;
    const idx = out.findIndex((x) => x.code === code);
    if (bi === undefined) { if (idx >= 0) out.splice(idx, 1); continue; }
    if (idx < 0) {
      // Работу убрали — возвращаем на её прежнее место среди соседей.
      const pos = (before || []).findIndex((x) => x.code === code);
      out.splice(Math.min(pos, out.length), 0, clone(bi));
      continue;
    }
    out[idx] = revertValue(out[idx], bi, ai);
  }
  return out;
}

// Вернуть в cur только то, чем after отличается от before.
export function revertValue(cur, before, after) {
  if (same(cur, after) || !isObject(cur) || !isObject(before) || !isObject(after)) return clone(before);
  const out = { ...cur };
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (same(before[k], after[k])) continue;
    if (!Object.hasOwn(before, k)) delete out[k];
    else if (k === "items" && Array.isArray(before[k])) out[k] = revertList(cur[k], before[k], after[k]);
    else out[k] = clone(before[k]);
  }
  return out;
}

// Применить отмену к базе (меняет db на месте).
export function applyUndo(db, changes) {
  for (const { coll, key, id, before, after } of changes) {
    const list = db[coll] || (db[coll] = []);
    const idx = list.findIndex((x) => x[key] === id);
    if (before === null) { if (idx >= 0) list.splice(idx, 1); continue; }
    if (idx < 0) { list.push(clone(before)); continue; }
    list[idx] = revertValue(list[idx], before, after);
  }
}

// Выдачу клиенту так не откатить: сервер не даёт менять выданное (оплаченное)
// обращение — это учётная запись для 1С и выработки мастеров.
const handedOver = (o) => !!o && (o.status === "выдан" || !!o.handedOverAt);
export const undoable = (changes) => changes.length > 0 &&
  !changes.some((c) => c.coll === "orders" && (handedOver(c.before) || handedOver(c.after)));

const q = (s) => `«${s}»`;
function describeItem(b, a) {
  const name = (a || b).name || "работа";
  if (!b) return `добавление работы ${q(name)}`;
  if (!a) return `удаление работы ${q(name)}`;
  if (!!b.done !== !!a.done) return a.done ? `отметку «готово» у ${q(name)}` : `снятие отметки «готово» у ${q(name)}`;
  if (!same(b.waitingForPart, a.waitingForPart)) return a.waitingForPart ? `«жду запчасть» у ${q(name)}` : `снятие «жду запчасть» у ${q(name)}`;
  // Количество, запчасти и усложнения — раньше «взятия»: правка работы сама
  // закрепляет её за мастером, но нажимал человек именно на счётчик.
  if ((b.qty || 1) !== (a.qty || 1)) return `количество у ${q(name)}`;
  if (!same(b.parts, a.parts)) return `запчасти у ${q(name)}`;
  if (!same(b.difficulties, a.difficulties)) return `усложнения у ${q(name)}`;
  if (!same(b.claimedBy, a.claimedBy)) return a.claimedBy ? `взятие работы ${q(name)}` : `освобождение работы ${q(name)}`;
  if (!!b.agreed !== !!a.agreed) return `согласование ${q(name)}`;
  return `изменение работы ${q(name)}`;
}
function describeOrder(b, a) {
  if (!b) return "создание обращения";
  if (!a) return "удаление обращения";
  const bi = new Map((b.items || []).map((x) => [x.code, x]));
  const ai = new Map((a.items || []).map((x) => [x.code, x]));
  const itemChanges = [...new Set([...bi.keys(), ...ai.keys()])].filter((c) => !same(bi.get(c), ai.get(c)));
  if (itemChanges.length === 1) return describeItem(bi.get(itemChanges[0]), ai.get(itemChanges[0]));
  if (itemChanges.length > 1) return "изменение работ в обращении";
  if (b.request !== a.request) return "изменение уточнений";
  if (b.status !== a.status) return "смену статуса обращения";
  return "изменение обращения";
}
// Человеческое описание того, что будет отменено («добавление работы «Спица»»).
export function describeUndo(changes) {
  const orders = changes.filter((c) => c.coll === "orders");
  if (orders.length === 1) return describeOrder(orders[0].before, orders[0].after);
  if (orders.length > 1) return "изменение нескольких обращений";
  if (changes.some((c) => c.coll === "clients")) return "изменение клиента";
  if (changes.some((c) => c.coll === "bikes")) return "изменение велосипеда";
  return "последнее действие";
}
