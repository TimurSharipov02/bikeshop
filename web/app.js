// ============================================================================
//  Веломастерская Vella — всё приложение в одном файле.
//  Обычный JavaScript. Ни сборщиков, ни фреймворков.
//
//    CATALOG  — процедуры / неисправности / цены (вшиты в HTML при сборке)
//    DB       — обращения, клиенты, велосипеды (localStorage браузера)
//    PRICES   — правки прайса поверх дефолтных (localStorage)
//
//  Как всё устроено:
//    1. Роутер смотрит на #адрес и вызывает нужный экран (view*).
//    2. Экран строит DOM и кладёт его в #app.
//    3. Раннер (runner.js) ведёт мастера по шагам процедуры;
//       весь ввод-вывод — через объект io, который рисует кнопки.
// ============================================================================

import { buildCatalog, runProcedure } from "./runner.js";

const RAW = window.CATALOG;
const cat = buildCatalog(RAW.procedures);
const defaultPrices = RAW.prices;
// Версия — время сборки страницы (проставляется при npm run build / деплое).
const BUILD_TIME = RAW.generatedAt
  ? new Date(RAW.generatedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
  : "";

// Блоки диагностики (catalog/diagnostics.json) + учебный слой (catalog/training.json).
// Мойка не диагностируется, но пусть тоже группируется по-человечески, а не в «Прочее».
const diagBlocks = RAW.diagnosticBlocks || [];
const training = RAW.training || {};
const BLOCK_TITLES = [...diagBlocks.map((b) => b.title), "Мойка и консервация"];
const blockByPrefix = { WSH: "Мойка и консервация" };
for (const b of diagBlocks) for (const pre of b.codes || []) blockByPrefix[pre] = b.title;
const blockOf = (code) => blockByPrefix[String(code || "").split("-")[0]] || "Прочее";
// То же самое, но id блока (WHL/BRK/...), а не название — для группировки
// запчастей по узлу: у какой работы какие детали предлагать первыми.
const blockIdByPrefix = {};
for (const b of diagBlocks) for (const pre of b.codes || []) blockIdByPrefix[pre] = b.id;
const blockIdOf = (code) => blockIdByPrefix[String(code || "").split("-")[0]] || "";
// Свои неисправности (catalog/repairs) привязаны к узлу напрямую через group
// (id блока), а не через префикс кода — их так по коду не сгруппировать.
const blockTitleById = Object.fromEntries(diagBlocks.map((b) => [b.id, b.title]));

const app = document.getElementById("app");
const money = (n) => `${Number(n || 0).toLocaleString("ru-RU")} ₽`;

// Тост — короткое подтверждение действия (добавил/убрал/сохранил), которое
// не привязано к дереву app и переживает полную перерисовку экрана: сама app
// вычищается на каждый render(), а тост живёт своим элементом на body.
let toastTimer = null;
function toast(text) {
  let node = document.getElementById("toast");
  if (!node) {
    node = document.createElement("div");
    node.id = "toast";
    node.className = "toast";
    document.body.appendChild(node);
  }
  node.textContent = text;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 1600);
}

// Модальная панель снизу экрана — для форм, которые не должны раздувать
// список под собой (усложнения+запчасти у работы и т.п.), как в большинстве
// современных приложений. Живёт на body, а не в дереве app — переживает
// render() экрана позади себя, пока форма открыта. Закрывается тапом по
// фону, крестиком или свайпом вниз по шапке.
function openSheet(title, bodyNode) {
  const backdrop = el("div", { class: "sheet-backdrop", onclick: () => close() });
  const sheet = el("div", { class: "sheet" },
    el("div", { class: "sheet-handle" }),
    el("div", { class: "sheet-header" }, el("h2", {}, title),
      el("button", { style: iconBtnStyle, onclick: () => close() }, "✕")),
    el("div", { class: "sheet-body" }, bodyNode));
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    backdrop.classList.remove("show");
    sheet.classList.remove("show");
    setTimeout(() => { backdrop.remove(); sheet.remove(); }, 220);
  }
  // Свайп вниз по шапке — тот же жест, что закрывает системные bottom sheet.
  let startY = null;
  const handleArea = sheet.firstChild;
  handleArea.addEventListener("touchstart", (e) => { startY = e.touches[0].clientY; }, { passive: true });
  handleArea.addEventListener("touchmove", (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 0) sheet.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  handleArea.addEventListener("touchend", (e) => {
    const dy = (e.changedTouches[0]?.clientY ?? startY) - startY;
    startY = null;
    if (dy > 60) close();
    else sheet.style.transform = "";
  }, { passive: true });
  document.body.append(backdrop, sheet);
  requestAnimationFrame(() => { backdrop.classList.add("show"); sheet.classList.add("show"); });
  return { close };
}

/** Создать элемент: el("div", {class:"card", onclick:fn}, "текст", childNode, [array]) */
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "value") n.value = v;
    else if (k === "checked") n.checked = !!v;
    else if (k === "selected") n.selected = !!v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}
const bar = (title, backHash, rightNode) =>
  el("header", { class: "bar" },
    backHash != null ? el("a", { class: "back", href: "#" + backHash }, "‹") : null,
    el("h1", {}, title),
    rightNode || null);

// ---------------------------- хранилище --------------------------------------
//
//  Данные лежат и в браузере (мгновенный доступ), и на сервере /api/db
//  (общие для всех устройств). При каждой правке пишем локально и отправляем
//  на сервер; при переходе между экранами подтягиваем свежие данные.
//  Если сервер недоступен (нет интернета или не подключена база) — работаем
//  только локально.

const DB_KEY = "vella.db.v1";

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

const migrateOrders = (orders) =>
  (orders || []).map((o) => {
    let next = o;
    if (next.status === "в работе") next = { ...next, status: next.occupiedBy ? "взята в работу" : "принята" };
    if (next.status === "проверка") next = { ...next, status: "готово к выдаче" };
    let items = fixDoneDifficulties(next.items);
    items = fixPartsShape(items);
    if (items !== next.items) next = { ...next, items };
    return next;
  });

const normalizeDB = (d) => ({
  clients: d?.clients || [], bikes: d?.bikes || [], orders: migrateOrders(d?.orders),
  counters: { order: 0, bike: 0, ...(d?.counters || {}) },
});

let DB = normalizeDB(safeParse(localStorage.getItem(DB_KEY)));
let serverOK = false;
let pushTimer = null;
let dirty = false; // есть локальные правки, ещё не подтверждённые сервером
// Мы внутри экрана, отрисованного мимо router() (диагностика, «уточнение
// усложнений», подбор работы, техпроцедура) — хеш при этом не меняется,
// поэтому фоновый adopt() после debounce-пуша не должен звать router():
// он бы молча подменил такой экран обычным видом обращения по тому же хешу.
let inSubScreen = false;
let autoOpenDiagsFor = null; // номер только что созданного обращения — сразу открыть диагностику
let editingItemCode = null; // код работы в наряде, у которой сейчас открыта форма редактирования
let ordersSearch = ""; // архив «Обращения» — поиск по телефону клиента
let ordersGroupBy = "created"; // архив «Обращения» — группировка: "created" | "handed"

// ---------------------------- вход и сессия ---------------------------------
//
//  Куки (HttpOnly) ставит сервер (/api/auth), клиент их не читает — только
//  спрашивает "кто я" через GET и шлёт действия через POST. Без сессии
//  роутер ниже показывает только экран входа/первого запуска.

let SESSION = null; // { login, name, role } | null
let NEEDS_SETUP = false;

async function authAction(body) {
  const r = await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "ошибка");
  return j;
}
async function loadSession() {
  try {
    const r = await fetch("/api/auth", { cache: "no-store" });
    const j = await r.json();
    SESSION = j.authenticated ? j.user : null;
    NEEDS_SETUP = !!j.needsSetup;
  } catch { SESSION = null; }
}
async function logout() {
  try { await authAction({ action: "logout" }); } catch {}
  SESSION = null;
  location.hash = "/";
  router();
}

// Остатки по запчастям — для выбора детали при отметке работы готовой.
let stockCache = null;
async function ensureStock() {
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
let repairsCache = null;
async function ensureRepairs() {
  if (repairsCache) return repairsCache;
  try {
    const r = await fetch("/api/repairs", { cache: "no-store" });
    const j = await r.json();
    repairsCache = r.ok ? j.items || [] : [];
  } catch { repairsCache = []; }
  return repairsCache;
}

function safeParse(s) { try { return JSON.parse(s || "{}"); } catch { return {}; } }
const loadDB = () => DB;
function writeLocal() { localStorage.setItem(DB_KEY, JSON.stringify(DB)); }

function adopt(next) {
  const before = JSON.stringify(DB);
  DB = normalizeDB(next);
  writeLocal();
  if (JSON.stringify(DB) !== before && !inSubScreen && !location.hash.startsWith("#/orders/new")) router();
}

async function syncFromServer() {
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

function pushToServer() {
  if (typeof fetch !== "function") return;
  dirty = true;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const r = await fetch("/api/db", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(DB),
      });
      if (r.ok) { serverOK = true; dirty = false; adopt(await r.json()); }
    } catch { /* оффлайн — данные сохранены локально, отправятся позже */ }
  }, 250);
}

function saveDB(d) { DB = normalizeDB(d); writeLocal(); pushToServer(); }
function editDB(fn) { fn(DB); writeLocal(); pushToServer(); }
function editOrder(number, fn) {
  editDB((d) => { const o = d.orders.find((x) => x.number === number); if (o) fn(o); });
}

// Удаление обращения — отдельным запросом мимо обычного merge-пуша (см.
// api/db.js): слияние только объединяет, само по себе стереть запись на
// сервере не может. При неудаче (офлайн) ничего не трогаем локально, чтобы
// запись не «ожила» после следующей синхронизации.
async function deleteOrderApi(number) {
  try {
    const r = await fetch("/api/db", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ number }) });
    if (!r.ok) return false;
    serverOK = true;
    adopt(await r.json());
    return true;
  } catch { return false; }
}

// Переопределения работ каталога — правит администратор (общие для всех,
// хранятся на сервере), см. /api/overrides. Собраны в объект один раз при
// запуске и обновляются точечно после каждой правки/скрытия.
let OVERRIDES = {};
async function loadOverrides() {
  try {
    const r = await fetch("/api/overrides", { cache: "no-store" });
    const j = await r.json();
    OVERRIDES = r.ok ? j.byCode || {} : {};
  } catch { OVERRIDES = {}; }
}
async function overridesApi(method, body) {
  const r = await fetch("/api/overrides", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert(j.error || "ошибка"); return null; }
  OVERRIDES = j.byCode || {};
  return j;
}
// Цена работы с учётом переопределения администратора поверх дефолта из прайса.
function effectivePrice(code) {
  const base = defaultPrices[code] || { work: 0 };
  const ov = OVERRIDES[code];
  if (!ov) return base;
  return {
    work: ov.price ?? base.work,
    minutes: ov.minutes ?? base.minutes,
    difficulties: ov.complications ?? base.difficulties,
    multiple: ov.multiple ?? base.multiple,
  };
}
const priceOf = effectivePrice;

const yy = () => String(new Date().getFullYear()).slice(2);
const nextOrderNumber = (d) => (d.counters.order++, `V${yy()}-${String(d.counters.order).padStart(6, "0")}`);
// Велосипед привязан к телефону владельца (уникальный ключ клиента); у телефона
// может быть несколько велосипедов. Номер не показываем — только бренд/модель.
const nextBikeKey = (d, phone) => `${phone}#${d.bikes.filter((b) => b.ownerPhone === phone).length + 1}`;

// ---------------------------- расчёт цен ------------------------------------

// qty у работы и у каждого усложнения — сколько раз это сделано (несколько
// колёс, несколько спиц и т.п.); значимо только когда у работы/усложнения
// стоит галочка «несколько», иначе всегда 1 и ни на что не влияет.
const partsCost = (parts) => (parts || []).reduce((s, p) => s + (p.price || 0) * (p.qty || 1), 0);
function itemRange(it) {
  const base = (it.workPrice || 0) * (it.qty || 1) + (it.partsPrice || 0) + partsCost(it.parts);
  let min = base, max = base;
  for (const d of it.difficulties || []) {
    const amt = (d.add || 0) * (d.qty || 1);
    if (d.state === "yes") { min += amt; max += amt; }
    else if (d.state === "unknown") max += amt;
  }
  return { min, max };
}
// Ориентировочное время работы с учётом отмеченных трудностей (будет/неизвестно
// тоже добавляют время, как и цену — на «неизвестно» берём время по максимуму).
function itemMinutes(it) {
  let m = (it.estimateMinutes || 0) * (it.qty || 1);
  for (const d of it.difficulties || []) {
    if (d.state === "yes" || d.state === "unknown") m += (d.addMinutes || 0) * (d.qty || 1);
  }
  return m;
}
const orderRange = (o) =>
  o.items.filter((i) => i.agreed).reduce(
    (a, it) => { const r = itemRange(it); return { min: a.min + r.min, max: a.max + r.max }; },
    { min: 0, max: 0 });
// До согласования ничего ещё не отмечено agreed — считаем по всему списку целиком.
const orderRangeAll = (o) =>
  o.items.reduce((a, it) => { const r = itemRange(it); return { min: a.min + r.min, max: a.max + r.max }; }, { min: 0, max: 0 });
const rangeText = (r) => (r.min === r.max ? money(r.min) : `${money(r.min)} – ${money(r.max)}`);
// Ориентировочное время — не для мастера в интерфейсе наравне с ценой, а тихой строкой для клиента.
const orderMinutes = (o, onlyAgreed) =>
  o.items.filter((i) => !onlyAgreed || i.agreed).reduce((s, it) => s + itemMinutes(it), 0);
function minutesText(m) {
  if (!m) return null;
  const h = Math.floor(m / 60), mm = m % 60;
  return "ориентировочно " + (h ? `${h} ч${mm ? " " + mm + " мин" : ""}` : `${mm} мин`);
}
// Возможная вилка цены операции: от работы без надбавок до работы со всеми трудностями.
function codeRange(code) {
  const p = priceOf(code);
  const base = p.work || 0;
  const max = base + (p.difficulties || []).reduce((s, d) => s + (d.add || 0), 0);
  return { min: base, max };
}
// То же для неисправности, заведённой админом вручную (цена лежит в ней самой).
function customFaultRange(f) {
  const base = f.price || 0;
  const max = base + (f.complications || []).reduce((s, c) => s + (c.add || 0), 0);
  return { min: base, max };
}

function makeItem(code, notes = "") {
  const proc = cat.byCode.get(code);
  const price = priceOf(code);
  return {
    code, name: OVERRIDES[code]?.name || (proc ? proc.name : code), agreed: false, done: false, parts: [], notes,
    workPrice: price.work || 0,
    estimateMinutes: price.minutes || 0,
    partsPrice: 0,
    multiple: !!price.multiple, qty: 1,
    difficulties: (price.difficulties || []).map((d) => ({ label: d.label, add: d.add, addMinutes: d.addMinutes || 0, multiple: !!d.multiple, qty: 1, state: "unknown" })),
  };
}

// Неисправность, заведённая администратором вручную (без кода .proc-процедуры) —
// цена/время/усложнения лежат прямо в ней самой.
function makeCustomItem(fa, notes = "") {
  return {
    code: fa.code, name: fa.label, agreed: false, done: false, parts: [], notes,
    workPrice: fa.price || 0,
    estimateMinutes: fa.minutes || 0,
    partsPrice: 0,
    multiple: !!fa.multiple, qty: 1,
    difficulties: (fa.complications || []).map((c) => ({ label: c.label, add: c.add, addMinutes: c.addMinutes || 0, multiple: !!c.multiple, qty: 1, state: "unknown" })),
  };
}

const billableOps = cat.procedures.filter(
  (p) => p.code && p.kind === "operation" && !["DIA-01", "DIA-01R"].includes(p.code));

