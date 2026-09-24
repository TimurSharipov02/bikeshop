// Данные лежат и в браузере (мгновенный доступ), и на сервере /api/db (общие
// для всех устройств). При каждой правке пишем локально и отправляем на
// сервер; при переходе между экранами подтягиваем свежие данные. Если сервер
// недоступен (нет интернета или не подключена база) — работаем только
// локально.
//
// Сюда же — вход и сессия: куки (HttpOnly) ставит сервер (/api/auth), клиент
// их не читает — только спрашивает "кто я" через GET и шлёт действия через
// POST. Без сессии роутер показывает только экран входа/первого запуска.
// И кэш серверных справочников (остатки, работы, мастера), которые
// подтягиваются один раз и обновляются по мере правок.

import { diffDB, applyUndo, undoable, describeUndo } from "./undo.js";

export const DB_KEY = "vella.db.v1";
export const DB_BASE_KEY = "vella.db.server.v1";
export const DB_DIRTY_KEY = "vella.db.dirty.v1";

// Переименования статусов («в работе» → «принята»/«взята в работу», «проверка»
// → «готово к выдаче»). Старые записи приводим к новым статусам при каждой
// загрузке; исправление уедет на сервер со следующим же пушем (он шлёт всю DB
// целиком), отдельная разовая миграция не нужна.
// Для завершённой работы (done:true) усложнение не может оставаться в
// состоянии «неизвестно» — это прогнозное значение, для факта его больше
// не предлагают (см. difficultyList с fact:true), но в старых данных оно
// могло остаться нетронутым. Без него itemRange считает такую работу
// диапазоном, а не точной ценой, хотя по факту она уже сделана.
const fixDoneDifficulties = (items) =>
  (items || []).map((it) => {
    if (!it.done || !(it.difficulties || []).some((d) => d.state === "unknown")) return it;
    return { ...it, difficulties: it.difficulties.map((d) => (d.state === "unknown" ? { ...d, state: "no" } : d)) };
  });

// Запчасти раньше были просто названиями (строками) без цены и количества —
// приводим к {name, price, qty}, иначе itemRange не может посчитать их
// стоимость, а старые записи ломают рендер списка (ожидает объект).
const fixPartsShape = (items) =>
  (items || []).map((it) => {
    if (!(it.parts || []).some((p) => typeof p === "string")) return it;
    return { ...it, parts: it.parts.map((p) => (typeof p === "string" ? { name: p, price: 0, qty: 1 } : p)) };
  });

// «Кто сделал» прошло два формата: сперва просто имя строкой (doneBy),
// потом — список completions {masterId, masterName, qty, at}, чтобы делить
// размноженный пункт между несколькими мастерами по qty. От дележа по qty
// отказались (см. историю): пункт либо неразделим — один мастер на весь
// пункт, либо, если реально нужно несколько человек, оформляется отдельными
// позициями наряда (см. instanceCode). Приводим оба старых формата к
// единственному doneBy-объекту {masterId, masterName, at}; если completions
// было несколько (старые записи до отказа от дележа) — берём самую позднюю.
const fixDoneBy = (items) =>
  (items || []).map((it) => {
    if (!it.completions && (!it.doneBy || typeof it.doneBy !== "string")) return it;
    let doneBy = null;
    if (it.completions && it.completions.length) {
      const last = it.completions.reduce((a, b) => (!a.at || (b.at && b.at > a.at) ? b : a));
      doneBy = { masterId: last.masterId || null, masterName: last.masterName || "—", at: last.at || null };
    } else if (typeof it.doneBy === "string") {
      doneBy = { masterId: null, masterName: it.doneBy || "—", at: null };
    }
    const { completions, ...rest } = it;
    return { ...rest, doneBy };
  });

export const migrateOrders = (orders) =>
  (orders || []).map((o) => {
    let next = o;
    if (next.status === "в работе") next = { ...next, status: "взята в работу" };
    // «принята» убрали как отдельный шаг — заявки без хозяина (occupiedBy)
    // сами доберут его при открытии (см. viewOrder), тут только статус.
    if (next.status === "принята") next = { ...next, status: "взята в работу" };
    if (next.status === "проверка") next = { ...next, status: "готово к выдаче" };
    // «готово к выдаче» тоже убрали отдельным шагом — экран «в работе» и так
    // показывает тот же список работ и предлагает «Выдать клиенту», как
    // только всё отмечено готовым; отдельная стадия-подтверждение не нужна.
    if (next.status === "готово к выдаче") next = { ...next, status: "взята в работу" };
    // «оценка» убрали как отдельный шаг — её функциональность (количество,
    // усложнения, итог) переехала в диагностику на стадии «приём»; раз
    // заявка уже дошла до отдельного экрана оценки, дальше остаётся только
    // один шаг — согласование.
    if (next.status === "оценка") next = { ...next, status: "согласование" };
    let items = fixDoneDifficulties(next.items);
    items = fixPartsShape(items);
    items = fixDoneBy(items);
    if (items !== next.items) next = { ...next, items };
    return next;
  });

