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

const app = document.getElementById("app");
const money = (n) => `${Number(n || 0).toLocaleString("ru-RU")} ₽`;

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

const normalizeDB = (d) => ({
  clients: d?.clients || [], bikes: d?.bikes || [], orders: d?.orders || [],
  counters: { order: 0, bike: 0, ...(d?.counters || {}) },
});

let DB = normalizeDB(safeParse(localStorage.getItem(DB_KEY)));
let serverOK = false;
let pushTimer = null;
let dirty = false; // есть локальные правки, ещё не подтверждённые сервером
let autoOpenDiagsFor = null; // номер только что созданного обращения — сразу открыть диагностику
let editingItemCode = null; // код работы в наряде, у которой сейчас открыта форма редактирования

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
  if (JSON.stringify(DB) !== before && !location.hash.startsWith("#/orders/new")) router();
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
function itemRange(it) {
  const base = (it.workPrice || 0) * (it.qty || 1) + (it.partsPrice || 0);
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

// Список работ для «+ работа»: обычные операции из каталога + неисправности,
// заведённые админом вручную (catalog/repairs). Общий и для наряда, и для
// диагностики при оформлении нового обращения.
async function loadWorkPool(bikeKind) {
  const repairs = await ensureRepairs();
  return [
    ...billableOps
      .filter((p) => !OVERRIDES[p.code]?.hidden)
      .filter((p) => bikeKind !== "колесо" || WHEEL_ONLY_BLOCKS.includes(p.code.split("-")[0]))
      .map((p) => ({ code: p.code, name: OVERRIDES[p.code]?.name || p.name, custom: false })),
    ...repairs.map((r) => ({
      code: `CF-${r.id}`, name: r.label, label: r.label, custom: true, id: r.id,
      price: r.price, minutes: r.minutes, complications: r.complications, multiple: r.multiple,
    })),
  ];
}

// onPick получает объект {code, name, custom, ...} — обычную операцию из
// каталога или неисправность, заведённую админом вручную.
function openWorkPicker({ existingItems, bikeKind, onBack, onPick }) {
  const header = () => el("header", { class: "bar" },
    el("button", { class: "back", style: "border:0;background:none", onclick: onBack }, "‹"),
    el("h1", {}, "Добавить работу"));
  render([header(), el("main", { class: "wrap" }, el("p", { class: "muted" }, "Загрузка…"))]);
  loadWorkPool(bikeKind).then((pool) => {
    const host = el("main", { class: "wrap" });
    const q = el("input", { type: "text", placeholder: "поиск по коду или названию" });
    const listBox = el("div", { class: "rows", style: "margin-top:10px" });
    const draw = () => {
      const ql = q.value.trim().toLowerCase();
      listBox.replaceChildren(
        ...pool
          .filter((p) => !existingItems.some((i) => i.code === p.code))
          .filter((p) => !ql || p.code.toLowerCase().includes(ql) || p.name.toLowerCase().includes(ql))
          .map((p) => el("button", { class: "row", onclick: () => onPick(p) },
            el("span", { style: "flex:1" }, p.name), el("span", { class: "chev" }, "+"))),
      );
    };
    q.addEventListener("input", draw);
    host.append(q, listBox);
    draw();
    render([header(), host]);
  });
}

const STATUS_TAG_CLASS = {
  "приём": "tag-new", "оценка": "tag-quote", "согласование": "tag-approve",
  "в работе": "tag-progress", "проверка": "tag-check", "выдан": "tag-done",
};
const statusTag = (status) => el("span", { class: "tag " + (STATUS_TAG_CLASS[status] || "") }, status);

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

function homeLink(text, hash, icon) {
  return el("a", { class: "row", href: "#" + hash },
    icon ? el("span", { class: "row-icon", html: icon }) : null,
    el("span", { style: "flex:1" }, text), el("span", { class: "chev" }, "›"));
}

// Строка обращения в списке — код, велосипед/клиент, статус. Общая для
// главного экрана (активные) и полного списка «Обращения».
function orderRow(o, d) {
  const bike = d.bikes.find((b) => b.number === o.bikeNumber);
  const client = d.clients.find((c) => c.phone === o.clientPhone);
  return el("a", { class: "row", href: `#/orders/${o.number}` },
    el("span", { class: "code" }, o.number),
    el("span", { style: "flex:1;min-width:0" }, bike ? bikeLabel(bike) : o.bikeNumber,
      el("br"), el("span", { class: "small muted" }, client?.name || o.clientPhone),
      o.status === "в работе"
        ? el("span", { class: "small muted" }, " · " + (o.occupiedByName ? "занята: " + o.occupiedByName : "свободна"))
        : null),
    statusTag(o.status));
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
        ? el("p", { class: "muted small" }, "Активных обращений нет.")
        : el("div", { class: "rows" }, active.map((o) => orderRow(o, d))),
      el("a", { href: "#/orders", class: "small", style: "display:inline-block;margin-top:4px" }, "Все обращения, включая выданные ›"),
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
  phone: "+7 900 000-00-00", name: "Тест Тестов", kind: "шоссе",
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

function viewOrders() {
  const d = loadDB();
  const orders = [...d.orders]; // от старых к новым — работы по порядку поступления
  return [
    bar("Обращения", "/", el("span", { class: "sub", style: "display:flex;gap:14px" },
      el("button", { style: "border:0;background:none;color:inherit;font:inherit;cursor:pointer;padding:0", onclick: createDemoOrder }, "+ демо"),
      el("a", { href: "#/orders/new", style: "color:inherit" }, "+ новое"))),
    el("main", { class: "wrap" },
      orders.length === 0 ? el("p", { class: "muted" }, "Пока нет обращений.") : null,
      el("div", { class: "rows" }, orders.map((o) => orderRow(o, d)))),
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

  function stepAssess() {
    const redraw = () => render(build(), { keepScroll: true });
    function build() {
      const body = el("div", {});
      if (draft.items.length === 0) body.append(el("p", { class: "muted small" }, "Работ пока нет."));
      draft.items.forEach((it) => body.append(assessItem(it,
        (di, st) => { if (it.difficulties?.[di]) it.difficulties[di].state = st; redraw(); },
        (val) => { it.partsPrice = val; redraw(); },
        (qty) => { it.qty = qty; redraw(); })));
      body.append(
        el("div", { class: "card", style: "background:var(--bg)" },
          el("span", { class: "muted small" }, "Итого клиенту"),
          el("div", { class: "price-range" }, rangeText(orderRangeAll({ items: draft.items }))),
          minutesText(orderMinutes({ items: draft.items }, false)) ? el("div", { class: "small muted", style: "margin-top:4px" }, minutesText(orderMinutes({ items: draft.items }, false))) : null),
        el("button", { onclick: () => openWorkPicker({
          existingItems: draft.items, bikeKind: null, onBack: redraw,
          onPick: (pick) => {
            if (!draft.items.some((i) => i.code === pick.code)) draft.items.push(pick.custom ? makeCustomItem(pick) : makeItem(pick.code));
            redraw();
          },
        }) }, "+ работа"),
        el("button", { class: "btn-primary", style: "width:100%;margin-top:12px", onclick: () => stepConfirm() }, "Дальше — согласование"));
      return [bar("Новое обращение", "/"), el("main", { class: "wrap" }, stage("Оценка усложнений и стоимости", body))];
    }
    redraw();
  }

  function stepConfirm() {
    const redraw = () => render(build(), { keepScroll: true });
    function build() {
      const body = el("div", {});
      if (draft.items.length === 0) body.append(el("p", { class: "muted small" }, "Работ пока нет."));
      draft.items.forEach((it) => {
        const r = itemRange(it);
        body.append(el("label", { class: "opt" },
          el("input", { type: "checkbox", checked: it.agreed, onchange: (e) => { it.agreed = e.target.checked; redraw(); } }),
          el("span", { style: "flex:1" }, el("b", {}, it.name), it.multiple && (it.qty || 1) > 1 ? ` × ${it.qty}` : "", el("br"),
            el("span", { class: "small muted" }, rangeText(r)))));
      });
      body.append(
        el("div", { class: "card", style: "background:var(--bg)" },
          el("span", { class: "muted small" }, "Согласовано на"),
          el("div", { class: "price-range" }, rangeText(orderRange({ items: draft.items }))),
          minutesText(orderMinutes({ items: draft.items }, true)) ? el("div", { class: "small muted", style: "margin-top:4px" }, minutesText(orderMinutes({ items: draft.items }, true))) : null),
        el("button", { class: "btn-primary", style: "width:100%", onclick: () => stepClient() }, "Дальше — данные клиента"));
      return [bar("Новое обращение", "/"), el("main", { class: "wrap" }, stage("Согласование — что будем делать", body))];
    }
    redraw();
  }

  function stepClient() {
    const f = { phone: "+7 ", name: "", bike: "new", brand: "" };

    const clientSlot = el("div", {});
    const bikeSlot = el("div", { class: "card" }, el("h2", {}, "Велосипед"));
    const bikeFields = el("div", {});

    function drawClient() {
      const ec = loadDB().clients.find((c) => c.phone === f.phone.trim());
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
      const ec = loadDB().clients.find((c) => c.phone === f.phone.trim());
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

    const wrap = el("main", { class: "wrap" },
      draft.items.length ? el("p", { class: "small muted" }, `Согласовано работ: ${draft.items.filter((i) => i.agreed).length} из ${draft.items.length}.`) : null,
      el("div", { class: "card" }, el("h2", {}, "Клиент"),
        el("label", {}, "Телефон"),
        el("input", { type: "tel", value: f.phone, placeholder: "900 000-00-00", oninput: (e) => { f.phone = e.target.value; drawClient(); } }),
        clientSlot),
      bikeSlot);
    drawClient();

    render([
      bar("Новое обращение", "/"),
      wrap,
      el("div", { class: "actions" }, el("div", { class: "actions-inner" },
        el("button", { class: "btn-primary", onclick: () => {
          const p = f.phone.trim();
          if (!isValidPhone(p)) return alert("Проверьте номер телефона");
          editDB((d) => {
            if (!d.clients.some((c) => c.phone === p)) d.clients.push({ phone: p, name: f.name.trim() });
            let bn = f.bike;
            if (bn === "new" || !d.bikes.some((b) => b.number === bn)) {
              bn = nextBikeKey(d, p);
              d.bikes.push({ number: bn, brand: f.brand.trim(), model: "", ownerPhone: p });
            }
            const number = nextOrderNumber(d);
            d.orders.push({
              number, clientPhone: p, bikeNumber: bn, request: draft.request, diagnosticNotes: draft.diagnosticNotes,
              status: "в работе", items: draft.items, createdAt: new Date().toISOString(),
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
  const d = loadDB();
  const order = d.orders.find((o) => o.number === number);
  if (!order) return [bar(number, "/orders"), el("main", { class: "wrap" }, el("p", { class: "muted" }, "Не найдено"))];
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
  }
  function saveItemEdit(code, patch) {
    editItemQuiet(code, patch);
    editingItemCode = null;
    refresh();
  }

  // -- запуск диагностики / процедуры внутри обращения --
  function subBar(code) {
    return el("header", { class: "bar" },
      el("button", { class: "back", style: "border:0;background:none", onclick: refresh }, "‹"),
      el("h1", {}, order.number), el("span", { class: "sub" }, code));
  }
  function openDiagnostics() {
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
    const host = el("div", {});
    render([subBar(cat.byCode.get(code)?.name || code), host]);
    mountRunner(host, cat.byCode.get(code), { onDone: refresh });
  }
  function openPicker(onPick) {
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
      el("button", { class: "btn-primary", style: "width:100%", onclick: () => setStatus("в работе") }, "В работу"));
    main.append(stage("Согласование с клиентом", body));
  }

  if (order.status === "в работе") {
    const takeIntoWork = () => {
      editOrder(number, (o) => { o.occupiedBy = SESSION?.id || null; o.occupiedByName = SESSION?.name || ""; });
      refresh();
    };
    const leaveOrder = () => {
      editOrder(number, (o) => { o.occupiedBy = null; o.occupiedByName = ""; });
      go("/orders");
    };

    if (!order.occupiedBy) {
      main.append(stage("Ремонт",
        el("p", { class: "small muted" }, "Заявка свободна — заберите в работу, чтобы увидеть список работ."),
        el("button", { class: "btn-primary", style: "width:100%", onclick: takeIntoWork }, "Взять в работу")));
    } else if (order.occupiedBy !== SESSION?.id) {
      main.append(stage("Ремонт",
        el("p", { class: "small muted" }, `Заявку сейчас ведёт: ${order.occupiedByName || "другой мастер"}.`)));
    } else {
      const body = el("div", {}, el("p", { class: "small muted" }, "Загрузка…"));
      (async () => {
        const stock = await ensureStock();
        body.replaceChildren();
        order.items.filter((i) => i.agreed).forEach((it) => body.append(repairItem(it, stock, {
          onRun: () => openRunner(it.code),
          onSave: (patch) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === it.code); if (x) Object.assign(x, patch, { done: true }); }); refresh(); },
          onQty: (qty) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === it.code); if (x) x.qty = qty; }); refresh(); },
        })));
        body.append(el("button", { onclick: () => openPicker((pick) => { addItem(pick); editOrder(number, (o) => { const x = o.items.find((i) => i.code === pick.code); if (x) x.agreed = true; }); refresh(); }) }, "+ доп. работа"));
        body.append(el("button", { style: "margin-top:10px", onclick: leaveOrder }, "Завершить и выйти — освободить заявку"));
        const allDone = order.items.filter((i) => i.agreed).length > 0 && order.items.filter((i) => i.agreed).every((i) => i.done);
        if (allDone) body.append(el("button", { class: "btn-primary", style: "width:100%;margin-top:12px", onclick: () => setStatus("проверка", (o) => { o.finishedAt = new Date().toISOString(); o.occupiedBy = null; o.occupiedByName = ""; }) }, "На проверку"));
      })();
      main.append(stage("Ремонт", body));
    }
  }

  if (order.status === "проверка") {
    main.append(stage("Смета для звонка клиенту", itemList(order, true),
      el("div", { class: "card", style: "background:var(--bg);margin-top:12px" },
        el("span", { class: "muted small" }, "Итого"),
        el("div", { class: "total" }, rangeText(range)))));
    main.append(stage("Повторная диагностика",
      el("button", { class: "btn-primary", style: "width:100%", onclick: () => openDiagnostics() }, "Пройти повторную диагностику"),
      el("button", { class: "btn-ok", style: "width:100%;margin-top:10px", onclick: () => setStatus("выдан", (o) => (o.handedOverAt = new Date().toISOString())) }, "Выдать клиенту")));
  }

  if (order.status === "выдан") {
    main.append(stage("Выдан", itemList(order, true),
      el("div", { class: "card", style: "background:var(--bg)" },
        el("span", { class: "muted small" }, "Итого"),
        el("div", { class: "total" }, rangeText(range)))));
  }

  if (autoOpenDiagsFor === number && order.status === "приём" && order.items.length === 0) {
    autoOpenDiagsFor = null;
    queueMicrotask(openDiagnostics);
  }
  return [bar(order.number, "/orders", el("span", { class: "sub" }, order.status)), main];
}

function stage(title, ...body) { return el("div", { class: "card" }, el("h2", {}, title), ...body); }

function itemRow(it, showFacts) {
  const r = itemRange(it);
  return el("div", { class: "row", style: "cursor:default;align-items:flex-start" },
    el("span", { style: "flex:1" }, it.name,
      it.multiple && (it.qty || 1) > 1 ? el("span", { class: "small muted" }, ` × ${it.qty}`) : null,
      showFacts && !it.agreed ? el("span", { class: "pill", style: "background:var(--fill);color:var(--muted)" }, "не согласовано") : null,
      it.notes ? el("span", { class: "small muted" }, el("br"), it.notes) : null,
      showFacts && it.done && (it.parts.length || it.doneBy) ? el("span", { class: "small muted" }, el("br"),
        [it.parts.length ? it.parts.join(", ") : null, it.doneBy].filter(Boolean).join(" · ")) : null),
    el("span", { class: "small muted" }, rangeText(r)));
}

const iconBtnStyle = "border:0;background:none;color:var(--muted);cursor:pointer;padding:0 2px;min-height:auto;font:inherit";

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
      el("span", { class: "small muted", style: "flex:1" }, rangeText(r)),
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
function itemList(order, showFacts, edit) {
  if (order.items.length === 0) return el("p", { class: "muted small" }, "Работ пока нет.");
  const groups = groupBy(order.items, (it) => blockOf(it.code));
  const box = el("div", { style: "margin-top:8px" });
  for (const title of [...BLOCK_TITLES, "Прочее"]) {
    const list = groups.get(title);
    if (!list || !list.length) continue;
    box.append(
      el("p", { class: "small muted", style: "margin:14px 0 4px;letter-spacing:.05em" }, title.toUpperCase()),
      el("div", { class: "rows" }, list.map((it) => edit ? editableItemRow(it, edit) : itemRow(it, showFacts))));
  }
  return box;
}

// Список усложнений с выбором будет/не будет/неизвестно — используется и на
// «Оценке» (прикидка для клиента), и при отметке работы готовой (по факту).
function difficultyList(difficulties, onSet, onQty) {
  const box = el("div", {});
  (difficulties || []).forEach((d, di) => {
    box.append(el("div", { style: "margin-top:8px" },
      el("div", { class: "small" }, d.label, " ", el("span", { class: "muted" }, `(+${money(d.add)}${d.addMinutes ? `, +${d.addMinutes} мин` : ""})`)),
      el("div", { style: "display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:4px" },
        el("div", { class: "tri" },
          el("button", { class: d.state === "yes" ? "sel-yes" : "", onclick: () => onSet(di, "yes") }, "будет"),
          el("button", { class: d.state === "no" ? "sel-no" : "", onclick: () => onSet(di, "no") }, "не будет"),
          el("button", { class: d.state === "unknown" ? "sel-unk" : "", onclick: () => onSet(di, "unknown") }, "неизвестно")),
        d.multiple && onQty && d.state !== "no" ? qtyStepper(d.qty, (qty) => onQty(di, qty)) : null)));
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

function repairItem(it, stock, { onRun, onSave, onQty }) {
  const box = el("div", { class: "assess" });
  // Имя всегда на своей строке (любой длины, без конкуренции с кнопками), а
  // кнопки — отдельной строкой через .btn-row, чтобы они всегда были
  // одинакового размера и в одном порядке, независимо от длины названия.
  const nameRow = el("div", { style: "display:flex;align-items:center;gap:8px" },
    el("b", { style: "flex:1;min-width:0" }, it.name),
    it.done ? el("span", { class: "pill" }, "готово") : null);
  const controls = el("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:10px" });
  if (it.multiple) controls.append(qtyStepper(it.qty, onQty));
  const btnRow = el("div", { class: "btn-row", style: "flex:1;min-width:180px" });
  const form = el("div", { style: "margin-top:8px;display:none" });
  let open = false;
  const toggle = () => { open = !open; form.style.display = open ? "block" : "none"; };
  if (!it.done) {
    btnRow.append(
      el("button", { onclick: onRun }, "по шагам"),
      el("button", { class: "btn-primary", onclick: toggle }, "отметить"));
  } else {
    btnRow.append(el("button", { onclick: toggle }, "изменить"));
  }
  controls.append(btnRow);
  box.append(nameRow, controls);
  if (it.notes) box.append(el("p", { class: "small muted" }, it.notes));
  {
    const diffs = JSON.parse(JSON.stringify(it.difficulties || []));
    const diffBox = el("div", {});
    const drawDiffs = () => diffBox.replaceChildren(difficultyList(diffs,
      (di, st) => { diffs[di].state = st; drawDiffs(); },
      (di, qty) => { diffs[di].qty = qty; drawDiffs(); }));
    drawDiffs();
    const pickedParts = [...(it.parts || [])];
    const partsChips = el("div", {});
    const drawParts = () => {
      partsChips.replaceChildren(...(pickedParts.length
        ? [el("div", { style: "display:flex;flex-wrap:wrap;gap:6px;margin-top:6px" },
            pickedParts.map((p, i) => el("span", { class: "pill" }, p, " ",
              el("button", {
                style: "border:0;background:none;color:inherit;cursor:pointer;padding:0;min-height:auto;font:inherit",
                onclick: () => { pickedParts.splice(i, 1); drawParts(); },
              }, "✕"))))]
        : []));
    };
    drawParts();
    const stockSelect = el("select", { style: "width:auto;flex:1" },
      el("option", { value: "" }, stock.length ? "— выбрать деталь —" : "остатки пусты"),
      stock.map((s) => el("option", { value: s.sku || s.name },
        `${s.name}${s.sku ? " · " + s.sku : ""}${s.qty != null ? ` (${s.qty} ${s.unit || "шт"})` : ""}`)));
    form.append(
      diffs.length ? el("label", {}, "Усложнения по факту") : null,
      diffBox,
      el("label", {}, "Запчасти"),
      el("div", { style: "display:flex;gap:8px" },
        stockSelect,
        el("button", {
          style: "flex:0 0 auto",
          onclick: () => {
            const v = stockSelect.value;
            if (!v) return;
            const found = stock.find((s) => (s.sku || s.name) === v);
            const label = found ? found.name : v;
            if (!pickedParts.includes(label)) { pickedParts.push(label); drawParts(); }
          },
        }, "+ добавить")),
      partsChips,
      el("button", { class: "btn-ok", style: "width:100%;margin-top:10px", onclick: () => onSave({
        parts: pickedParts,
        difficulties: diffs,
        doneBy: it.doneBy ?? SESSION?.name ?? undefined,
      }) }, it.done ? "Сохранить" : "Готово"));
    box.append(form);
  }
  return box;
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
  const states = {}; // instId -> { state, faults:Set<number>, comment }
  const st = (id) => (states[id] ||= { state: "ok", faults: new Set(), comment: "" });
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
      el("p", { class: "small muted" }, "Все узлы по умолчанию «Норма». Отметь только те, где есть проблема."),
      ...DIAG_TOGGLES.map((t) => el("div", {},
        el("label", { class: "small muted", style: "margin-top:10px" }, t.label),
        el("div", { class: "segmented" },
          t.options.map(([v, lbl]) =>
            el("button", { class: toggles[t.param] === v ? "active" : "",
              onclick: () => { toggles[t.param] = v; draw(); } }, lbl))))),
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
        })));
    }

    for (const inst of list) {
      const s = st(inst.id);
      const card = el("div", { class: "card" },
        el("h2", {}, inst.label),
        el("p", { class: "small muted" }, inst.b.prompt),
        el("div", { class: "tri" },
          el("button", { class: s.state === "ok" ? "sel-no" : "", onclick: () => { s.state = "ok"; draw(); } }, "Норма"),
          el("button", { class: s.state === "problem" ? "sel-yes" : "", onclick: () => { s.state = s.state === "problem" ? "ok" : "problem"; draw(); } }, "Проблема")));

      if (s.state === "problem") {
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
                    style: "border:0;background:none;color:var(--muted);cursor:pointer;padding:0;min-height:auto;font:inherit",
                    onclick: () => { editingThis ? editOverrideFor.delete(editKey) : editOverrideFor.add(editKey); draw(); },
                  }, "✎")
                : null,
              isAdmin
                ? el("button", {
                    style: "border:0;background:none;color:var(--muted);cursor:pointer;padding:0;min-height:auto;font:inherit",
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
      if (s.state !== "problem") continue;
      const faults = blockFaults(inst.b);
      const noCode = [...s.faults].map((i) => faults[i]).filter(Boolean).filter(faultVisible).filter((f) => !f.code)
        .map((f) => [f.label, f.note].filter(Boolean).join(" — "));
      const c = (s.comment || "").trim();
      const parts = c ? [...noCode, c] : noCode;
      if (parts.length) notes.push(`${inst.label}: ${parts.join("; ")}`);
    }
    onDone(notes);
  }

  host.replaceChildren(el("main", { class: "wrap" }, el("p", { class: "muted" }, "Загрузка…")));
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
  return [bar("Переопределения работ", "/admin"), el("main", { class: "wrap" }, el("p", { class: "muted" }, "Загрузка…"))];
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
  return [bar("Мастера", "/admin"), el("main", { class: "wrap" }, el("p", { class: "muted" }, "Загрузка…"))];
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
  return [bar("Остатки по запчастям", "/admin"), el("main", { class: "wrap" }, el("p", { class: "muted" }, "Загрузка…"))];
}

async function saveStockItems(items) {
  const r = await fetch("/api/stock", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert(j.error || "ошибка"); return; }
  stockCache = null; // список мог измениться — сбросить кэш для выбора деталей в ремонте
  render(stockScreen(j, ""));
}

function stockScreen(data, error) {
  const items = (data.items || []).map((it) => ({ ...it }));
  const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleString("ru-RU") : null;

  const rows = items.map((it, i) => el("div", { class: "price-row", style: "display:flex;gap:8px;align-items:center" },
    el("input", { value: it.sku, style: "width:90px", placeholder: "артикул", onchange: (ev) => { items[i].sku = ev.target.value; } }),
    el("input", { value: it.name, style: "flex:1", placeholder: "название", onchange: (ev) => { items[i].name = ev.target.value; } }),
    el("input", { type: "number", value: it.qty, style: "width:70px;text-align:right", onchange: (ev) => { items[i].qty = +ev.target.value || 0; } }),
    el("input", { value: it.unit, style: "width:60px", placeholder: "ед.", onchange: (ev) => { items[i].unit = ev.target.value; } }),
    el("button", { onclick: () => saveStockItems(items.filter((_, j2) => j2 !== i)) }, "✕")));

  const importArea = el("textarea", { rows: 4 });
  return [
    bar("Остатки по запчастям", "/admin"),
    el("main", { class: "wrap" },
      error ? el("p", { class: "small", style: "color:var(--warn)" }, error) : null,
      updated ? el("p", { class: "small muted" }, "Обновлено: " + updated) : null,
      el("div", { class: "card" },
        rows.length ? el("div", { class: "list" }, rows) : el("p", { class: "muted small" }, "Пока пусто."),
        el("button", { style: "margin-top:10px", onclick: () => { items.push({ sku: "", name: "", qty: 0, unit: "шт" }); render(stockScreen({ items, updatedAt: data.updatedAt }, "")); } }, "+ строка"),
        el("div", { class: "btn-row", style: "margin-top:12px" },
          el("button", { class: "btn-primary", onclick: () => saveStockItems(items) }, "Сохранить"))),
      el("div", { class: "card" },
        el("h2", {}, "Импорт списком"),
        el("p", { class: "small muted" }, "Пока без прямой связи с 1С — вставьте выгрузку сюда, каждая позиция с новой строки: артикул;название;остаток;единица. Полностью заменит список выше."),
        importArea,
        el("div", { class: "btn-row", style: "margin-top:10px" },
          el("button", {
            onclick: () => {
              const parsed = importArea.value.split("\n").map((line) => line.split(";").map((s) => s.trim()))
                .filter((p) => p[0] || p[1])
                .map(([sku, name, qty, unit]) => ({ sku: sku || "", name: name || "", qty: Number(qty) || 0, unit: unit || "шт" }));
              if (parsed.length) saveStockItems(parsed);
            },
          }, "Импортировать (заменит список)")))),
  ];
}