const BIKE_KINDS = ["шоссе", "гревел", "хардтейл", "двухподвес", "детский", "колесо", "любой другой"];
// Для одного колеса (без остального велосипеда) имеют смысл только работы по колёсам/втулкам.
const WHEEL_ONLY_BLOCKS = ["WHL", "HUB"];
// Марка и модель — одно поле в форме; model может быть пустым (старые записи хранят раздельно).
const bikeLabel = (b) => (b ? [b.brand, b.model].filter(Boolean).join(" ") : "");
// Российский номер: 10 цифр без кода страны, либо 11 с ведущей 7/8.
function isValidPhone(s) {
  const d = (s || "").replace(/\D/g, "");
  return d.length === 10 || (d.length === 11 && (d[0] === "7" || d[0] === "8"));
}
// 10 цифр номера без кода страны — общий вид для сравнения телефонов, не
// зависящий от того, как они введены/отформатированы (+7, 8, пробелы, тире).
// Так "+7 996 606 12 00" и "+79966061200" (и старые записи вроде "8 996...")
// считаются одним и тем же номером.
function phoneDigits(s) {
  let d = (s || "").replace(/\D/g, "");
  if (d.length === 11 && (d[0] === "7" || d[0] === "8")) d = d.slice(1);
  return d;
}
function findClientByPhone(clients, phone) {
  const digits = phoneDigits(phone);
  return digits.length === 10 ? clients.find((c) => phoneDigits(c.phone) === digits) || null : null;
}
// Маска номера: всегда +7, дальше цифры группами 3-3-2-2 — «+7 996 606 12 00».
function applyPhoneMask(raw) {
  let d = (raw || "").replace(/\D/g, "");
  if (d[0] === "7" || d[0] === "8") d = d.slice(1);
  d = d.slice(0, 10);
  let value = "+7";
  if (d.length) value += " " + d.slice(0, 3);
  if (d.length > 3) value += " " + d.slice(3, 6);
  if (d.length > 6) value += " " + d.slice(6, 8);
  if (d.length > 8) value += " " + d.slice(8, 10);
  return value;
}
// Цифры, уже введённые в поле с applyPhoneMask (сколько бы их ни было —
// хоть одна) — не путать с phoneDigits(): та по длине гадает, есть ли код
// страны, что ломается на неполном номере («+7 996» — это код страны и 3
// цифры, а не 4 цифры номера). Тут код страны всегда есть по построению
// маски, потому просто отбрасываем первую «7».
const maskedDigits = (value) => (value || "").replace(/\D/g, "").replace(/^7/, "");

// Привязывает маску к текстовому полю: реформатирует значение по мере ввода
// и сохраняет позицию курсора относительно уже введённых цифр (не просто
// прыгает в конец, чтобы можно было спокойно поправить середину номера).
function attachPhoneMask(input, onChange) {
  input.addEventListener("input", () => {
    const before = input.value;
    const caret = input.selectionStart ?? before.length;
    const digitsBeforeCaret = before.slice(0, caret).replace(/\D/g, "").length;
    const value = applyPhoneMask(before);
    input.value = value;
    let seen = 0, pos = value.length;
    for (let i = 0; i < value.length; i++) {
      if (/\d/.test(value[i]) && ++seen === digitsBeforeCaret) { pos = i + 1; break; }
    }
    if (digitsBeforeCaret === 0) pos = 2; // сразу после «+7»
    input.setSelectionRange(pos, pos);
    onChange(value);
  });
}

// Список работ для «+ работа»: обычные операции из каталога + неисправности,
// заведённые админом вручную (catalog/repairs). Общий и для наряда, и для
// диагностики при оформлении нового обращения.
async function loadWorkPool(bikeKind) {
  const repairs = await ensureRepairs();
  const custom = repairs.map((r) => ({
    code: `CF-${r.id}`, name: r.label, label: r.label, custom: true, id: r.id, group: r.group,
    price: r.price, minutes: r.minutes, complications: r.complications, multiple: r.multiple,
  }));
  return [
    ...billableOps
      .filter((p) => !OVERRIDES[p.code]?.hidden)
      .filter((p) => bikeKind !== "колесо" || WHEEL_ONLY_BLOCKS.includes(p.code.split("-")[0]))
      .map((p) => ({ code: p.code, name: OVERRIDES[p.code]?.name || p.name, custom: false })),
    ...custom,
  ];
}

// onPick получает объект {code, name, custom, ...} — обычную операцию из
// каталога или неисправность, заведённую админом вручную.
function openWorkPicker({ existingItems, bikeKind, onBack, onPick }) {
  const header = () => el("header", { class: "bar" },
    el("button", { class: "back", style: "border:0;background:none", onclick: onBack }, "‹"),
    el("h1", {}, "Добавить работу"));
  render([header(), el("main", { class: "wrap" }, skeletonRows())]);
  // Группировка — как на диагностике: по узлу велосипеда, в том же порядке
  // (BLOCK_TITLES), «Прочее» последним. У своих неисправностей узел — group
  // (id блока), у обычных операций каталога — по префиксу кода (blockOf).
  const blockTitleOf = (p) => (p.group ? blockTitleById[p.group] || "Прочее" : blockOf(p.code));
  loadWorkPool(bikeKind).then((pool) => {
    const host = el("main", { class: "wrap" });
    const q = el("input", { type: "text", placeholder: "поиск по коду или названию" });
    const listBox = el("div", { style: "margin-top:10px" });
    const draw = () => {
      const ql = q.value.trim().toLowerCase();
      const rows = pool
        .filter((p) => !existingItems.some((i) => i.code === p.code))
        .filter((p) => !ql || p.code.toLowerCase().includes(ql) || p.name.toLowerCase().includes(ql));
      if (!rows.length) {
        listBox.replaceChildren(emptyState("Ничего не найдено.", EMPTY_ICON_SEARCH));
        return;
      }
      const groups = groupBy(rows, blockTitleOf);
      const sections = [...BLOCK_TITLES, "Прочее"]
        .filter((title) => groups.get(title)?.length)
        .map((title) => el("div", { style: "margin-top:14px" },
          el("p", { class: "small muted", style: "margin:0 0 4px;letter-spacing:.05em" }, title.toUpperCase()),
          rowsList(groups.get(title).map((p) => el("button", { class: "row", onclick: () => onPick(p) },
            el("span", { style: "flex:1" }, p.name), el("span", { class: "chev" }, "+"))))));
      listBox.replaceChildren(...sections);
    };
    q.addEventListener("input", draw);
    host.append(q, listBox);
    draw();
    render([header(), host]);
  });
}

const STATUS_TAG_CLASS = {
  "приём": "tag-new", "оценка": "tag-quote", "согласование": "tag-approve",
  "принята": "tag-new", "взята в работу": "tag-progress", "готово к выдаче": "tag-check", "выдан": "tag-done",
};
const statusTag = (status) => el("span", { class: "tag " + (STATUS_TAG_CLASS[status] || "") }, status);

// Реальный путь обращения — четыре стадии одной операции (легаси приём/
// оценка/согласование сюда не входят, там прогресс не показываем). Пройденные
// стадии кликабельны — можно вернуться назад, если мастер ошибся; будущие
// нет — двигаться вперёд можно только кнопками на самой стадии.
const ORDER_STAGES = [
  { key: "принята", label: "Принята" },
  { key: "взята в работу", label: "В работе" },
  { key: "готово к выдаче", label: "Готово к выдаче" },
  { key: "выдан", label: "Выдано" },
];
function orderProgressBar(status, onJump) {
  const idx = ORDER_STAGES.findIndex((s) => s.key === status);
  if (idx === -1) return null;
  const out = [];
  ORDER_STAGES.forEach((s, i) => {
    if (i) out.push(el("span", { class: "pstep-sep" }, "›"));
    const state = i < idx ? "done" : i === idx ? "current" : "future";
    out.push(el("span", {
      class: `pstep pstep-${state}`,
      onclick: state === "done" ? () => onJump(s.key) : null,
    }, s.label));
  });
  return el("div", { class: "progress-steps" }, out);
}

// ============================================================================
//  РОУТЕР
// ============================================================================

function adminOnly(fn) {
  return (m) => SESSION?.role === "admin" ? fn(m) : [
    bar("Нет доступа", "/"),
    el("main", { class: "wrap" }, el("p", { class: "muted" }, "Этот раздел только для администратора.")),
  ];
}
const routes = [
  [/^\/?$/, viewHome],
  [/^\/orders\/new$/, viewNewOrder],
  [/^\/orders\/([^/]+)$/, (m) => viewOrder(m[1])],
  [/^\/orders$/, viewOrders],
  [/^\/profile$/, viewProfile],
  [/^\/admin$/, adminOnly(viewAdmin)],
  [/^\/admin\/masters$/, adminOnly(viewMasters)],
  [/^\/admin\/stock$/, adminOnly(viewStock)],
  [/^\/admin\/overrides$/, adminOnly(viewOverrides)],
];
function router() {
  inSubScreen = false; // хеш-навигация всегда уводит из любого экрана мимо router()
  if (!SESSION) return render(NEEDS_SETUP ? viewSetup() : viewLogin());
  const path = location.hash.replace(/^#/, "") || "/";
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) return render(fn(m));
  }
  render(viewHome());
}
const go = (hash) => { location.hash = hash; };
// keepScroll — для точечных обновлений текущего экрана (галочка, чекбокс,
// правка поля): не дёргать страницу вверх при каждом клике. Без него — как
// при обычном переходе на новый экран, скролл сбрасывается в начало.
function render(nodes, { keepScroll } = {}) {
  const y = window.scrollY;
  app.replaceChildren(...(Array.isArray(nodes) ? nodes.filter(Boolean) : [nodes]));
  window.scrollTo(0, keepScroll ? y : 0);
}
window.addEventListener("hashchange", () => { router(); if (SESSION) syncFromServer(); });

// Потянуть вниз от самого верха экрана — принудительно подтянуть свежие
// данные с сервера (заявку мог тем временем поменять другой мастер).
// Работает где угодно в приложении, отдельного подключения на экран не надо.
(function setupPullToRefresh() {
  const indicator = el("div", { class: "ptr-indicator" }, el("span", { class: "ptr-icon" }, "↓"));
  document.body.appendChild(indicator);
  const setY = (px) => { indicator.style.transform = `translateX(-50%) translateY(${px}px)`; };
  const THRESHOLD = 70;
  let startY = null, pulling = false, ready = false, refreshing = false;
  window.addEventListener("touchstart", (e) => {
    if (window.scrollY > 0 || refreshing || !SESSION) { startY = null; pulling = false; return; }
    startY = e.touches[0].clientY;
    pulling = true;
  }, { passive: true });
  window.addEventListener("touchmove", (e) => {
    if (!pulling || startY == null) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { indicator.style.transform = ""; ready = false; return; }
    const pull = Math.min(dy * 0.5, 90);
    setY(pull - 60);
    ready = pull > THRESHOLD * 0.6;
    indicator.classList.toggle("ptr-ready", ready);
  }, { passive: true });
  window.addEventListener("touchend", async () => {
    if (!pulling) return;
    pulling = false;
    if (!ready) { indicator.style.transform = ""; return; }
    ready = false;
    indicator.classList.remove("ptr-ready");
    refreshing = true;
    indicator.classList.add("ptr-spin");
    setY(24);
    await syncFromServer();
    indicator.classList.remove("ptr-spin");
    indicator.style.transform = "";
    refreshing = false;
    toast("Обновлено");
  }, { passive: true });
})();

(async () => {
  await loadSession();
  if (SESSION) await loadOverrides();
  router();
  if (SESSION) syncFromServer();
})();

// ============================================================================
//  ЭКРАНЫ
// ============================================================================

const ICON_SVG = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  prices: ICON_SVG('<path d="M12.6 3H6a2 2 0 0 0-2 2v6.6a2 2 0 0 0 .6 1.4l8.4 8.4a2 2 0 0 0 2.8 0l5.6-5.6a2 2 0 0 0 0-2.8L13 3.6a2 2 0 0 0-1.4-.6Z"/><circle cx="8.5" cy="8.5" r="1.3"/>'),
  admin: ICON_SVG('<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z"/>'),
  profile: ICON_SVG('<circle cx="12" cy="9" r="3"/><path d="M6 19c1.2-3 3.6-4.5 6-4.5s4.8 1.5 6 4.5"/>'),
  masters: ICON_SVG('<circle cx="9" cy="8" r="2.5"/><path d="M4 19c.8-2.6 2.6-4 5-4s4.2 1.4 5 4"/><circle cx="17" cy="9" r="2"/><path d="M15.5 12c1.9.4 3 1.6 3.5 3.2"/>'),
  stock: ICON_SVG('<path d="M3.5 7.5 12 3l8.5 4.5V16L12 20.5 3.5 16V7.5Z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v8.5"/>'),
};
const EMPTY_ICON_BOX = ICON_SVG('<path d="M3.5 7.5 12 3l8.5 4.5V16L12 20.5 3.5 16V7.5Z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v8.5"/>');
const EMPTY_ICON_SEARCH = ICON_SVG('<circle cx="10" cy="10" r="6"/><path d="M20 20l-4.35-4.35"/>');
// Пустое состояние — иконка + текст вместо голой строки, чуть меньше «сыро».
function emptyState(text, icon) {
  return el("div", { class: "empty-state" },
    el("span", { class: "empty-state-icon", html: icon || EMPTY_ICON_BOX }),
    el("p", { class: "muted small" }, text));
}

// Заглушка-силуэт на время подгрузки (остатки, каталог и т.п.) вместо
// голого текста «Загрузка…» — меньше ощущается пауза.
function skeletonRows(n = 3) {
  return el("div", { class: "skeleton" }, Array.from({ length: n }, () => el("div", { class: "skeleton-row" })));
}

function homeLink(text, hash, icon) {
  return el("a", { class: "row", href: "#" + hash },
    icon ? el("span", { class: "row-icon", html: icon }) : null,
    el("span", { style: "flex:1" }, text), el("span", { class: "chev" }, "›"));
}

// Свайп влево на строке списка открывает красную кнопку «Удалить» под ней —
// как в Почте/Напоминаниях. Открыта всегда только одна строка: свайп другой
// строки или тап вне списка закрывают предыдущую. onDelete — async, должен
// вернуть false при неудаче (тогда строка возвращается в закрытое состояние
// и кнопку можно нажать ещё раз).
let openSwipeClose = null;
function closeOpenSwipe() { const c = openSwipeClose; openSwipeClose = null; if (c) c(); }
document.addEventListener("pointerdown", (e) => {
  if (openSwipeClose && !e.target.closest(".swipe-row")) closeOpenSwipe();
}, true);

function swipeToDelete(rowNode, onDelete, label = "Удалить") {
  const ACTION_W = 88;
  const wrap = el("div", { class: "swipe-row" });
  const action = el("button", { class: "swipe-action" }, label);
  rowNode.classList.add("swipe-content");
  rowNode.setAttribute("draggable", "false"); // иначе браузер начинает нативный drag ссылки вместо свайпа
  wrap.append(action, rowNode);

  let x = 0, dragging = false, locked = null, moved = false, startX = 0, startY = 0, fromX = 0, pid = null;
  const apply = (animate) => {
    rowNode.style.transition = animate ? "transform .22s cubic-bezier(.2,.8,.2,1)" : "none";
    rowNode.style.transform = x ? `translateX(${x}px)` : "";
  };
  const close = (animate = true) => { x = 0; apply(animate); };
  const openFull = (animate = true) => { x = -ACTION_W; apply(animate); openSwipeClose = close; };

  action.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    action.disabled = true; action.textContent = "…";
    const ok = await onDelete();
    if (ok === false) { action.disabled = false; action.textContent = label; close(); if (openSwipeClose === close) openSwipeClose = null; }
  };

  rowNode.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (openSwipeClose && openSwipeClose !== close) closeOpenSwipe();
    dragging = true; locked = null; moved = false; pid = e.pointerId;
    startX = e.clientX; startY = e.clientY; fromX = x;
  });
  rowNode.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerId !== pid) return;
    const ddx = e.clientX - startX, ddy = e.clientY - startY;
    if (locked === null) {
      if (Math.abs(ddx) < 6 && Math.abs(ddy) < 6) return;
      locked = Math.abs(ddx) > Math.abs(ddy) ? "x" : "y";
      if (locked === "x") rowNode.setPointerCapture(pid);
    }
    if (locked !== "x") return;
    moved = true;
    x = Math.max(-ACTION_W - 16, Math.min(0, fromX + ddx));
    apply(false);
  });
  const finish = (e) => {
    if (!dragging || (e && e.pointerId !== pid)) return;
    dragging = false;
    if (locked === "x") {
      if (x < -ACTION_W / 2) openFull();
      else { close(); if (openSwipeClose === close) openSwipeClose = null; }
    }
  };
  rowNode.addEventListener("pointerup", finish);
  rowNode.addEventListener("pointercancel", finish);
  rowNode.addEventListener("click", (e) => {
    if (moved) { e.preventDefault(); return; }
    if (x !== 0) { e.preventDefault(); close(); if (openSwipeClose === close) openSwipeClose = null; }
  });

  return wrap;
}