// Раньше у велосипеда были отдельные марка и модель — теперь одна строка
// name. Старые записи (только brand/model, без name) склеиваем в неё разом;
// сами поля brand/model в новых записях больше нигде не пишутся.
export const migrateBikes = (bikes) =>
  (bikes || []).map((b) => {
    if (b.name) return b;
    return { number: b.number, ownerPhone: b.ownerPhone, name: [b.brand, b.model].filter(Boolean).join(" ") };
  });

export const normalizeDB = (d) => ({
  clients: d?.clients || [], bikes: migrateBikes(d?.bikes), orders: migrateOrders(d?.orders),
  counters: { order: 0, bike: 0, ...(d?.counters || {}) },
});

export function safeParse(s) { try { return JSON.parse(s || "{}"); } catch { return {}; } }

export let DB = normalizeDB(safeParse(localStorage.getItem(DB_KEY)));
export let BASE = normalizeDB(safeParse(localStorage.getItem(DB_BASE_KEY) || localStorage.getItem(DB_KEY)));
export let serverOK = false;
let pushTimer = null;
export let dirty = localStorage.getItem(DB_DIRTY_KEY) === "1";
let conflictShown = false;
let sending = Promise.resolve();
// Счётчик «поколений» пуша — см. pushToServer(): нужен, чтобы устаревший
// ответ (пока он летел, случилась ещё одна правка) не затёр более свежие
// локальные изменения и не сбросил dirty раньше времени.
let pushGen = 0;
// Мы внутри экрана, отрисованного мимо router() (диагностика, «уточнение
// усложнений», подбор работы, техпроцедура) — хеш при этом не меняется,
// поэтому фоновый adopt() после debounce-пуша не должен звать router():
// он бы молча подменил такой экран обычным видом обращения по тому же хешу.
// Ставит/снимает флаг сам роутер (router()/enterSubScreen в app.js), тут
// только читаем — сюда, а не наоборот, чтобы не заводить кольцевой импорт
// между слоем данных и роутером.
let inSubScreen = false;
export function setInSubScreen(v) { inSubScreen = v; }

export let SESSION = null; // { login, name, role } | null
export let NEEDS_SETUP = false;

export async function authAction(body) {
  const r = await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "ошибка");
  return j;
}
export async function loadSession() {
  try {
    const r = await fetch("/api/auth", { cache: "no-store" });
    const j = await r.json();
    SESSION = j.authenticated ? j.user : null;
    NEEDS_SETUP = !!j.needsSetup;
  } catch { SESSION = null; }
}
export async function logout() {
  try { await authAction({ action: "logout" }); } catch {}
  SESSION = null;
  location.hash = "/";
  router();
}

// Остатки по запчастям — для выбора детали при отметке работы готовой.
let stockCache = null;
export function clearStockCache() { stockCache = null; }
export async function ensureStock() {
  if (stockCache) return stockCache;
  try {
    const r = await fetch("/api/stock", { cache: "no-store" });
    const j = await r.json();
    stockCache = r.ok ? j.items || [] : [];
  } catch { stockCache = []; }
  return stockCache;
}

// Неисправности, заведённые администратором вручную на экране диагностики
// (без .proc-процедуры, цена/время/усложнения — прямо в них самих). Общие
// для всех, привязаны к узлу (group = id блока диагностики).
export let repairsCache = null;
export function clearRepairsCache() { repairsCache = null; }
export async function ensureRepairs() {
  if (repairsCache) return repairsCache;
  try {
    const r = await fetch("/api/repairs", { cache: "no-store" });
    const j = await r.json();
    repairsCache = r.ok ? j.items || [] : [];
  } catch { repairsCache = []; }
  return repairsCache;
}

// Список мастеров (имя/роль/процент) — нужен отчётам о выработке (кто
// сколько заработал), не только админке. Сбрасывается при любой правке
// мастера (см. usersApi), чтобы отчёт не показывал устаревший процент.
export let usersCache = null;
export function clearUsersCache() { usersCache = null; }
export async function ensureUsers() {
  if (usersCache) return usersCache;
  try {
    const r = await fetch("/api/users", { cache: "no-store" });
    const j = await r.json();
    usersCache = r.ok ? j.users || [] : [];
  } catch { usersCache = []; }
  return usersCache;
}

export const loadDB = () => DB;
export function writeLocal() { localStorage.setItem(DB_KEY, JSON.stringify(DB)); }

export function adopt(next) {
  const before = JSON.stringify(DB);
  DB = normalizeDB(next);
  BASE = structuredClone(DB);
  localStorage.setItem(DB_BASE_KEY, JSON.stringify(BASE));
  writeLocal();
  if (JSON.stringify(DB) !== before && !inSubScreen && !location.hash.startsWith("#/orders/new")) router();
}

export async function syncFromServer() {
  if (typeof fetch !== "function") return;
  try {
    const r = await fetch("/api/db", { cache: "no-store" });
    if (!r.ok) return;
    const wasServerOK = serverOK;
    serverOK = true;
    // Если есть несохранённые локальные правки — не затирать их устаревшим
    // ответом сервера; правки уедут своим пушем и вернутся уже слитыми.
    if (!dirty) adopt(await r.json());
    if (!wasServerOK && !location.hash.startsWith("#/orders/new")) router();
  } catch { /* оффлайн — остаёмся на локальных данных */ }
}