// .rows полагается на CSS :last-child, чтобы убрать разделитель у последней
// строки — когда строки обёрнуты в .swipe-row, эта связь рвётся (последняя
// .row больше не последний ребёнок .rows). Снимаем разделитель явно.
function rowsList(nodes) {
  if (nodes.length) {
    const last = nodes[nodes.length - 1];
    const rowEl = last.matches?.(".row") ? last : last.querySelector?.(".row");
    if (rowEl) rowEl.style.borderBottom = "0";
  }
  return el("div", { class: "rows" }, nodes);
}

function formatDateShort(iso) {
  return iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) : null;
}
function formatDateGroup(iso) {
  return iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" }) : "Без даты";
}

// Строка обращения в списке — код, велосипед/клиент, статус. Общая для
// главного экрана (активные) и архива выданных. onDelete, если передан,
// включает свайп-удаление строки. dateIso, если передан (createdAt или
// handedOverAt архива), показывается рядом с именем клиента.
function orderRow(o, d, onDelete, dateIso) {
  const bike = d.bikes.find((b) => b.number === o.bikeNumber);
  const client = d.clients.find((c) => c.phone === o.clientPhone);
  // Готово к выдаче больше двух суток и клиент всё ещё не забрал — отмечаем
  // полоской сбоку, чтобы такие заявки сразу бросались в глаза в списке.
  const overdue = o.status === "готово к выдаче" && o.finishedAt
    && Date.now() - new Date(o.finishedAt).getTime() > 48 * 3600 * 1000;
  const row = el("a", { class: "row" + (overdue ? " row-overdue" : ""), href: `#/orders/${o.number}` },
    el("span", { class: "code" }, o.number),
    el("span", { style: "flex:1;min-width:0" }, bike ? bikeLabel(bike) : o.bikeNumber,
      el("br"), el("span", { class: "small muted" }, client?.name || o.clientPhone),
      // Занятость мастером — теперь сама по себе статус («взята в работу»),
      // тут только его имя.
      o.occupiedByName ? el("span", { class: "small muted" }, " · мастер: " + o.occupiedByName) : null,
      dateIso ? el("span", { class: "small muted" }, " · " + formatDateShort(dateIso)) : null),
    statusTag(o.status));
  return onDelete ? swipeToDelete(row, () => onDelete(o)) : row;
}

async function deleteOrderWithAlert(o) {
  const ok = await deleteOrderApi(o.number);
  if (!ok) alert("Не удалось удалить — нет соединения. Попробуйте ещё раз, когда будет интернет.");
  return ok;
}

// Главный экран сразу показывает активные обращения (всё, кроме выданных) —
// не нужно лишний раз заходить в «Обращения», чтобы увидеть, что в работе.
// Кнопка добавления — внизу, всегда на виду и одного размера (как везде в
// приложении), архив выданных — по ссылке отдельно.
function viewHome() {
  const d = loadDB();
  const active = [...d.orders].reverse().filter((o) => o.status !== "выдан");
  return [
    el("header", { class: "bar" }, el("h1", {}, "Vella"),
      el("a", { class: "sub", href: "#/profile" }, SESSION?.name || SESSION?.login || "")),
    el("main", { class: "wrap" },
      el("h2", { class: "small muted", style: "margin:0 0 8px;font-weight:600;letter-spacing:.02em" }, "АКТИВНЫЕ ОБРАЩЕНИЯ"),
      active.length === 0
        ? emptyState("Активных обращений нет.")
        : rowsList(active.map((o) => orderRow(o, d, deleteOrderWithAlert))),
      el("a", { href: "#/orders", class: "small", style: "display:inline-block;margin-top:4px" }, "Архив выданных обращений ›"),
      el("p", { class: "muted small", style: "margin-top:16px" },
        (serverOK ? "Данные общие для всех устройств." : "Данные хранятся только в этом браузере.")
          + (BUILD_TIME ? ` · версия от ${BUILD_TIME}` : ""))),
    el("div", { class: "actions" }, el("div", { class: "actions-inner" },
      el("button", { class: "btn-primary", onclick: () => go("/orders/new") }, "+ Новое обращение"))),
  ];
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}


// Пресет для быстрой проверки: создаёт готовое обращение одним кликом.
const DEMO_PRESET = {
  phone: applyPhoneMask("9000000000"), name: "Тест Тестов", kind: "шоссе",
  brand: "Canyon", model: "Endurace",
  request: "переключается плохо, щёлкает сзади; готовлю к сезону",
};
function createDemoOrder() {
  const p = DEMO_PRESET.phone;
  let number = "";
  editDB((d) => {
    if (!d.clients.some((c) => c.phone === p)) d.clients.push({ phone: p, name: DEMO_PRESET.name, consentToCall: true });
    let bn = d.bikes.find((b) => b.ownerPhone === p && b.brand === DEMO_PRESET.brand && b.model === DEMO_PRESET.model)?.number;
    if (!bn) {
      bn = nextBikeKey(d, p);
      d.bikes.push({ number: bn, kind: DEMO_PRESET.kind, brand: DEMO_PRESET.brand, model: DEMO_PRESET.model, ownerPhone: p });
    }
    number = nextOrderNumber(d);
    d.orders.push({ number, clientPhone: p, bikeNumber: bn, request: DEMO_PRESET.request, diagnosticNotes: [], status: "приём", items: [], createdAt: new Date().toISOString() });
  });
  autoOpenDiagsFor = number;
  go("/orders/" + number);
}

// Архив — только выданные (активные уже на главном экране). Поиск по
// телефону и группировка по дате создания/выдачи живут тут же, с
// перерисовкой только списка (не всего экрана), чтобы не терять фокус
// в поле поиска на каждую нажатую клавишу — как в openWorkPicker.
function viewOrders() {
  const d = loadDB();
  const q = el("input", { type: "tel", value: applyPhoneMask(ordersSearch) });
  attachPhoneMask(q, (v) => { ordersSearch = v; drawList(); });
  const seg = el("div", { class: "segmented", style: "margin-top:10px" });
  const listBox = el("div", { style: "margin-top:16px" });

  const setGroupBy = (v) => { ordersGroupBy = v; drawSeg(); drawList(); };
  const drawSeg = () => {
    seg.replaceChildren(
      el("button", { class: ordersGroupBy === "created" ? "active" : "", onclick: () => setGroupBy("created") }, "По дате создания"),
      el("button", { class: ordersGroupBy === "handed" ? "active" : "", onclick: () => setGroupBy("handed") }, "По дате выдачи"));
  };
  const drawList = () => {
    const qDigits = maskedDigits(ordersSearch);
    let issued = d.orders.filter((o) => o.status === "выдан");
    if (qDigits) issued = issued.filter((o) => phoneDigits(o.clientPhone).includes(qDigits));
    const field = ordersGroupBy === "handed" ? "handedOverAt" : "createdAt";
    issued = [...issued].sort((a, b) => (b[field] || "").localeCompare(a[field] || ""));
    const groups = [];
    for (const o of issued) {
      const label = formatDateGroup(o[field]);
      let g = groups[groups.length - 1];
      if (!g || g.label !== label) { g = { label, list: [] }; groups.push(g); }
      g.list.push(o);
    }
    listBox.replaceChildren(
      ...[
        issued.length === 0
          ? emptyState(qDigits ? "Ничего не найдено." : "Пока нет выданных обращений.", qDigits ? EMPTY_ICON_SEARCH : EMPTY_ICON_BOX)
          : null,
        ...groups.map((g) => el("div", { style: "margin-bottom:16px" },
          el("p", { class: "small muted", style: "margin:0 0 4px;letter-spacing:.02em" }, g.label.toUpperCase()),
          rowsList(g.list.map((o) => orderRow(o, d, deleteOrderWithAlert, o[field]))))),
      ].filter(Boolean),
    );
  };
  drawSeg();
  drawList();

  return [
    bar("Архив", "/", el("span", { class: "sub", style: "display:flex;gap:14px" },
      el("button", { style: "border:0;background:none;color:inherit;font:inherit;cursor:pointer;padding:0", onclick: createDemoOrder }, "+ демо"),
      el("a", { href: "#/orders/new", style: "color:inherit" }, "+ новое"))),
    el("main", { class: "wrap" },
      el("label", { class: "small muted" }, "Поиск по телефону клиента"), q, seg, listBox),
  ];
}

// Новое обращение идёт по шагам: диагностика (отмечаем работы) → оценка
// усложнений → согласование (что делаем, сумма по деньгам и времени) →
// и только в конце — данные клиента, телефон, марка/модель велосипеда.
// Пока идут первые три шага, обращения ещё нет в базе — всё копится в
// черновике и уходит одним куском при оформлении на последнем шаге.
function viewNewOrder() {
  const draft = { items: [], diagnosticNotes: [], request: "" };
  const host = el("div", {});

  function stepDiagnostics() {
    render([bar("Новое обращение", "/"), host]);
    mountDiagnostics(host, {
      getItems: () => draft.items,
      onCheck: (fa) => {
        if (!draft.items.some((i) => i.code === fa.code)) draft.items.push(fa.custom ? makeCustomItem(fa) : makeItem(fa.code));
      },
      onUncheck: (fa) => {
        const idx = draft.items.findIndex((i) => i.code === fa.code);
        if (idx !== -1) draft.items.splice(idx, 1);
      },
      onEditItem: (code, patch) => {
        const x = draft.items.find((i) => i.code === code);
        if (x) Object.assign(x, patch);
      },
      onDone: (notes) => { draft.diagnosticNotes.push(...notes); stepAssess(); },
      request: draft.request,
      onRequest: (v) => (draft.request = v),
    });
  }

  // Оценка усложнений и согласование — по сути один и тот же экран, что и
  // «в работе»: список работ, у каждой можно развернуть усложнения (тут ещё
  // прогноз — будет/не будет/неизвестно) и запчасти в счёт, плюс отметить
  // согласовано или нет. Единственная разница — тут ещё нет клиента и
  // велосипеда, так что шапка с ними не показывается.
  function stepAssess() {
    let stock = stockCache || [];
    const redraw = () => render(build(), { keepScroll: true });
    if (!stockCache) ensureStock().then((s) => { stock = s; redraw(); });
    function build() {
      const body = el("div", {});
      if (draft.items.length === 0) body.append(emptyState("Работ пока нет."));
      draft.items.forEach((it) => {
        const row = el("div", { class: "assess" });
        const nameRow = el("div", {
          style: "display:flex;align-items:center;gap:8px;cursor:pointer",
          onclick: () => openAssessSheet(it, stock, redraw),
        },
          el("input", {
            type: "checkbox", class: "chk", checked: it.agreed,
            onclick: (e) => e.stopPropagation(),
            onchange: (e) => { it.agreed = e.target.checked; redraw(); },
          }),
          el("b", { style: "flex:1;min-width:0" }, it.name, it.multiple && (it.qty || 1) > 1 ? el("span", { class: "small muted" }, ` × ${it.qty}`) : null),
          el("span", { style: "flex:0 0 auto;color:var(--line);font-size:19px" }, "›"),
          el("button", {
            style: iconBtnStyle,
            onclick: (e) => { e.stopPropagation(); draft.items = draft.items.filter((x) => x.code !== it.code); redraw(); },
          }, "✕"));
        row.append(nameRow, el("div", { class: "price-tag", style: "margin-top:2px" }, rangeText(itemRange(it))));
        body.append(row);
      });
      body.append(
        el("button", { onclick: () => stepDiagnostics() }, "+ доп. работа"),
        el("div", { class: "card", style: "background:var(--bg)" },
          el("span", { class: "muted small" }, "Согласовано на"),
          el("div", { class: "price-range" }, rangeText(orderRange({ items: draft.items }))),
          minutesText(orderMinutes({ items: draft.items }, true)) ? el("div", { class: "small muted", style: "margin-top:4px" }, minutesText(orderMinutes({ items: draft.items }, true))) : null),
        el("button", { class: "btn-primary", style: "width:100%;margin-top:12px", onclick: () => stepClient() }, "Дальше — данные клиента"));
      return [bar("Новое обращение", "/"), el("main", { class: "wrap" }, stage("Оценка усложнений и стоимости", body))];
    }
    redraw();
  }

  function stepClient() {
    const f = { phone: applyPhoneMask(""), name: "", bike: "new", brand: "" };

    const clientSlot = el("div", {});
    const bikeSlot = el("div", { class: "card" }, el("h2", {}, "Велосипед"));
    const bikeFields = el("div", {});

    function drawClient() {
      const ec = findClientByPhone(loadDB().clients, f.phone);
      clientSlot.replaceChildren(
        ec
          ? el("p", { class: "small muted" }, "Найден: " + (ec.name || ec.phone))
          : el("div", {},
              el("label", {}, "Имя"),
              el("input", { type: "text", value: f.name, oninput: (e) => (f.name = e.target.value) })),
      );
      drawBike();
    }

    function drawBike() {
      const ec = findClientByPhone(loadDB().clients, f.phone);
      const owned = ec ? loadDB().bikes.filter((b) => b.ownerPhone === ec.phone) : [];
      if (!owned.some((b) => b.number === f.bike)) f.bike = "new";
      bikeSlot.replaceChildren(el("h2", {}, "Велосипед"));
      for (const b of owned) {
        bikeSlot.append(el("label", { class: "opt" },
          el("input", { type: "radio", name: "bike", checked: f.bike === b.number, onchange: () => { f.bike = b.number; drawBike(); } }),
          el("span", {}, bikeLabel(b) || "велосипед")));
      }
      if (owned.length)
        bikeSlot.append(el("label", { class: "opt" },
          el("input", { type: "radio", name: "bike", checked: f.bike === "new", onchange: () => { f.bike = "new"; drawBike(); } }),
          el("span", {}, "Новый велосипед")));
      bikeFields.replaceChildren();
      if (f.bike === "new")
        bikeFields.append(
          el("label", {}, "Марка и модель"),
          el("input", { type: "text", value: f.brand, oninput: (e) => (f.brand = e.target.value) }));
      bikeSlot.append(bikeFields);
    }

    const phoneInput = el("input", { type: "tel", value: f.phone });
    attachPhoneMask(phoneInput, (v) => { f.phone = v; drawClient(); });

    const wrap = el("main", { class: "wrap" },
      draft.items.length ? el("p", { class: "small muted" }, `Согласовано работ: ${draft.items.filter((i) => i.agreed).length} из ${draft.items.length}.`) : null,
      el("div", { class: "card" }, el("h2", {}, "Клиент"),
        el("label", {}, "Телефон"),
        phoneInput,
        clientSlot),
      bikeSlot);
    drawClient();

    render([
      bar("Новое обращение", "/"),
      wrap,
      el("div", { class: "actions" }, el("div", { class: "actions-inner" },
        el("button", { class: "btn-primary", onclick: () => {
          if (!isValidPhone(f.phone)) return alert("Проверьте номер телефона");
          editDB((d) => {
            // Клиент уже мог быть заведён с другим форматированием номера —
            // сравниваем по цифрам и, если нашли, используем именно его
            // сохранённый phone как ключ, чтобы не завести дубликат.
            const existing = findClientByPhone(d.clients, f.phone);
            const p = existing ? existing.phone : f.phone;
            if (!existing) d.clients.push({ phone: p, name: f.name.trim() });
            let bn = f.bike;
            if (bn === "new" || !d.bikes.some((b) => b.number === bn)) {
              bn = nextBikeKey(d, p);
              d.bikes.push({ number: bn, brand: f.brand.trim(), model: "", ownerPhone: p });
            }
            const number = nextOrderNumber(d);
            d.orders.push({
              number, clientPhone: p, bikeNumber: bn, request: draft.request, diagnosticNotes: draft.diagnosticNotes,
              status: "принята", items: draft.items, createdAt: new Date().toISOString(),
            });
          });
          go("/");
        } }, "Оформить обращение"))),
    ]);
  }

  stepDiagnostics();
  return [bar("Новое обращение", "/"), host];
}

// ============================================================================
//  ЭКРАН ОБРАЩЕНИЯ — стадии
// ============================================================================

function viewOrder(number) {
  // Сюда возвращаются и через router() (уже сбросил флаг), и напрямую через
  // refresh() из под-экранов (диагностика и т.п.) — сбрасываем и тут, иначе
  // после refresh() флаг остаётся true и фоновые обновления больше никогда
  // не подхватятся автоматически.
  inSubScreen = false;
  const d = loadDB();
  const order = d.orders.find((o) => o.number === number);
  if (!order) return [bar(number, "/"), el("main", { class: "wrap" }, el("p", { class: "muted" }, "Не найдено"))];
  const bike = d.bikes.find((b) => b.number === order.bikeNumber);
  const client = d.clients.find((c) => c.phone === order.clientPhone);
  // keepScroll: мелкая правка (чекбокс, будет/не будет/неизвестно, ✎/✕ у работы)
  // не должна дёргать страницу вверх — только переход между стадиями наряда.
  const refresh = () => render(viewOrder(number), { keepScroll: true });

  function addItem(fa, notes = "") {
    editOrder(number, (o) => {
      const ex = o.items.find((i) => i.code === fa.code);
      if (ex) { if (notes) ex.notes = ex.notes ? `${ex.notes}; ${notes}` : notes; return; }
      o.items.push(fa.custom ? makeCustomItem(fa, notes) : makeItem(fa.code, notes));
    });
  }
  // Тихие версии (без refresh()) — для использования внутри диагностики, где
  // список работ живой и перерисовывается самой диагностикой (draw()), а не
  // всем экраном обращения.
  function removeItemQuiet(code) { editOrder(number, (o) => { o.items = o.items.filter((i) => i.code !== code); }); }
  function editItemQuiet(code, patch) { editOrder(number, (o) => { const x = o.items.find((i) => i.code === code); if (x) Object.assign(x, patch); }); }
  function removeItem(code) {
    removeItemQuiet(code);
    if (editingItemCode === code) editingItemCode = null;
    refresh();
    toast("Работа убрана из наряда");
  }
  function saveItemEdit(code, patch) {
    editItemQuiet(code, patch);
    editingItemCode = null;
    refresh();
  }
  // Работа, добавленная после исходного согласования (доп. работа в ремонте,
  // находка на повторной диагностике), ждёт явного подтверждения мастером —
  // см. pendingAgreementCard.
  const pendingHandlers = {
    onAgree: (code) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === code); if (x) x.agreed = true; }); refresh(); toast("Согласовано"); },
    onRemove: (code) => { editOrder(number, (o) => { o.items = o.items.filter((i) => i.code !== code); }); refresh(); },
    onSet: (code, di, st) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === code); if (x?.difficulties?.[di]) x.difficulties[di].state = st; }); refresh(); },
    onDiffQty: (code, di, qty) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === code); if (x?.difficulties?.[di]) x.difficulties[di].qty = qty; }); refresh(); },
    onParts: (code, parts) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === code); if (x) x.parts = parts; }); refresh(); },
    onQty: (code, qty) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === code); if (x) x.qty = qty; }); refresh(); },
    refresh,
  };
  // «Ждёт согласования» на стадиях без уже загруженных остатков (готово к
  // выдаче/выдан) — подгружаем отдельно, тем же кэшем, что и в ремонте.
  function pendingCardHost() {
    const host = el("div", {});
    (async () => {
      const card = pendingAgreementCard(order, pendingHandlers, await ensureStock());
      host.replaceChildren(...(card ? [card] : []));
    })();
    return host;
  }

  // -- запуск диагностики / процедуры внутри обращения --
  function subBar(code) {
    return el("header", { class: "bar" },
      el("button", { class: "back", style: "border:0;background:none", onclick: refresh }, "‹"),
      el("h1", {}, order.number), el("span", { class: "sub" }, code));
  }
  // Новая работа, добавленная тут (не из исходной сметы), попадает в наряд
  // как agreed:false — уточнить усложнения/запчасти и согласовать можно
  // прямо в карточке «Ждёт согласования» на экране ремонта (см.
  // pendingAgreementRow), отдельный экран после диагностики не нужен.
  function openDiagnostics() {
    inSubScreen = true;
    const host = el("div", {});
    render([subBar("Диагностика"), host]);
    mountDiagnostics(host, {
      getItems: () => order.items,
      onCheck: (fa) => addItem(fa),
      onUncheck: (fa) => removeItemQuiet(fa.code),
      onEditItem: (code, patch) => editItemQuiet(code, patch),
      onDone: (notes) => {
        if (notes.length) editOrder(number, (o) => { o.diagnosticNotes = [...(o.diagnosticNotes || []), ...notes]; });
        refresh();
      },
      request: order.request || "",
      onRequest: (v) => editOrder(number, (o) => (o.request = v)),
      onlyBlocks: bike?.kind === "колесо" ? ["WHL"] : null,
    });
  }
  function openRunner(code) {
    inSubScreen = true;
    const host = el("div", {});
    render([subBar(cat.byCode.get(code)?.name || code), host]);
    mountRunner(host, cat.byCode.get(code), { onDone: refresh });
  }
  function openPicker(onPick) {
    inSubScreen = true;
    openWorkPicker({ existingItems: order.items, bikeKind: bike?.kind, onBack: refresh, onPick });
  }

  const range = orderRange(order);
  const head = el("div", { class: "card" },
    el("h2", {}, bike ? [bikeLabel(bike), bike.kind].filter(Boolean).join(" · ") : "велосипед"),
    el("p", { class: "small muted" }, `${client?.name || "—"} · ${order.clientPhone}`),
    order.request ? el("p", { class: "small" }, "Запрос клиента: " + order.request) : null);

  if ((order.diagnosticNotes || []).length) {
    const ul = el("ul", { style: "margin:4px 0 0;padding-left:18px" });
    order.diagnosticNotes.forEach((n, i) =>
      ul.append(el("li", { class: "small" }, n, " ",
        el("button", { class: "small", style: "border:0;background:none;color:var(--muted)", onclick: () => { editOrder(number, (o) => o.diagnosticNotes.splice(i, 1)); refresh(); } }, "✕"))));
    head.append(el("div", { class: "small", style: "margin-top:8px" }, el("span", { class: "muted" }, "Замечания с диагностики:"), ul));
  }

  const main = el("main", { class: "wrap" }, head);
  // Переход на новую стадию — это новый экран, тут скролл наверх уместен.
  const setStatus = (s, extra) => { editOrder(number, (o) => { o.status = s; if (extra) extra(o); }); render(viewOrder(number)); };
  // Возврат на пройденную стадию из прогресс-бара — по ошибке ушли дальше,
  // чем нужно. Сбрасываем поля, которые эта и более поздние стадии проставляют,
  // чтобы состояние не противоречило статусу, на который вернулись.
  const jumpToStage = (target) => {
    editOrder(number, (o) => {
      o.status = target;
      if (target === "принята") { o.occupiedBy = null; o.occupiedByName = ""; o.finishedAt = null; o.handedOverAt = null; }
      else if (target === "взята в работу") { o.occupiedBy = SESSION?.id || null; o.occupiedByName = SESSION?.name || ""; o.finishedAt = null; o.handedOverAt = null; }
      else if (target === "готово к выдаче") { o.occupiedBy = null; o.occupiedByName = ""; o.handedOverAt = null; }
    });
    render(viewOrder(number));
  };

  if (order.status === "приём") {
    main.append(stage("Диагностика и список работ",
      el("div", { class: "btn-row" },
        el("button", { class: "btn-primary", onclick: () => openDiagnostics() }, "Пройти диагностику"),
        el("button", { onclick: () => openPicker((pick) => { addItem(pick); refresh(); }) }, "+ работа")),
      itemList(order, false, { onRemove: removeItem, onSave: saveItemEdit, refresh }), order.items.length
        ? el("button", { class: "btn-primary", style: "width:100%;margin-top:12px", onclick: () => setStatus("оценка") }, "К оценке стоимости")
        : null));
  }

  if (order.status === "оценка") {
    const body = el("div", {});
    order.items.forEach((it) => body.append(assessItem(it,
      (di, st) => {
        editOrder(number, (o) => { const x = o.items.find((i) => i.code === it.code); if (x?.difficulties?.[di]) x.difficulties[di].state = st; });
        refresh();
      },
      (val) => {
        editOrder(number, (o) => { const x = o.items.find((i) => i.code === it.code); if (x) x.partsPrice = val; });
        refresh();
      },
      (qty) => {
        editOrder(number, (o) => { const x = o.items.find((i) => i.code === it.code); if (x) x.qty = qty; });
        refresh();
      })));
    body.append(
      el("div", { class: "card", style: "background:var(--bg)" },
        el("span", { class: "muted small" }, "Итого клиенту"),
        el("div", { class: "price-range" }, rangeText(orderRangeAll(order))),
        minutesText(orderMinutes(order, false)) ? el("div", { class: "small muted", style: "margin-top:4px" }, minutesText(orderMinutes(order, false))) : null),
      el("button", { onclick: () => openPicker((pick) => { addItem(pick); refresh(); }) }, "+ работа"),
      el("button", { class: "btn-primary", style: "width:100%;margin-top:12px", onclick: () => setStatus("согласование") }, "К согласованию"));
    main.append(stage("Оценка трудностей и стоимости", body));
  }

  if (order.status === "согласование") {
    const body = el("div", {});
    order.items.forEach((it) => {
      const r = itemRange(it);
      body.append(el("label", { class: "opt" },
        el("input", { type: "checkbox", checked: it.agreed, onchange: (e) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === it.code); if (x) x.agreed = e.target.checked; }); refresh(); } }),
        el("span", { style: "flex:1" }, el("b", {}, it.name), it.multiple && (it.qty || 1) > 1 ? ` × ${it.qty}` : "", el("br"),
          el("span", { class: "small muted" }, rangeText(r)))));
    });
    body.append(
      el("div", { class: "card", style: "background:var(--bg)" },
        el("span", { class: "muted small" }, "Согласовано на"),
        el("div", { class: "price-range" }, rangeText(range)),
        minutesText(orderMinutes(order, true)) ? el("div", { class: "small muted", style: "margin-top:4px" }, minutesText(orderMinutes(order, true))) : null),
      el("button", { class: "btn-primary", style: "width:100%", onclick: () => setStatus("принята") }, "В работу"));
    main.append(stage("Согласование с клиентом", body));
  }

  if (order.status === "принята") {
    main.append(stage("Ремонт",
      el("p", { class: "small muted" }, "Заявка в очереди — заберите в работу, чтобы увидеть список работ."),
      el("button", {
        class: "btn-primary", style: "width:100%",
        onclick: () => setStatus("взята в работу", (o) => { o.occupiedBy = SESSION?.id || null; o.occupiedByName = SESSION?.name || ""; }),
      }, "Взять в работу")));
  }

  if (order.status === "взята в работу") {
    const leaveOrder = () => {
      editOrder(number, (o) => { o.status = "принята"; o.occupiedBy = null; o.occupiedByName = ""; });
      go("/");
    };

    if (order.occupiedBy !== SESSION?.id) {
      main.append(stage("Ремонт",
        el("p", { class: "small muted" }, `Заявку сейчас ведёт: ${order.occupiedByName || "другой мастер"}.`)));
    } else {
      // Склад почти всегда уже в кэше (его подтягивали раньше на этом же
      // экране) — строим список сразу, без заглушек-скелетонов: иначе каждое
      // «Готово»/«Отменить» дёргает refresh() → viewOrder() заново, и список
      // на миг мигает пустыми полосками вместо того, чтобы просто остаться
      // на месте с обновлённым пунктом.
      const buildBody = (stock) => {
        const b = el("div", {});
        const pendingCard = pendingAgreementCard(order, pendingHandlers, stock);
        if (pendingCard) b.append(pendingCard);
        order.items.filter((i) => i.agreed).forEach((it) => b.append(repairItem(it, stock, {
          onRun: () => openRunner(it.code),
          onSave: (patch) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === it.code); if (x) Object.assign(x, patch); }); refresh(); },
          onQty: (qty) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === it.code); if (x) x.qty = qty; }); refresh(); },
          onRemove: removeItem,
        })));
        b.append(el("button", { onclick: () => openDiagnostics() }, "+ доп. работа"));
        b.append(el("button", { style: "margin-top:10px", onclick: leaveOrder }, "Выйти и освободить заявку"));
        const allDone = order.items.filter((i) => i.agreed).length > 0 && order.items.filter((i) => i.agreed).every((i) => i.done);
        if (allDone) b.append(el("button", { class: "btn-primary", style: "width:100%;margin-top:12px", onclick: () => setStatus("готово к выдаче", (o) => { o.finishedAt = new Date().toISOString(); o.occupiedBy = null; o.occupiedByName = ""; }) }, "Готово к выдаче"));
        return b;
      };
      const body = stockCache ? buildBody(stockCache) : el("div", {}, skeletonRows(2));
      if (!stockCache) ensureStock().then((s) => body.replaceChildren(...buildBody(s).childNodes));
      main.append(stage("Ремонт", body));
    }
  }

  if (order.status === "готово к выдаче") {
    main.append(pendingCardHost());
    main.append(stage("Смета для звонка клиенту", itemList({ items: order.items.filter((i) => i.agreed) }, true, null, true),
      el("div", { class: "card", style: "background:var(--bg);margin-top:12px" },
        el("span", { class: "muted small" }, "Итого"),
        el("div", { class: "total" }, rangeText(range)))));
    main.append(stage("Что дальше",
      el("button", { style: "width:100%", onclick: () => jumpToStage("взята в работу") }, "Добавить работу"),
      el("button", {
        class: "btn-ok", style: "width:100%;margin-top:10px",
        onclick: () => { editOrder(number, (o) => { o.status = "выдан"; o.handedOverAt = new Date().toISOString(); }); go("/"); },
      }, "Выдать клиенту")));
  }

  if (order.status === "выдан") {
    main.append(pendingCardHost());
    main.append(stage("Выдан", itemList({ items: order.items.filter((i) => i.agreed) }, true, null, true),
      el("div", { class: "card", style: "background:var(--bg)" },
        el("span", { class: "muted small" }, "Итого"),
        el("div", { class: "total" }, rangeText(range)))));
  }

  if (autoOpenDiagsFor === number && order.status === "приём" && order.items.length === 0) {
    autoOpenDiagsFor = null;
    queueMicrotask(openDiagnostics);
  }
  // Список работ длинный — «Итого» внизу карточки может уйти за экран, пока
  // листаешь. Закреплённая мини-сумма снизу экрана держит её на виду.
  const agreedCount = order.items.filter((i) => i.agreed).length;
  const showStickyTotal = ["готово к выдаче", "выдан"].includes(order.status) && agreedCount > 3;
  return [
    bar(order.number, order.status === "выдан" ? "/orders" : "/", el("span", { class: "sub" }, order.status)),
    orderProgressBar(order.status, jumpToStage),
    main,
    showStickyTotal ? stickyTotal(range) : null,
  ];
}

function stickyTotal(range) {
  return el("div", { class: "sticky-total" },
    el("span", { class: "muted small" }, "Итого"),
    el("span", { class: "amount" }, rangeText(range)));
}

function stage(title, ...body) { return el("div", { class: "card" }, el("h2", {}, title), ...body); }

// Название запчасти с количеством, если больше одной штуки — «Ротор × 2».
const partLabel = (p) => p.name + ((p.qty || 1) > 1 ? ` × ${p.qty}` : "");