export function pushToServer() {
  if (typeof fetch !== "function") return;
  dirty = true;
  localStorage.setItem(DB_DIRTY_KEY, "1");
  clearTimeout(pushTimer);
  const myGen = ++pushGen;
  pushTimer = setTimeout(async () => {
    await sendSnapshot(myGen);
  }, 250);
}

export async function sendSnapshot(myGen) {
  const previous = sending;
  let release;
  sending = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const base = structuredClone(BASE);
    const next = structuredClone(DB);
    const r = await fetch("/api/db", { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ base, next }) });
    if (r.status === 409 && !conflictShown) {
      conflictShown = true;
      const { current } = await r.json();
      if (myGen === pushGen && current && confirm("Эти же данные изменили на другом устройстве. Загрузить их версию? Ваши несохранённые правки на этом устройстве будут отменены.")) {
        dirty = false;
        localStorage.removeItem(DB_DIRTY_KEY);
        conflictShown = false;
        adopt(current);
      }
    }
    if (!r.ok) return false;
    serverOK = true;
    const json = await r.json();
    if (myGen === pushGen) {
      dirty = false;
      localStorage.removeItem(DB_DIRTY_KEY);
      conflictShown = false;
      adopt(json);
    } else {
      BASE = normalizeDB(json);
      localStorage.setItem(DB_BASE_KEY, JSON.stringify(BASE));
    }
    return true;
  } catch { return false; }
  finally { release(); }
}

export function saveDB(d) { DB = normalizeDB(d); writeLocal(); pushToServer(); }
// Каждое действие через editDB запоминается для отмены (web/undo.js):
// только что изменилось — «до» и «после» по затронутым записям.
const UNDO_LIMIT = 30;
const undoStack = [];
let undoListener = null;
export const onUndoRecorded = (fn) => { undoListener = fn; };
export const peekUndo = () => undoStack[undoStack.length - 1] || null;
export function editDB(fn) {
  const before = structuredClone(DB);
  fn(DB);
  const changes = diffDB(before, DB);
  if (undoable(changes)) {
    undoStack.push({ changes, label: describeUndo(changes), at: Date.now() });
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    undoListener?.(peekUndo());
  } else if (changes.length) {
    // Действие, которое нельзя отменить (выдача клиенту), — более ранние
    // отмены через него уже не проходят, сбрасываем историю.
    undoStack.length = 0;
  }
  writeLocal(); pushToServer();
}
// Отменить последнее действие: вернуть только то, что оно поменяло.
export function undoLast() {
  const entry = undoStack.pop();
  if (!entry) return null;
  applyUndo(DB, entry.changes);
  writeLocal(); pushToServer();
  return entry;
}
export function editOrder(number, fn) {
  editDB((d) => { const o = d.orders.find((x) => x.number === number); if (o) fn(o); });
}

// Удаление обращения — отдельным запросом мимо обычного merge-пуша (см.
// api/db.js): слияние только объединяет, само по себе стереть запись на
// сервере не может. При неудаче (офлайн) ничего не трогаем локально, чтобы
// запись не «ожила» после следующей синхронизации.
export async function deleteOrderApi(number) {
  try {
    if (dirty && !(await flushPending())) return false;
    const r = await fetch("/api/db", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ number }) });
    if (!r.ok) return false;
    serverOK = true;
    adopt(await r.json());
    return true;
  } catch { return false; }
}
// Тот же принцип — клиента/велосипед тоже нельзя просто убрать локально и
// дождаться обычного пуша: mergeDB на сервере видит объединение и вернёт
// удалённую запись обратно на следующем же слиянии.
// withOrders — каскад: заодно удалить незакрытые обращения клиента (при
// смене номера телефона старая запись удаляется без каскада — её обращения
// к этому моменту уже переведены на новый номер).
export async function deleteClientApi(phone, { withOrders = false } = {}) {
  try {
    if (dirty && !(await flushPending())) return false;
    const r = await fetch("/api/db", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientPhone: phone, withOrders }) });
    if (!r.ok) return false;
    serverOK = true;
    adopt(await r.json());
    return true;
  } catch { return false; }
}
export async function deleteBikeApi(number) {
  try {
    if (dirty && !(await flushPending())) return false;
    const r = await fetch("/api/db", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ bikeNumber: number }) });
    if (!r.ok) return false;
    serverOK = true;
    adopt(await r.json());
    return true;
  } catch { return false; }
}
// Как editDB, но без 250мс-дебаунса и с ожиданием ответа сервера — нужно
// там, где следующий шаг (например, DELETE вдогонку) должен видеть уже
// отправленные правки, а не гнаться с ними наперегонки за debounce-таймером
// обычного pushToServer().
export async function pushDbNow(fn) {
  fn(DB);
  writeLocal();
  dirty = true;
  localStorage.setItem(DB_DIRTY_KEY, "1");
  return flushPending();
}

export async function flushPending() {
  clearTimeout(pushTimer);
  return sendSnapshot(++pushGen);
}