// Список запчастей у работы — поиск по названию/артикулу вместо длинного
// выпадающего списка (в остатках их могут быть тысячи); пока не набрано
// ничего в поиске, показаны детали узла этой работы (blockId — id блока
// диагностики, WHL/BRK/...), чтобы не листать весь каталог ради тормозного
// троса на ремонте тормоза. Тап по найденной детали сразу добавляет её —
// строкой со своим счётчиком количества (плюс/минус). Общее для ремонта
// («в работе»), «Ждёт согласования» и оценки при создании обращения —
// мутирует parts на месте, onChange зовёт сохранение и перерисовку у
// вызывающего.
function partsEditor(parts, stock, onChange, blockId) {
  const list = el("div", {});
  const drawList = () => {
    list.replaceChildren(...parts.map((p, i) => el("div", { style: "display:flex;align-items:center;gap:10px;margin-top:6px" },
      el("span", { style: "flex:1" }, p.name, p.price ? el("span", { class: "small muted" }, ` · ${money(p.price)}`) : null),
      qtyStepper(p.qty, (qty) => { p.qty = qty; drawList(); onChange(); }),
      el("button", {
        style: iconBtnStyle,
        onclick: () => { parts.splice(i, 1); drawList(); onChange(); },
      }, "✕"))));
  };
  drawList();

  const addPart = (s) => {
    const existing = parts.find((p) => p.name === s.name && p.price === (s.price || 0));
    if (existing) existing.qty = (existing.qty || 1) + 1;
    else parts.push({ name: s.name, price: s.price || 0, qty: 1 });
    drawList();
    onChange();
    toast(`Добавлено: ${s.name}`);
  };

  // Пока не расширили поиск вручную — показываем только детали узла этой
  // работы (тормоз чиним — тормозные и предлагаем), не весь склад. Если
  // работа не привязана ни к какому узлу (свой/старый пункт) — сразу ищем
  // по всем остаткам, сужать нечем.
  let wide = !blockId;
  const q = el("input", { type: "text", placeholder: "Поиск детали по названию" });
  const results = el("div", { class: "rows", style: "max-height:260px;overflow-y:auto;margin-top:8px" });
  const widenLink = el("p", { class: "small", style: "margin-top:2px" },
    el("a", { href: "#", onclick: (e) => { e.preventDefault(); wide = true; drawResults(); } }, "Искать среди всех остатков →"));
  const drawResults = () => {
    if (!stock.length) { results.replaceChildren(el("p", { class: "small muted", style: "padding:10px 0" }, "Остатки пусты.")); return; }
    const query = q.value.trim().toLowerCase();
    const scoped = wide ? stock : stock.filter((s) => s.group === blockId);
    const matched = (query
      ? scoped.filter((s) => s.name.toLowerCase().includes(query) || (s.sku || "").toLowerCase().includes(query))
      : scoped
    ).slice(0, query ? 40 : 20);
    const rows = matched.map((s) => el("div", {
      class: "row", style: "cursor:pointer",
      onclick: () => addPart(s),
    },
      el("span", { style: "flex:1" }, s.name),
      el("span", { class: "small muted" }, s.price ? money(s.price) : "")));
    if (!matched.length) rows.push(el("p", { class: "small muted", style: "padding:10px 0" }, "Ничего не найдено."));
    if (!wide) rows.push(widenLink);
    results.replaceChildren(...rows);
  };
  q.addEventListener("input", drawResults);
  drawResults();

  return el("div", {}, q, results, list);
}

function itemRow(it, showFacts) {
  const r = itemRange(it);
  return el("div", { class: "row", style: "cursor:default;align-items:flex-start" },
    el("span", { style: "flex:1" }, it.name,
      it.multiple && (it.qty || 1) > 1 ? el("span", { class: "small muted" }, ` × ${it.qty}`) : null,
      showFacts && !it.agreed ? el("span", { class: "pill", style: "background:var(--fill);color:var(--muted)" }, "не согласовано") : null,
      it.notes ? el("span", { class: "small muted" }, el("br"), it.notes) : null,
      showFacts && it.done && (it.parts.length || it.doneBy) ? el("span", { class: "small muted" }, el("br"),
        [it.parts.length ? it.parts.map(partLabel).join(", ") : null, it.doneBy].filter(Boolean).join(" · ")) : null),
    el("span", { class: "price-tag" }, rangeText(r)));
}

// min-width/height 44px — минимальная зона тапа по HIG/WCAG, даже когда сама
// иконка визуально мельче: без этого ✕/+/− ловятся неточно, особенно на ходу.
const iconBtnStyle = "border:0;background:none;color:var(--muted);cursor:pointer;padding:0;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;font:inherit";

// Счётчик количества (сколько раз сделана работа/усложнение — два колеса,
// несколько спиц и т.п.). Показывается только когда у работы или усложнения
// стоит галочка «несколько», иначе количество всегда 1 и не отображается.
function qtyStepper(value, onChange) {
  return el("div", { style: "display:flex;align-items:center;gap:8px" },
    el("button", { style: iconBtnStyle + ";font-size:15px", onclick: () => onChange(Math.max(1, (value || 1) - 1)) }, "−"),
    el("span", { class: "small", style: "min-width:16px;text-align:center" }, String(value || 1)),
    el("button", { style: iconBtnStyle + ";font-size:15px", onclick: () => onChange((value || 1) + 1) }, "+"));
}

// Редактор списка усложнений (название + надбавка к цене + надбавка к времени
// + «неск.») — общий для форм правки работы каталога, своей неисправности и
// позиции наряда. Мутирует list на месте, box перерисовывается сам.
function complicationsEditor(list) {
  const box = el("div", {});
  const draw = () => {
    box.replaceChildren(
      ...list.map((c, ci) => el("div", { style: "margin-top:8px;padding:8px;background:var(--fill);border-radius:var(--radius-sm)" },
        el("div", { style: "display:flex;gap:6px;align-items:center" },
          el("input", { placeholder: "усложнение", value: c.label, style: "flex:1;min-width:0", oninput: (e) => (c.label = e.target.value) }),
          el("button", { style: iconBtnStyle, onclick: () => { list.splice(ci, 1); draw(); } }, "✕")),
        el("div", { style: "display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px" },
          el("span", { class: "muted small", style: "flex:0 0 auto" }, "надбавка"),
          el("input", { type: "number", value: c.add, style: "width:64px;text-align:right", oninput: (e) => (c.add = +e.target.value || 0) }),
          el("span", { class: "muted small" }, "₽"),
          el("input", { type: "number", value: c.addMinutes || 0, style: "width:56px;text-align:right", oninput: (e) => (c.addMinutes = +e.target.value || 0) }),
          el("span", { class: "muted small" }, "мин")),
        el("label", { class: "opt", style: "margin-top:6px" },
          el("input", { type: "checkbox", checked: !!c.multiple, onchange: (e) => (c.multiple = e.target.checked) }),
          el("span", { class: "small" }, "можно несколько раз")))),
      el("button", { style: "margin-top:6px", onclick: () => { list.push({ label: "", add: 0, addMinutes: 0, multiple: false }); draw(); } }, "+ усложнение"),
    );
  };
  draw();
  return box;
}

// Строка работы в наряде на стадии «приём» — можно убрать (✕) или изменить
// название/цену/время/усложнения (✎), не выходя из наряда.
function editableItemRow(it, { onRemove, onSave, refresh }) {
  const r = itemRange(it);
  const isEditing = editingItemCode === it.code;
  // Имя — на своей строке (растягивается на всю ширину, переносится
  // предсказуемо), цена/счётчик количества/действия — строкой ниже, всегда
  // в одном и том же порядке независимо от длины названия.
  const header = el("div", { class: "row", style: "align-items:flex-start;flex-direction:column;gap:6px" },
    el("span", { style: "width:100%" }, it.name, it.notes ? el("span", { class: "small muted" }, el("br"), it.notes) : null),
    el("div", { style: "display:flex;align-items:center;gap:10px;width:100%" },
      it.multiple ? qtyStepper(it.qty, (qty) => onSave(it.code, { qty })) : null,
      el("span", { class: "price-tag", style: "flex:1" }, rangeText(r)),
      el("button", { style: iconBtnStyle, onclick: () => { editingItemCode = isEditing ? null : it.code; refresh(); } }, "✎"),
      el("button", { style: iconBtnStyle, onclick: () => { if (confirm(`Убрать «${it.name}» из наряда?`)) onRemove(it.code); } }, "✕")));
  if (!isEditing) return header;

  const d = {
    name: it.name, workPrice: it.workPrice || 0, estimateMinutes: it.estimateMinutes || 0, notes: it.notes || "",
    difficulties: JSON.parse(JSON.stringify(it.difficulties || [])),
  };
  const compsBox = complicationsEditor(d.difficulties);
  const form = el("div", { class: "card", style: "background:var(--bg);margin-top:8px" },
    el("label", {}, "Название"),
    el("input", { value: d.name, oninput: (e) => (d.name = e.target.value) }),
    el("div", { style: "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px" },
      el("div", { style: "flex:1;min-width:120px" }, el("label", {}, "Цена, ₽"), el("input", { type: "number", value: d.workPrice, oninput: (e) => (d.workPrice = +e.target.value || 0) })),
      el("div", { style: "flex:1;min-width:120px" }, el("label", {}, "Минуты"), el("input", { type: "number", value: d.estimateMinutes, oninput: (e) => (d.estimateMinutes = +e.target.value || 0) }))),
    el("label", { style: "margin-top:8px" }, "Заметка"),
    el("input", { value: d.notes, oninput: (e) => (d.notes = e.target.value) }),
    el("label", { style: "margin-top:8px" }, "Усложнения"),
    compsBox,
    el("div", { class: "btn-row", style: "margin-top:10px" },
      el("button", { class: "btn-primary", onclick: () => onSave(it.code, {
        name: d.name.trim() || it.name, workPrice: d.workPrice, estimateMinutes: d.estimateMinutes,
        notes: d.notes.trim(), difficulties: d.difficulties,
      }) }, "Сохранить"),
      el("button", { onclick: () => { editingItemCode = null; refresh(); } }, "Отмена")));
  return el("div", {}, header, form);
}

// Наряд сгруппирован по узлам велосипеда (блоки диагностики), порядок — как в diagnostics.json.
// edit — {onRemove, onSave, refresh}: если передан, работы на стадии «приём»
// можно убрать или изменить прямо в списке.
// grouped=false — плоский список без заголовков по узлам (КОЛЁСА, ПРОЧЕЕ…),
// просто список работ; так, например, показан уже добавленный в наряд
// список прямо на диагностике — там это не нужно, там и так одна тема.
function itemList(order, showFacts, edit, detailed, grouped = true) {
  if (order.items.length === 0) return emptyState("Работ пока нет.");
  const row = (it) => (edit ? editableItemRow(it, edit) : detailed ? detailedItemRow(it) : itemRow(it, showFacts));
  if (!grouped) return el("div", { class: "rows", style: "margin-top:8px" }, order.items.map(row));
  const groups = groupBy(order.items, (it) => blockOf(it.code));
  const box = el("div", { style: "margin-top:8px" });
  for (const title of [...BLOCK_TITLES, "Прочее"]) {
    const list = groups.get(title);
    if (!list || !list.length) continue;
    box.append(
      el("p", { class: "small muted", style: "margin:14px 0 4px;letter-spacing:.05em" }, title.toUpperCase()),
      el("div", { class: "rows" }, list.map(row)));
  }
  return box;
}

// Разбивка стоимости работы по составляющим — для звонка клиенту на
// «готово к выдаче»/«выдан», чтобы не пересчитывать на словах: сама
// работа, каждая запчасть (с ценой и количеством) и каждое подтвердившееся
// усложнение отдельной строкой.
function detailedItemRow(it) {
  const r = itemRange(it);
  const lines = [`работы ${money((it.workPrice || 0) * (it.qty || 1))}`];
  for (const p of it.parts || []) lines.push(`${partLabel(p)} ${money((p.price || 0) * (p.qty || 1))}`);
  if (it.partsPrice) lines.push(`запчасти ${money(it.partsPrice)}`);
  for (const d of it.difficulties || []) {
    if (d.state === "yes") lines.push(`${d.label} ${money((d.add || 0) * (d.qty || 1))}`);
  }
  return el("div", { class: "row", style: "cursor:default;align-items:flex-start;flex-direction:column" },
    el("div", { style: "display:flex;width:100%;gap:8px" },
      el("span", { style: "flex:1" }, it.name, it.multiple && (it.qty || 1) > 1 ? el("span", { class: "small muted" }, ` × ${it.qty}`) : null),
      el("span", { class: "price-tag", style: "font-size:17px" }, rangeText(r))),
    it.notes ? el("p", { class: "small muted", style: "margin:2px 0 0" }, it.notes) : null,
    el("div", { class: "small muted", style: "margin-top:4px" }, lines.map((l) => el("div", {}, "– " + l))));
}

// Список усложнений — на «Оценке» (прикидка для клиента, ещё не известно
// наверняка) три варианта: будет/не будет/неизвестно. При отметке работы
// готовой (fact=true) — уже по факту, там только было/не было, «неизвестно»
// не бывает для завершённой работы.
const DIFFICULTY_STATE_LABELS = { yes: "будет", no: "не будет", unknown: "неизвестно" };
const DIFFICULTY_FACT_LABELS = { yes: "было", no: "не было" };
function difficultyList(difficulties, onSet, onQty, fact) {
  const labels = fact ? DIFFICULTY_FACT_LABELS : DIFFICULTY_STATE_LABELS;
  const box = el("div", {});
  (difficulties || []).forEach((d, di) => {
    box.append(el("div", { style: "margin-top:8px" },
      el("div", { class: "small" }, d.label, " ", el("span", { class: "muted" }, `(+${money(d.add)}${d.addMinutes ? `, +${d.addMinutes} мин` : ""})`)),
      // Свой ряд на всю ширину — сегментед-контрол (тот же паттерн, что и
      // везде в приложении), один тап сразу меняет состояние, без открытия
      // выпадающего списка. Счётчик количества — отдельной строкой ниже,
      // чтобы не тесниться с кнопками.
      el("div", { class: "segmented", style: "margin-top:4px" },
        Object.entries(labels).map(([v, lbl]) =>
          el("button", { class: d.state === v ? `active sel-${v}` : "", onclick: () => onSet(di, v) }, lbl))),
      d.multiple && onQty && d.state !== "no" ? el("div", { style: "margin-top:6px" }, qtyStepper(d.qty, (qty) => onQty(di, qty))) : null));
  });
  return box;
}

function assessItem(it, onSet, onParts, onQty) {
  const cost = "работа " + money(it.workPrice || 0);
  const box = el("div", { class: "assess" },
    el("div", { style: "display:flex;flex-wrap:wrap;align-items:center;gap:8px" },
      el("div", { style: "flex:1" }, el("b", {}, it.name), " ", el("span", { class: "small muted" }, "· " + cost)),
      it.multiple && onQty ? qtyStepper(it.qty, onQty) : null));
  box.append(el("div", { style: "display:flex;gap:8px;align-items:center;margin-top:6px" },
    el("span", { class: "small muted", style: "flex:1" }, "Запчасти (детали) в счёт"),
    el("input", { type: "number", value: it.partsPrice || 0, style: "width:96px;text-align:right",
      onchange: (e) => onParts(+e.target.value || 0) }),
    el("span", { class: "muted small" }, "₽")));
  if ((it.difficulties || []).length === 0) box.append(el("p", { class: "small muted" }, "Трудностей не ожидается."));
  else box.append(difficultyList(it.difficulties, onSet, (di, qty) => { if (it.difficulties[di]) it.difficulties[di].qty = qty; onSet(di, it.difficulties[di].state); }));
  return box;
}

// Работа, добавленная уже после исходного согласования (доп. работа в
// ремонте, находка на повторной диагностике) — не считается в «Итого» и
// не попадает в список ремонта, пока мастер явно не отметит «Согласовано»
// (позвонив клиенту). Без этого шага работа просто предлагается молча —
// то как «+ доп. работа», то как невидимая навсегда, — и тут явный шаг
// нужен в обоих случаях одинаково.
function pendingAgreementRow(it, { onAgree, onRemove, onSet, onDiffQty, onParts, onQty }, stock) {
  const r = itemRange(it);
  const box = el("div", { class: "assess" });
  const nameRow = el("div", {
    style: "display:flex;align-items:center;gap:8px;cursor:pointer",
    onclick: () => openPendingSheet(it, stock, { onSet, onDiffQty, onParts, onQty }),
  },
    el("b", { style: "flex:1;min-width:0" }, it.name, it.multiple && (it.qty || 1) > 1 ? el("span", { class: "small muted" }, ` × ${it.qty}`) : null),
    el("span", { style: "flex:0 0 auto;color:var(--line);font-size:19px" }, "›"));
  box.append(nameRow, el("div", { class: "price-tag", style: "margin-top:2px" }, rangeText(r)));
  // «Согласовано»/«Убрать» — основное действие для этой карточки, оставляем
  // видимым сразу на строке, не прячем за открытием формы деталей.
  box.append(el("div", { class: "btn-row", style: "margin-top:10px" },
    el("button", { class: "btn-ok", onclick: () => onAgree(it.code) }, "Согласовано"),
    el("button", { onclick: () => { if (confirm(`Убрать «${it.name}» из наряда?`)) onRemove(it.code); } }, "Убрать")));
  return box;
}

// Форма деталей для «Ждёт согласования» — усложнения (прогноз) и запчасти
// на вкладках, тем же bottom sheet, что и у согласованной работы.
function openPendingSheet(it, stock, { onSet, onDiffQty, onParts, onQty }) {
  const hasDiffs = (it.difficulties || []).length > 0;
  let tab = hasDiffs ? "diff" : "parts";
  const content = el("div", {});
  function draw() {
    content.replaceChildren(...[
      it.multiple ? el("div", { style: "margin-bottom:14px" }, qtyStepper(it.qty, (qty) => { onQty(it.code, qty); draw(); })) : null,
      hasDiffs ? el("div", { class: "segmented", style: "margin-bottom:14px" },
        el("button", { class: tab === "diff" ? "active" : "", onclick: () => { tab = "diff"; draw(); } }, "Усложнения"),
        el("button", { class: tab === "parts" ? "active" : "", onclick: () => { tab = "parts"; draw(); } }, "Запчасти")) : null,
      tab === "diff"
        ? (hasDiffs ? difficultyList(it.difficulties, (di, st) => { onSet(it.code, di, st); draw(); }, (di, qty) => { onDiffQty(it.code, di, qty); draw(); })
          : el("p", { class: "small muted" }, "Трудностей не ожидается."))
        : el("div", {}, el("label", { style: "margin-top:0" }, "Запчасти"), partsEditor(it.parts, stock, () => { onParts(it.code, it.parts); draw(); }, blockIdOf(it.code))),
    ].filter(Boolean));
  }
  draw();
  openSheet(it.name, content);
}

// Та же форма деталей — на «Оценке усложнений и стоимости» при создании
// обращения, до появления самого наряда: правки идут прямо в draft.items,
// onChange — просто перерисовать список работ позади.
function openAssessSheet(it, stock, onChange) {
  const hasDiffs = (it.difficulties || []).length > 0;
  let tab = hasDiffs ? "diff" : "parts";
  const content = el("div", {});
  function draw() {
    content.replaceChildren(...[
      it.multiple ? el("div", { style: "margin-bottom:14px" }, qtyStepper(it.qty, (qty) => { it.qty = qty; draw(); onChange(); })) : null,
      hasDiffs ? el("div", { class: "segmented", style: "margin-bottom:14px" },
        el("button", { class: tab === "diff" ? "active" : "", onclick: () => { tab = "diff"; draw(); } }, "Усложнения"),
        el("button", { class: tab === "parts" ? "active" : "", onclick: () => { tab = "parts"; draw(); } }, "Запчасти")) : null,
      tab === "diff"
        ? (hasDiffs ? difficultyList(it.difficulties,
            (di, st) => { it.difficulties[di].state = st; draw(); onChange(); },
            (di, qty) => { if (it.difficulties[di]) it.difficulties[di].qty = qty; draw(); onChange(); })
          : el("p", { class: "small muted" }, "Трудностей не ожидается."))
        : el("div", {}, el("label", { style: "margin-top:0" }, "Запчасти"), partsEditor(it.parts, stock, () => { draw(); onChange(); }, blockIdOf(it.code))),
    ].filter(Boolean));
  }
  draw();
  openSheet(it.name, content);
}

function pendingAgreementCard(order, handlers, stock) {
  const pending = order.items.filter((i) => !i.agreed);
  if (!pending.length) return null;
  return el("div", { class: "card" },
    el("h2", {}, "Ждёт согласования"),
    el("p", { class: "small muted" }, "Добавлено сверх исходной сметы — позвоните клиенту и подтвердите, тогда работа попадёт в наряд и сумму."),
    ...pending.map((it) => pendingAgreementRow(it, handlers, stock)));
}

// Нет отдельной кнопки «отметить/изменить»: тап по работе открывает форму
// факта снизу экрана (bottom sheet) — список работ под ней остаётся на
// месте, не раздувается. Убрать работу — свайп влево, как заявки в архиве.
// Правки в форме (было/не было, запчасти) сохраняются сами, без
// подтверждения, но на статус «готово» не влияют — им управляет одна кнопка
// внизу формы: «Готово» либо «Отменить», в обе стороны без ограничений.
function repairItem(it, stock, { onRun, onSave, onQty, onRemove }) {
  const box = el("div", { class: "assess" });
  const nameRow = el("div", {
    style: "display:flex;align-items:center;gap:8px;cursor:pointer",
    onclick: () => openRepairSheet(it, stock, onSave),
  },
    el("b", { style: "flex:1;min-width:0" }, it.name),
    it.done ? el("span", { class: "pill" }, "готово") : null,
    el("span", { style: "flex:0 0 auto;color:var(--line);font-size:19px" }, "›"));
  box.append(nameRow, el("div", { class: "price-tag", style: "margin-top:2px" }, rangeText(itemRange(it))));
  if (it.multiple) box.append(el("div", { style: "margin-top:10px" }, qtyStepper(it.qty, onQty)));
  if (it.notes) box.append(el("p", { class: "small muted" }, it.notes));
  return onRemove ? swipeToDelete(box, () => { onRemove(it.code); return true; }) : box;
}

// Содержимое bottom sheet для repairItem — усложнения/запчасти на вкладках
// (одна вкладка, если запчастям нечего показывать усложнения, и наоборот),
// «Готово»/«Отменить» внизу закрывает форму — с ней покончено.
function openRepairSheet(it, stock, onSave) {
  // «неизвестно» — прогнозное состояние (по умолчанию у новой работы), тут
  // такого выбора нет (см. fact:true ниже) — приводим к «не было», иначе
  // помеченная «готово» работа продолжала бы считаться диапазоном цены,
  // а не точной суммой.
  const diffs = JSON.parse(JSON.stringify(it.difficulties || [])).map((d) => (d.state === "unknown" ? { ...d, state: "no" } : d));
  const pickedParts = (it.parts || []).map((p) => ({ ...p }));
  const save = (extra) => onSave({ parts: pickedParts, difficulties: diffs, doneBy: it.doneBy ?? SESSION?.name ?? undefined, ...extra });
  const hasDiffs = diffs.length > 0;
  let tab = hasDiffs ? "diff" : "parts";

  const content = el("div", {});
  function draw() {
    const diffBox = el("div", {});
    // Тут уже не прогноз, а факт — работа сделана, известно точно, было
    // усложнение или нет. Третий вариант («неизвестно») тут ни к чему.
    const drawDiffs = () => diffBox.replaceChildren(difficultyList(diffs,
      (di, st) => { diffs[di].state = st; drawDiffs(); save(); },
      (di, qty) => { diffs[di].qty = qty; drawDiffs(); save(); }, true));
    drawDiffs();
    content.replaceChildren(...[
      hasDiffs ? el("div", { class: "segmented", style: "margin-bottom:14px" },
        el("button", { class: tab === "diff" ? "active" : "", onclick: () => { tab = "diff"; draw(); } }, "Усложнения"),
        el("button", { class: tab === "parts" ? "active" : "", onclick: () => { tab = "parts"; draw(); } }, "Запчасти")) : null,
      tab === "diff" ? diffBox : el("div", {}, el("label", { style: "margin-top:0" }, "Запчасти"), partsEditor(pickedParts, stock, save, blockIdOf(it.code))),
      it.done
        ? el("button", { style: "width:100%;margin-top:16px", onclick: () => { save({ done: false }); toast("Статус снят"); sheet.close(); } }, "Отменить")
        : el("button", { class: "btn-ok", style: "width:100%;margin-top:16px", onclick: () => { save({ done: true }); toast("Отмечено готово"); sheet.close(); } }, "Готово"),
    ].filter(Boolean));
  }
  draw();
  const sheet = openSheet(it.name, content);
}

// ============================================================================
//  РАННЕР ПРОЦЕДУРЫ (пошаговый мастер)
// ============================================================================

const MODE_LABEL = { master: "Мастер", standard: "Стандарт", training: "Обучение" };

function mountRunner(host, proc, { onDone }) {
  let mode = "standard";
  const draw = () => {
    host.replaceChildren(
      el("main", { class: "wrap" },
        el("div", { class: "card" },
          el("h2", {}, proc.name),
          proc.entry ? el("p", { class: "small muted" }, "Вход: " + proc.entry) : null,
          proc.tools ? el("p", { class: "small muted" }, "Инструмент: " + proc.tools) : null,
          proc.consumables ? el("p", { class: "small muted" }, "Расходники: " + proc.consumables) : null),
        el("div", { class: "card" },
          el("label", {}, "Режим показа"),
          el("div", { class: "segmented" },
            ["master", "standard", "training"].map((m) =>
              el("button", { class: mode === m ? "active" : "", onclick: () => { mode = m; draw(); } }, MODE_LABEL[m]))),
          el("p", { class: "small muted", style: "margin-top:8px" },
            "Мастер — только главы и проверки. Стандарт — с шагами. Обучение — с пояснениями."))),
      el("div", { class: "actions" }, el("div", { class: "actions-inner" },
        el("button", { class: "btn-primary", onclick: () => runActive(host, proc, mode, {}, onDone) }, "Начать"))),
    );
  };
  draw();
}

function runActive(host, proc, mode, opts, onDone) {
  const crumbs = el("div", { class: "crumbs" });
  const chapterEl = el("div", { class: "chapter-title" });
  const body = el("main", { class: "wrap" }, crumbs, chapterEl, el("div", { id: "run-body" }));
  const actions = el("div", { class: "actions" }, el("div", { class: "actions-inner" }));
  host.replaceChildren(body, actions);
  const bodyEl = () => document.getElementById("run-body");
  const setActions = (...btns) => actions.firstChild.replaceChildren(...btns.filter(Boolean));

  const log = [];
  let chapterText = "";
  const setChapter = (t) => { chapterText = t; chapterEl.textContent = t; };

  const io = {
    chapter(ch, path) { crumbs.textContent = path.join(" › "); setChapter(`${ch.id}. ${ch.title}`); log.push({ k: "ch", t: `${ch.id}. ${ch.title}` }); },
    foreachItem(v, item) { setChapter(`${chapterText}  ·  ▸ ${item} ${v}`); log.push({ k: "ch", t: `▸ ${item} ${v}` }); },
    step(node, showNotes) {
      return new Promise((res) => {
        const b = bodyEl();
        b.replaceChildren(el("div", { class: "step-text" }, node.text),
          ...(showNotes ? node.notes.map((n) => el("div", { class: "note" }, n)) : []));
        setActions(el("button", { class: "btn-primary", onclick: () => { log.push({ k: "step", t: node.text }); res(); } }, "Далее"));
      });
    },
    check(text) {
      return new Promise((res) => {
        bodyEl().replaceChildren(el("div", { class: "check-box" }, text));
        setActions(
          el("button", { class: "btn-ok", onclick: () => { log.push({ k: "ok", t: text }); res(true); } }, "Норма"),
          el("button", { class: "btn-warn", onclick: () => { log.push({ k: "fail", t: text }); res(false); } }, "Не норма"));
      });
    },
    branch(q, options) {
      return new Promise((res) => {
        bodyEl().replaceChildren(el("div", { class: "check-box" }, q));
        setActions(...options.map((o) => el("button", { class: "btn-primary", onclick: () => res(o) }, o)));
      });
    },
    loopAgain(cond) {
      return new Promise((res) => {
        bodyEl().replaceChildren(el("div", { class: "check-box" }, cond + "?"));
        setActions(el("button", { class: "btn-primary", onclick: () => res(true) }, "Да"), el("button", { onclick: () => res(false) }, "Нет"));
      });
    },
    foreachNext(v, c, first) {
      return new Promise((res) => {
        bodyEl().replaceChildren(el("div", { class: "check-box" }, `${first ? "начать" : "ещё"}: ${v} (${c})?`));
        setActions(el("button", { class: "btn-primary", onclick: () => res(true) }, "Да"), el("button", { onclick: () => res(false) }, "Нет"));
      });
    },
    approve(text) {
      return new Promise((res) => {
        bodyEl().replaceChildren(el("div", { class: "check-box" }, "Согласовать с клиентом: " + text));
        setActions(el("button", { class: "btn-primary", onclick: () => { log.push({ k: "appr", t: text }); res(); } }, "Согласовано"));
      });
    },
    stop(reason) { log.push({ k: "stop", t: reason }); bodyEl().append(el("p", { class: "note" }, "СТОП: " + reason)); },
    enterCall(t, note) { log.push({ k: "call", t: `${t.name}${note ? " — " + note : ""}` }); },
    exitCall() {},
    missingCall(code) { log.push({ k: "stop", t: `[${code}] — не написана, пропуск` }); },
    skipRecursion(code) { log.push({ k: "call", t: `повторный [${code}] — пропуск` }); },
  };

  runProcedure(cat, proc, io, { mode, params: opts.params }).finally(() => {
    setChapter("Готово");
    crumbs.textContent = "";
    const b = bodyEl();
    b.replaceChildren();
    if (proc.quality.length) b.append(el("div", { class: "card" }, el("p", { class: "small muted" }, "ПРОВЕРКА КАЧЕСТВА"),
      el("ul", { class: "small" }, proc.quality.map((q) => el("li", {}, q)))));
    if (proc.record.length) b.append(el("div", { class: "card" }, el("p", { class: "small muted" }, "ФИКСИРОВАТЬ В НАРЯДЕ"),
      el("ul", { class: "small" }, proc.record.map((r) => el("li", {}, r)))));
    const det = el("details", { class: "card done-log" }, el("summary", {}, `Пройдено (${log.length})`),
      ...log.map((x) => el("div", { class: "item" + (x.k === "fail" ? " fail" : "") }, x.k === "ch" ? el("b", {}, x.t) : x.t)));
    b.append(det);
    if (proc.sources.length) b.append(el("div", { class: "card" }, el("p", { class: "small muted" }, "Источники"),
      proc.sources.map((s) => el("p", { class: "small" }, s.url ? el("a", { href: s.url, target: "_blank" }, s.title) : s.title))));
    setActions(el("button", { class: "btn-primary", onclick: onDone }, "Дальше"));
  });
}

// ============================================================================
//  ДИАГНОСТИКА ПО БЛОКАМ
//  Мастер: все узлы по умолчанию «Норма», мастер отмечает только проблемные.
//  Обучение: тот же список + место под справку по каждой неисправности.
// ============================================================================

const DIAG_TOGGLES = [
  { param: "тормоза", label: "Тормоза", options: [["гидравлика", "гидравлика"], ["механика", "механика"]] },
  { param: "покрышки", label: "Покрышки", options: [["камера", "камера"], ["бескамерка", "бескамерка"]] },
  { param: "трансмиссия", label: "Трансмиссия", options: [["механика", "механика"], ["электроника", "электроника"]] },
];

// getItems/onCheck/onUncheck/onEditItem — список работ живёт у вызывающего
// (наряд или черновик нового обращения) и меняется сразу по клику на
// чекбокс, без ожидания «Готово»: поэтому его можно тут же посмотреть,
// изменить (✎) или убрать (✕), не выходя из диагностики.
// onDone(notes) получает только текстовые заметки без привязки к работе.
function mountDiagnostics(host, { getItems, onCheck, onUncheck, onEditItem, onDone, request = "", onRequest, onlyBlocks }) {
  const toggles = { тормоза: "гидравлика", покрышки: "камера", трансмиссия: "механика" };
  let req = request;
  const states = {}; // instId -> { open, faults:Set<number>, comment }
  const st = (id) => (states[id] ||= { open: false, faults: new Set(), comment: "" });
  let repairs = []; // неисправности, заведённые админом вручную (общие для всех)
  const addFormOpenFor = new Set(); // id блоков, где сейчас открыта форма «+ своя неисправность»
  const editOverrideFor = new Set(); // коды работ каталога, у которых сейчас открыта форма правки

  const instances = () => {
    const out = [];
    for (const b of diagBlocks) {
      if (onlyBlocks && !onlyBlocks.includes(b.id)) continue;
      if (b.perSide) {
        out.push({ b, id: b.id + ".F", label: `${b.title} · перед` });
        out.push({ b, id: b.id + ".R", label: `${b.title} · зад` });
      } else out.push({ b, id: b.id, label: b.title });
    }
    return out;
  };
  // overrideKey — ключ для переопределения/скрытия: у обычной работы это её
  // код операции (WHL-05 и т.п.); у неисправности без кода (определяется на
  // разборке, code:"") — свой синтетический ключ, т.к. code у них у всех
  // одинаковый ("") и по нему нельзя различить разные пункты списка.
  const blockFaults = (b) => [
    ...b.sections.flatMap((s) => s.faults.map((f, fi) => {
      const overrideKey = f.code || `NC-${s.id}-${fi}`;
      return { ...f, section: s.title, overrideKey, label: OVERRIDES[overrideKey]?.name || f.label };
    })).filter((f) => !OVERRIDES[f.overrideKey]?.hidden),
    ...repairs.filter((r) => r.group === b.id).map((r) => ({
      label: r.label, code: `CF-${r.id}`, custom: true, id: r.id,
      price: r.price, minutes: r.minutes, complications: r.complications, multiple: r.multiple,
    })),
  ];
  const faultVisible = (f) => !f.if || toggles[f.if.param] === f.if.value;
  // Снять галочку с чекбокса(ов) этого кода во всех узлах — работа могла быть
  // убрана не через сам чекбокс (из сводного списка или удалением неисправности).
  const uncheckByCode = (code) => {
    for (const inst of instances()) {
      const s = st(inst.id);
      blockFaults(inst.b).forEach((f, i) => { if (f.code === code) s.faults.delete(i); });
    }
  };
  // Тот же код мог быть отмечен и в другом узле/стороне (перед/зад) — проверяем
  // перед тем, как убирать работу из наряда по снятой галочке.
  const codeCheckedElsewhere = (code, exceptInstId) => instances().some((inst) => {
    if (inst.id === exceptInstId) return false;
    const s = st(inst.id);
    return blockFaults(inst.b).some((f, i) => f.code === code && s.faults.has(i));
  });

  async function reloadRepairs() {
    repairsCache = null;
    repairs = await ensureRepairs();
  }

  // Форма правки встроенной (из каталога) неисправности — переопределяет
  // название/цену/время/усложнения поверх дефолта, хранится на сервере.
  function overrideForm(f, onClose) {
    // У неисправности без кода (f.code === "") нет ни цены, ни усложнений —
    // конкретная операция и её стоимость определяются на разборке; тут можно
    // только переименовать формулировку.
    const hasPrice = !!f.code;
    const eff = hasPrice ? priceOf(f.code) : {};
    const draftOv = {
      name: OVERRIDES[f.overrideKey]?.name || f.label,
      price: eff.work || 0, minutes: eff.minutes || 0,
      complications: JSON.parse(JSON.stringify(eff.difficulties || [])),
      multiple: !!eff.multiple,
    };
    const compsBox = hasPrice ? complicationsEditor(draftOv.complications) : null;
    return el("div", { class: "card", style: "background:var(--bg);margin-top:8px" },
      el("label", {}, "Название"),
      el("input", { value: draftOv.name, oninput: (e) => (draftOv.name = e.target.value) }),
      !hasPrice ? el("p", { class: "small muted", style: "margin-top:6px" }, "Без кода операции — цена определяется на разборке, тут доступно только название.") : null,
      hasPrice ? el("div", { style: "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px" },
        el("div", { style: "flex:1;min-width:120px" }, el("label", {}, "Цена, ₽"), el("input", { type: "number", value: draftOv.price, oninput: (e) => (draftOv.price = +e.target.value || 0) })),
        el("div", { style: "flex:1;min-width:120px" }, el("label", {}, "Минуты"), el("input", { type: "number", value: draftOv.minutes, oninput: (e) => (draftOv.minutes = +e.target.value || 0) }))) : null,
      hasPrice ? el("label", { class: "opt", style: "margin-top:8px" },
        el("input", { type: "checkbox", checked: draftOv.multiple, onchange: (e) => (draftOv.multiple = e.target.checked) }),
        el("span", { class: "small" }, "можно несколько раз на одном велосипеде")) : null,
      hasPrice ? el("label", { style: "margin-top:8px" }, "Усложнения (надбавка к цене и времени)") : null,
      hasPrice ? compsBox : null,
      el("div", { class: "btn-row", style: "margin-top:10px" },
        el("button", { class: "btn-primary", onclick: async () => {
          const patch = { code: f.overrideKey, name: draftOv.name.trim() || null };
          if (hasPrice) Object.assign(patch, { price: draftOv.price, minutes: draftOv.minutes || null, complications: draftOv.complications, multiple: draftOv.multiple });
          const ok = await overridesApi("PUT", patch);
          if (ok) onClose();
        } }, "Сохранить"),
        el("button", { onclick: onClose }, "Отмена")));
  }

  // Форма добавления своей неисправности (только у администратора) — цена,
  // время и усложнения задаются сразу тут же, без .proc-процедуры.
  function customFaultForm(blockId) {
    const draftFa = { label: "", price: 0, minutes: 0, complications: [], multiple: false };
    const compsBox = complicationsEditor(draftFa.complications);
    return el("div", { class: "card", style: "background:var(--bg);margin-top:8px" },
      el("label", {}, "Название неисправности"),
      el("input", { placeholder: "напр. Восьмёрка", oninput: (e) => (draftFa.label = e.target.value) }),
      el("div", { style: "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px" },
        el("div", { style: "flex:1;min-width:120px" }, el("label", {}, "Цена, ₽"), el("input", { type: "number", oninput: (e) => (draftFa.price = +e.target.value || 0) })),
        el("div", { style: "flex:1;min-width:120px" }, el("label", {}, "Минуты"), el("input", { type: "number", oninput: (e) => (draftFa.minutes = +e.target.value || 0) }))),
      el("label", { class: "opt", style: "margin-top:8px" },
        el("input", { type: "checkbox", onchange: (e) => (draftFa.multiple = e.target.checked) }),
        el("span", { class: "small" }, "можно несколько раз на одном велосипеде")),
      el("label", { style: "margin-top:8px" }, "Усложнения (надбавка к цене и времени, необязательно)"),
      compsBox,
      el("div", { class: "btn-row", style: "margin-top:10px" },
        el("button", { class: "btn-primary", onclick: async () => {
          if (!draftFa.label.trim()) return alert("Укажите название");
          const r = await fetch("/api/repairs", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ group: blockId, label: draftFa.label.trim(), price: draftFa.price, minutes: draftFa.minutes, complications: draftFa.complications, multiple: draftFa.multiple }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) return alert(j.error || "ошибка");
          addFormOpenFor.delete(blockId);
          await reloadRepairs();
          draw();
        } }, "Добавить"),
        el("button", { onclick: () => { addFormOpenFor.delete(blockId); draw(); } }, "Отмена")));
  }

  // Правка своей неисправности (заведённой через «+ своя неисправность»,
  // хранится в catalog/repairs) — то же самое, что и при создании, но PUT.
  function customFaultEditForm(f, onClose) {
    const draftFa = { label: f.label, price: f.price || 0, minutes: f.minutes || 0, complications: JSON.parse(JSON.stringify(f.complications || [])), multiple: !!f.multiple };
    const compsBox = complicationsEditor(draftFa.complications);
    return el("div", { class: "card", style: "background:var(--bg);margin-top:8px" },
      el("label", {}, "Название неисправности"),
      el("input", { value: draftFa.label, oninput: (e) => (draftFa.label = e.target.value) }),
      el("div", { style: "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px" },
        el("div", { style: "flex:1;min-width:120px" }, el("label", {}, "Цена, ₽"), el("input", { type: "number", value: draftFa.price, oninput: (e) => (draftFa.price = +e.target.value || 0) })),
        el("div", { style: "flex:1;min-width:120px" }, el("label", {}, "Минуты"), el("input", { type: "number", value: draftFa.minutes, oninput: (e) => (draftFa.minutes = +e.target.value || 0) }))),
      el("label", { class: "opt", style: "margin-top:8px" },
        el("input", { type: "checkbox", checked: draftFa.multiple, onchange: (e) => (draftFa.multiple = e.target.checked) }),
        el("span", { class: "small" }, "можно несколько раз на одном велосипеде")),
      el("label", { style: "margin-top:8px" }, "Усложнения (надбавка к цене и времени, необязательно)"),
      compsBox,
      el("div", { class: "btn-row", style: "margin-top:10px" },
        el("button", { class: "btn-primary", onclick: async () => {
          if (!draftFa.label.trim()) return alert("Укажите название");
          const r = await fetch("/api/repairs", {
            method: "PUT", headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: f.id, label: draftFa.label.trim(), price: draftFa.price, minutes: draftFa.minutes, complications: draftFa.complications, multiple: draftFa.multiple }),
          });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) return alert(j.error || "ошибка");
          await reloadRepairs();
          onClose();
        } }, "Сохранить"),
        el("button", { onclick: onClose }, "Отмена")));
  }

  function draw() {
    const list = instances();
    const wrap = el("main", { class: "wrap" });

    wrap.append(el("div", { class: "card" },
      el("h2", {}, "Диагностика"),
      el("p", { class: "small muted" }, "Раскрой узел, если с ним есть проблема, и отметь неисправность в списке."),
      // DIAG_TOGGLES (гидравлика/механика и т.п.) пока скрыты — переключатели
      // остаются в коде с дефолтными значениями, faultVisible ими и пользуется.
      onRequest ? el("label", { class: "small muted", style: "margin-top:10px" }, "Запрос клиента (со слов)") : null,
      onRequest ? el("textarea", { rows: 2, value: req, placeholder: "с чем пришёл",
        onchange: (e) => { req = e.target.value.trim(); onRequest(req); } }) : null));

    const items = getItems();
    if (items.length) {
      wrap.append(el("div", {},
        el("p", { class: "small muted", style: "margin:14px 0 4px" }, "Уже добавлено в наряд"),
        itemList({ items }, false, {
          onRemove: (code) => { onUncheck({ code }); uncheckByCode(code); draw(); },
          onSave: (code, patch) => { onEditItem(code, patch); draw(); },
          refresh: draw,
        }, false, false)));
    }

    for (const inst of list) {
      const s = st(inst.id);
      const count = s.faults.size;
      const header = el("div", {
        style: "display:flex;align-items:center;gap:10px;cursor:pointer",
        onclick: () => { s.open = !s.open; draw(); },
      },
        el("div", { style: "flex:1" },
          el("h2", { style: "margin:0" }, inst.label),
          el("p", { class: "small muted", style: "margin:2px 0 0" }, inst.b.prompt)),
        count ? el("span", { class: "pill", style: "background:var(--warn-weak);color:var(--warn)" }, String(count)) : null,
        el("span", {
          style: `flex:0 0 auto;color:var(--line);font-size:19px;transform:rotate(${s.open ? "90deg" : "0deg"});transition:transform .15s ease`,
        }, "›"));
      const card = el("div", { class: "card" }, header);

      if (s.open) {
        const fb = el("div", { style: "margin-top:8px" });
        const faults = blockFaults(inst.b);
        faults.forEach((f, i) => {
          if (!faultVisible(f)) return;
          const isAdmin = SESSION?.role === "admin";
          const editKey = f.custom ? f.id : f.overrideKey;
          const editingThis = editOverrideFor.has(editKey);
          fb.append(el("div", {},
            el("div", { style: "display:flex;align-items:center;gap:6px" },
              el("label", { class: "opt", style: "flex:1" },
                el("input", { type: "checkbox", checked: s.faults.has(i),
                  onchange: () => {
                    // Без code — неисправность без привязанной операции (определяется
                    // на разборке), в наряд не превращается, только в заметку.
                    // Один и тот же код может быть отмечен и спереди, и сзади —
                    // убираем работу из наряда, только когда код больше нигде не отмечен.
                    if (s.faults.has(i)) { s.faults.delete(i); if (f.code && !codeCheckedElsewhere(f.code, inst.id)) onUncheck(f); }
                    else { s.faults.add(i); if (f.code) onCheck(f); }
                    draw();
                  } }),
                el("span", {}, f.label,
                  f.code && !f.custom ? el("span", { class: "pill" }, rangeText(codeRange(f.code))) : null,
                  f.custom ? el("span", { class: "pill" }, rangeText(customFaultRange(f))) : null)),
              isAdmin
                ? el("button", {
                    style: iconBtnStyle,
                    onclick: () => { editingThis ? editOverrideFor.delete(editKey) : editOverrideFor.add(editKey); draw(); },
                  }, "✎")
                : null,
              isAdmin
                ? el("button", {
                    style: iconBtnStyle,
                    onclick: async () => {
                      if (!confirm(`Убрать «${f.label}» из списка совсем?`)) return;
                      const wasChecked = s.faults.has(i);
                      if (f.custom) {
                        // Реальный уникальный код (CF-id) — может повторяться на обеих
                        // сторонах, снимаем везде, пока он ещё виден в blockFaults().
                        uncheckByCode(f.code);
                        await fetch("/api/repairs", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: f.id }) });
                        if (wasChecked) onUncheck(f);
                        await reloadRepairs();
                      } else if (f.code) {
                        uncheckByCode(f.code);
                        const ok = await overridesApi("PUT", { code: f.code, hidden: true });
                        if (!ok) return;
                        if (wasChecked) onUncheck(f);
                      } else {
                        // Без кода: overrideKey свой у каждого пункта, а не общий код
                        // операции — снимаем только эту галочку, не трогая остальные.
                        s.faults.delete(i);
                        const ok = await overridesApi("PUT", { code: f.overrideKey, hidden: true });
                        if (!ok) return;
                      }
                      draw();
                    },
                  }, "✕")
                : null),
            editingThis
              ? (f.custom ? customFaultEditForm(f, () => { editOverrideFor.delete(editKey); draw(); }) : overrideForm(f, () => { editOverrideFor.delete(editKey); draw(); }))
              : null));
        });
        if (SESSION?.role === "admin") {
          fb.append(addFormOpenFor.has(inst.b.id)
            ? customFaultForm(inst.b.id)
            : el("button", {
                class: "small", style: "margin-top:8px;border:0;background:none;color:var(--muted);text-decoration:underline;padding:0",
                onclick: () => { addFormOpenFor.add(inst.b.id); draw(); },
              }, "+ своя неисправность"));
        }
        fb.append(el("input", { type: "text", placeholder: "комментарий", value: s.comment,
          style: "margin-top:6px", oninput: (e) => (s.comment = e.target.value) }));
        card.append(fb);
      }
      wrap.append(card);
    }

    host.replaceChildren(wrap,
      el("div", { class: "actions" }, el("div", { class: "actions-inner" },
        el("button", { class: "btn-primary", onclick: finish }, "Готово"))));
  }

  // Работы с кодом уже добавлены живьём по каждому чекбоксу — тут собираем
  // текстовые заметки: неисправности без кода (определяются на разборке) и
  // свободный комментарий по узлу.
  function finish() {
    const notes = [];
    for (const inst of instances()) {
      const s = st(inst.id);
      if (!s.faults.size && !s.comment.trim()) continue;
      const faults = blockFaults(inst.b);
      const noCode = [...s.faults].map((i) => faults[i]).filter(Boolean).filter(faultVisible).filter((f) => !f.code)
        .map((f) => [f.label, f.note].filter(Boolean).join(" — "));
      const c = (s.comment || "").trim();
      const parts = c ? [...noCode, c] : noCode;
      if (parts.length) notes.push(`${inst.label}: ${parts.join("; ")}`);
    }
    onDone(notes);
  }

  host.replaceChildren(el("main", { class: "wrap" }, skeletonRows()));
  ensureRepairs().then((r) => { repairs = r; draw(); });
}

// ============================================================================
//  ВХОД, ПЕРВЫЙ ЗАПУСК, ПРОФИЛЬ
// ============================================================================

function authCard(title, hint, fields, onSubmit, submitLabel) {
  let error = "";
  const submit = async (ev) => {
    ev.preventDefault();
    error = "";
    try {
      await onSubmit(ev.target);
    } catch (e) {
      error = e.message || "ошибка";
      render(box());
    }
  };
  const box = () => [
    el("main", { class: "wrap", style: "padding-top:48px" },
      el("form", { class: "card", style: "max-width:360px;margin:0 auto", onsubmit: submit },
        el("h2", {}, title),
        hint ? el("p", { class: "small muted" }, hint) : null,
        error ? el("p", { class: "small", style: "color:var(--warn)" }, error) : null,
        ...fields,
        el("div", { class: "btn-row", style: "margin-top:16px" },
          el("button", { class: "btn-primary", type: "submit" }, submitLabel)))),
  ];
  return box();
}

function field(label, name, type, autocomplete) {
  return [el("label", {}, label), el("input", { name, type: type || "text", autocomplete: autocomplete || "off" })];
}

// Форма-карточка, встраиваемая внутрь другого экрана (в отличие от authCard,
// который сам себе целая страница). При ошибке заменяет сама себя в DOM.
function formCard(title, hint, fields, onSubmit, submitLabel, error) {
  let formEl;
  const submit = async (ev) => {
    ev.preventDefault();
    try {
      await onSubmit(ev.target);
    } catch (e) {
      formEl.replaceWith(formCard(title, hint, fields, onSubmit, submitLabel, e.message || "ошибка"));
    }
  };
  formEl = el("form", { class: "card", onsubmit: submit },
    el("h2", {}, title),
    hint ? el("p", { class: "small muted" }, hint) : null,
    error ? el("p", { class: "small", style: "color:var(--warn)" }, error) : null,
    ...fields,
    el("div", { class: "btn-row", style: "margin-top:16px" },
      el("button", { class: "btn-primary", type: "submit" }, submitLabel)));
  return formEl;
}

function viewLogin() {
  return authCard("Вход в Vella", null,
    [...field("Логин", "login"), ...field("Пароль", "password", "password", "current-password")],
    async (form) => {
      await authAction({ action: "login", login: form.login.value.trim(), password: form.password.value });
      await loadSession();
      await loadOverrides();
      location.hash = "/";
      router();
    }, "Войти");
}

function viewSetup() {
  return authCard("Первый запуск", "Учётных записей ещё нет. Создайте администратора — дальше он сам заведёт мастеров.",
    [...field("Имя", "name"), ...field("Логин", "login"),
     ...field("Пароль", "password", "password", "new-password"),
     ...field("Повтор пароля", "password2", "password", "new-password")],
    async (form) => {
      if (form.password.value !== form.password2.value) throw new Error("Пароли не совпадают");
      await authAction({ action: "bootstrap", name: form.name.value.trim(), login: form.login.value.trim(), password: form.password.value });
      await loadSession();
      await loadOverrides();
      location.hash = "/";
      router();
    }, "Создать");
}

function viewProfile() {
  return [
    bar("Профиль", "/"),
    el("main", { class: "wrap" },
      el("div", { class: "card" },
        el("div", {}, SESSION?.name), el("div", { class: "small muted" }, SESSION?.login,
          SESSION?.role === "admin" ? el("span", { class: "pill" }, "администратор") : el("span", { class: "pill" }, "мастер"))),
      SESSION?.role === "admin" ? el("div", { class: "rows", style: "margin-bottom:12px" }, homeLink("Админка", "/admin", ICONS.admin)) : null,
      formCard("Сменить пароль", null,
        [...field("Текущий пароль", "current", "password", "current-password"),
         ...field("Новый пароль", "next", "password", "new-password")],
        async (form) => {
          await authAction({ action: "changePassword", currentPassword: form.current.value, newPassword: form.next.value });
          alert("Пароль изменён");
          location.hash = "/";
          router();
        }, "Сохранить"),
      el("button", { style: "margin-top:16px;border:0;background:none;color:var(--muted);text-decoration:underline;padding:0", onclick: logout }, "Выйти")),
  ];
}

// ============================================================================
//  АДМИНКА
// ============================================================================

function viewAdmin() {
  return [
    bar("Админка", "/"),
    el("main", { class: "wrap" },
      el("div", { class: "rows" },
        homeLink("Мастера", "/admin/masters", ICONS.masters),
        homeLink("Остатки по запчастям", "/admin/stock", ICONS.stock),
        homeLink("Переопределения работ", "/admin/overrides", ICONS.prices))),
  ];
}

// ---------------------------- переопределения работ каталога -----------------
// Правки названия/цены/усложнений и скрытие встроенных работ делаются прямо
// на экране диагностики (✎ / ✕ у неисправности). Здесь — только список того,
// что уже переопределено или скрыто, и кнопка вернуть как было.

async function loadOverridesScreen() {
  try {
    const r = await fetch("/api/overrides", { cache: "no-store" });
    const j = await r.json();
    if (location.hash !== "#/admin/overrides") return;
    render(overridesScreen(r.ok ? j.byCode || {} : {}, r.ok ? "" : j.error || "ошибка"));
  } catch {
    if (location.hash === "#/admin/overrides") render(overridesScreen({}, "нет соединения"));
  }
}
function viewOverrides() {
  loadOverridesScreen();
  return [bar("Переопределения работ", "/admin"), el("main", { class: "wrap" }, skeletonRows())];
}

function overridesScreen(byCode, error) {
  const codes = Object.keys(byCode);
  const rows = codes.map((code) => {
    const ov = byCode[code];
    const proc = cat.byCode.get(code);
    const bits = [];
    if (ov.hidden) bits.push("скрыта");
    if (ov.name) bits.push(`название: «${ov.name}»`);
    if (ov.price != null) bits.push(`цена: ${money(ov.price)}`);
    if (ov.minutes != null) bits.push(`время: ${ov.minutes} мин`);
    if (ov.complications?.length) bits.push(`усложнений: ${ov.complications.length}`);
    if (ov.multiple) bits.push("можно несколько раз");
    return el("div", { class: "card" },
      el("div", {}, el("b", {}, ov.name || proc?.name || code), " ", el("span", { class: "small muted" }, code)),
      el("p", { class: "small muted" }, bits.join(" · ") || "—"),
      el("button", { onclick: async () => {
        const r = await fetch("/api/overrides", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) { alert(j.error || "ошибка"); return; }
        OVERRIDES = j.byCode || {};
        render(overridesScreen(OVERRIDES, ""));
      } }, "Вернуть как было"));
  });
  return [
    bar("Переопределения работ", "/admin"),
    el("main", { class: "wrap" },
      error ? el("p", { class: "small", style: "color:var(--warn)" }, error) : null,
      el("p", { class: "small muted" }, "Название/цену/усложнения работы или её скрытие правят прямо на экране диагностики (✎ / ✕ у неисправности). Здесь — только то, что уже изменено, с возможностью вернуть как было."),
      codes.length === 0 ? el("p", { class: "muted small" }, "Пока ничего не переопределено.") : el("div", { class: "list", style: "gap:12px" }, rows)),
  ];
}

// ---------------------------- мастера ---------------------------------------

async function loadMasters() {
  try {
    const r = await fetch("/api/users", { cache: "no-store" });
    const j = await r.json();
    if (location.hash !== "#/admin/masters") return;
    render(mastersScreen(r.ok ? j.users : [], r.ok ? "" : j.error || "ошибка"));
  } catch {
    if (location.hash === "#/admin/masters") render(mastersScreen([], "нет соединения"));
  }
}
function viewMasters() {
  loadMasters();
  return [bar("Мастера", "/admin"), el("main", { class: "wrap" }, skeletonRows())];
}

async function usersApi(method, body) {
  const r = await fetch("/api/users", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert(j.error || "ошибка"); return null; }
  return j;
}

function mastersScreen(list, error) {
  const addForm = el("form", {
    class: "card", onsubmit: async (ev) => {
      ev.preventDefault();
      const ok = await usersApi("POST", {
        name: ev.target.name.value.trim(), login: ev.target.login.value.trim().toLowerCase(),
        password: ev.target.password.value, role: ev.target.role.value,
      });
      if (ok) { ev.target.reset(); loadMasters(); }
    },
  },
    el("h2", {}, "Добавить мастера"),
    ...field("Имя", "name"), ...field("Логин", "login"), ...field("Пароль", "password", "password", "new-password"),
    el("label", {}, "Роль"),
    el("select", { name: "role" }, el("option", { value: "master" }, "мастер"), el("option", { value: "admin" }, "администратор")),
    el("div", { class: "btn-row", style: "margin-top:12px" }, el("button", { class: "btn-primary", type: "submit" }, "Добавить")));

  const rows = list.map((u) => {
    const card = el("div", { class: "card" },
      el("div", {}, u.name,
        u.role === "admin" ? el("span", { class: "pill" }, "админ") : null,
        !u.active ? el("span", { class: "pill" }, "отключён") : null),
      el("div", { class: "small muted" }, u.login));

    card.append(el("form", {
      style: "display:flex;gap:8px;margin-top:10px", onsubmit: async (ev) => {
        ev.preventDefault();
        const password = ev.target.password.value;
        if (!password) return;
        if (await usersApi("PUT", { id: u.id, password })) { ev.target.reset(); alert("Пароль обновлён"); }
      },
    },
      el("input", { name: "password", type: "password", placeholder: "новый пароль", style: "flex:1", autocomplete: "new-password" }),
      el("button", { type: "submit" }, "Сменить")));

    card.append(el("div", { class: "btn-row", style: "margin-top:10px" },
      el("button", { onclick: async () => { if (await usersApi("PUT", { id: u.id, active: !u.active })) loadMasters(); } },
        u.active ? "Отключить" : "Включить"),
      el("button", {
        class: "btn-warn", onclick: async () => {
          if (!confirm(`Удалить мастера «${u.name}»?`)) return;
          if (await usersApi("DELETE", { id: u.id })) loadMasters();
        },
      }, "Удалить")));
    return card;
  });

  return [
    bar("Мастера", "/admin"),
    el("main", { class: "wrap" },
      error ? el("p", { class: "small", style: "color:var(--warn)" }, error) : null,
      addForm,
      list.length === 0
        ? el("p", { class: "muted", style: "margin-top:12px" }, "Мастеров пока нет.")
        : el("div", { class: "list", style: "margin-top:12px;gap:12px" }, rows)),
  ];
}

// ---------------------------- остатки по запчастям ---------------------------

async function loadStock() {
  try {
    const r = await fetch("/api/stock", { cache: "no-store" });
    const j = await r.json();
    if (location.hash !== "#/admin/stock") return;
    render(stockScreen(r.ok ? j : { items: [], updatedAt: null }, r.ok ? "" : j.error || "ошибка"));
  } catch {
    if (location.hash === "#/admin/stock") render(stockScreen({ items: [], updatedAt: null }, "нет соединения"));
  }
}
function viewStock() {
  loadStock();
  return [bar("Остатки по запчастям", "/admin"), el("main", { class: "wrap" }, skeletonRows())];
}

async function saveStockItems(items) {
  const r = await fetch("/api/stock", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert(j.error || "ошибка"); return; }
  stockCache = null; // список мог измениться — сбросить кэш для выбора деталей в ремонте
  render(stockScreen(j, ""));
}

// Группы остатков — те же узлы, что и в диагностике (WHL/BRK/...), плюс
// мойка; по ним потом фильтруется подбор запчасти к конкретной работе.
const STOCK_GROUPS = [...diagBlocks.map((b) => ({ id: b.id, title: b.title })), { id: "WSH", title: "Мойка и консервация" }];

function stockScreen(data, error) {
  const items = (data.items || []).map((it) => ({ ...it }));
  const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleString("ru-RU") : null;
  let q = "";

  // Остатков может быть тысячи (реальная выгрузка из 1С) — рендерить сразу
  // все строки-с-полями браузер не потянет, поэтому редактор построчно
  // показывает только то, что нашлось по поиску.
  const searchInput = el("input", { type: "text", placeholder: "Поиск по названию или артикулу, чтобы отредактировать позицию" });
  const rowsBox = el("div", { class: "list" });
  const drawRows = () => {
    const ql = q.trim().toLowerCase();
    if (!ql) {
      rowsBox.replaceChildren(el("p", { class: "muted small" }, `Всего позиций: ${items.length}. Введите поиск, чтобы найти и отредактировать конкретную.`));
      return;
    }
    const matchedIdx = items
      .map((it, i) => ({ it, i }))
      .filter(({ it }) => it.name.toLowerCase().includes(ql) || (it.sku || "").toLowerCase().includes(ql))
      .slice(0, 60);
    if (!matchedIdx.length) { rowsBox.replaceChildren(emptyState("Ничего не найдено.", EMPTY_ICON_SEARCH)); return; }
    rowsBox.replaceChildren(...matchedIdx.map(({ it, i }) => el("div", { class: "price-row", style: "display:flex;gap:8px;align-items:center;flex-wrap:wrap" },
      el("input", { value: it.sku, style: "width:90px", placeholder: "артикул", onchange: (ev) => { items[i].sku = ev.target.value; } }),
      el("input", { value: it.name, style: "flex:1;min-width:120px", placeholder: "название", onchange: (ev) => { items[i].name = ev.target.value; } }),
      el("input", { type: "number", value: it.qty, style: "width:70px;text-align:right", placeholder: "остаток", onchange: (ev) => { items[i].qty = +ev.target.value || 0; } }),
      el("input", { value: it.unit, style: "width:60px", placeholder: "ед.", onchange: (ev) => { items[i].unit = ev.target.value; } }),
      el("input", { type: "number", value: it.price || 0, style: "width:80px;text-align:right", placeholder: "цена", onchange: (ev) => { items[i].price = +ev.target.value || 0; } }),
      el("select", { style: "width:auto", onchange: (ev) => { items[i].group = ev.target.value; } },
        el("option", { value: "", selected: !it.group }, "без узла"),
        STOCK_GROUPS.map((g) => el("option", { value: g.id, selected: it.group === g.id }, g.title))),
      el("button", { onclick: () => { items.splice(i, 1); drawRows(); } }, "✕"))));
  };
  drawRows();
  searchInput.addEventListener("input", (e) => { q = e.target.value; drawRows(); });

  const importArea = el("textarea", { rows: 4 });
  return [
    bar("Остатки по запчастям", "/admin"),
    el("main", { class: "wrap" },
      error ? el("p", { class: "small", style: "color:var(--warn)" }, error) : null,
      updated ? el("p", { class: "small muted" }, "Обновлено: " + updated) : null,
      el("div", { class: "card" },
        searchInput,
        el("div", { style: "margin-top:10px" }, rowsBox),
        el("button", { style: "margin-top:10px", onclick: () => { items.push({ sku: "", name: "", qty: 0, unit: "шт", price: 0, group: "" }); render(stockScreen({ items, updatedAt: data.updatedAt }, "")); } }, "+ строка"),
        el("div", { class: "btn-row", style: "margin-top:12px" },
          el("button", { class: "btn-primary", onclick: () => saveStockItems(items) }, "Сохранить"))),
      el("div", { class: "card" },
        el("h2", {}, "Импорт списком"),
        el("p", { class: "small muted" }, "Пока без прямой связи с 1С — вставьте выгрузку сюда, каждая позиция с новой строки: артикул;название;остаток;единица;цена;узел (WHL/BRK/BB/STR/FRM/DRV/WSH, можно пусто). Полностью заменит список выше."),
        importArea,
        el("div", { class: "btn-row", style: "margin-top:10px" },
          el("button", {
            onclick: () => {
              const parsed = importArea.value.split("\n").map((line) => line.split(";").map((s) => s.trim()))
                .filter((p) => p[0] || p[1])
                .map(([sku, name, qty, unit, price, group]) => ({ sku: sku || "", name: name || "", qty: Number(qty) || 0, unit: unit || "шт", price: Number(price) || 0, group: group || "" }));
              if (parsed.length) saveStockItems(parsed);
            },
          }, "Импортировать (заменит список)")))),
  ];
}
