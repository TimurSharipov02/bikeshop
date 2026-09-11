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

// Блоки диагностики (catalog/diagnostics.json) + учебный слой (catalog/training.json).
const diagBlocks = RAW.diagnosticBlocks || [];
const training = RAW.training || {};
const BLOCK_TITLES = diagBlocks.map((b) => b.title);
const blockByPrefix = {};
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
const PRICE_KEY = "vella.prices.v1";

const normalizeDB = (d) => ({
  clients: d?.clients || [], bikes: d?.bikes || [], orders: d?.orders || [],
  counters: { order: 0, bike: 0, ...(d?.counters || {}) },
});

let DB = normalizeDB(safeParse(localStorage.getItem(DB_KEY)));
let serverOK = false;
let pushTimer = null;

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
    adopt(await r.json());
    if (!wasServerOK && !location.hash.startsWith("#/orders/new")) router();
  } catch { /* оффлайн — остаёмся на локальных данных */ }
}

function pushToServer() {
  if (typeof fetch !== "function") return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      const r = await fetch("/api/db", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(DB),
      });
      if (r.ok) { serverOK = true; adopt(await r.json()); }
    } catch { /* оффлайн — данные сохранены локально, отправятся позже */ }
  }, 250);
}

function saveDB(d) { DB = normalizeDB(d); writeLocal(); pushToServer(); }
function editDB(fn) { fn(DB); writeLocal(); pushToServer(); }
function editOrder(number, fn) {
  editDB((d) => { const o = d.orders.find((x) => x.number === number); if (o) fn(o); });
}

function loadPrices() {
  let over = {};
  try { over = JSON.parse(localStorage.getItem(PRICE_KEY) || "{}"); } catch {}
  const merged = JSON.parse(JSON.stringify(defaultPrices));
  for (const [k, v] of Object.entries(over)) merged[k] = v;
  return merged;
}
function savePrices(all) {
  const over = {};
  for (const [k, v] of Object.entries(all)) {
    if (JSON.stringify(v) !== JSON.stringify(defaultPrices[k])) over[k] = v;
  }
  localStorage.setItem(PRICE_KEY, JSON.stringify(over));
}
const priceOf = (code) => loadPrices()[code] || { work: 0 };

const yy = () => String(new Date().getFullYear()).slice(2);
const nextOrderNumber = (d) => (d.counters.order++, `V${yy()}-${String(d.counters.order).padStart(6, "0")}`);
// Велосипед привязан к телефону владельца (уникальный ключ клиента); у телефона
// может быть несколько велосипедов. Номер не показываем — только бренд/модель.
const nextBikeKey = (d, phone) => `${phone}#${d.bikes.filter((b) => b.ownerPhone === phone).length + 1}`;

// ---------------------------- расчёт цен ------------------------------------

function itemRange(it) {
  const base = (it.workPrice || 0) + (it.partsPrice || 0);
  let min = base, max = base + (it.spread || 0);
  for (const d of it.difficulties || []) {
    if (d.state === "yes") { min += d.add; max += d.add; }
    else if (d.state === "unknown") max += d.add;
  }
  return { min, max };
}
const orderRange = (o) =>
  o.items.filter((i) => i.agreed).reduce(
    (a, it) => { const r = itemRange(it); return { min: a.min + r.min, max: a.max + r.max }; },
    { min: 0, max: 0 });
const rangeText = (r) => (r.min === r.max ? money(r.min) : `${money(r.min)} – ${money(r.max)}`);
// Возможная вилка цены операции: от работы без надбавок до работы со всеми трудностями.
function codeRange(code) {
  const p = priceOf(code);
  const base = p.work || 0;
  const max = base + (p.spread || 0) + (p.difficulties || []).reduce((s, d) => s + (d.add || 0), 0);
  return { min: base, max };
}

function makeItem(code, notes = "") {
  const proc = cat.byCode.get(code);
  const price = priceOf(code);
  return {
    code, name: proc ? proc.name : code, agreed: false, done: false, parts: [], notes,
    workPrice: price.work || 0,
    spread: price.spread || 0,
    partsPrice: 0,
    difficulties: (price.difficulties || []).map((d) => ({ label: d.label, add: d.add, state: "unknown" })),
  };
}

const GROUP_TITLE = {
  DRV: "Трансмиссия", BRK: "Тормоза", WHL: "Колёса и покрышки", HUB: "Втулки и барабаны",
  STR: "Рулевая и кокпит", BB: "Каретка, шатуны, педали", FRM: "Рама", EL: "Электроника",
  WSH: "Мойка и консервация",
};
const billableOps = cat.procedures.filter(
  (p) => p.code && p.kind === "operation" && !["DIA-01", "DIA-01R"].includes(p.code));
const shortCheck = (t) => String(t).replace(/\s*[—-]\s*норма\?\s*$/i, "").trim();

const BIKE_KINDS = ["шоссе", "гревел", "хардтейл", "двухподвес", "детский", "любой другой"];
// Тип амортизации задаётся явно при оформлении — это только подсказка по умолчанию для типа.
const suspensionByKind = { "хардтейл": "вилка", "двухподвес": "полная" };
// Марка и модель — одно поле в форме; model может быть пустым (старые записи хранят раздельно).
const bikeLabel = (b) => (b ? [b.brand, b.model].filter(Boolean).join(" ") : "");

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
  [/^\/procedures\/([^/]+)$/, (m) => viewProcedure(m[1])],
  [/^\/procedures$/, viewProcedures],
  [/^\/prices$/, viewPrices],
  [/^\/profile$/, viewProfile],
  [/^\/admin$/, adminOnly(viewAdmin)],
  [/^\/admin\/masters$/, adminOnly(viewMasters)],
  [/^\/admin\/stock$/, adminOnly(viewStock)],
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
function render(nodes) {
  app.replaceChildren(...(Array.isArray(nodes) ? nodes.filter(Boolean) : [nodes]));
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", () => { router(); if (SESSION) syncFromServer(); });
(async () => {
  await loadSession();
  router();
  if (SESSION) syncFromServer();
})();

// ============================================================================
//  ЭКРАНЫ
// ============================================================================

const ICON_SVG = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  newOrder: ICON_SVG('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M12 11v6M9 14h6"/>'),
  orders: ICON_SVG('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9 11h6M9 15h6"/>'),
  procedures: ICON_SVG('<path d="M14.7 6.3a4 4 0 0 0-5.4 4.6L3 17l2 2 6.1-6.3a4 4 0 0 0 4.6-5.4l-2.6 2.6-2-2 2.6-2.6Z"/>'),
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

function viewHome() {
  return [
    el("header", { class: "bar" }, el("h1", {}, "Веломастерская Vella"),
      el("span", { class: "sub" }, SESSION?.name || SESSION?.login || "")),
    el("main", { class: "wrap" },
      el("div", { class: "list" },
        homeLink("Новое обращение", "/orders/new", ICONS.newOrder),
        homeLink("Обращения", "/orders", ICONS.orders),
        homeLink("Техпроцедуры", "/procedures", ICONS.procedures),
        homeLink("Прайс-лист", "/prices", ICONS.prices),
        SESSION?.role === "admin" ? homeLink("Админка", "/admin", ICONS.admin) : null,
        homeLink("Профиль", "/profile", ICONS.profile)),
      el("p", { class: "muted small", style: "margin-top:16px" },
        serverOK ? "Данные общие для всех устройств." : "Данные хранятся только в этом браузере.")),
  ];
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}

function viewProcedures() {
  const groups = groupBy(
    cat.procedures.filter((p) => p.code && p.kind === "operation" && !p.code.startsWith("DIA")),
    (p) => p.code.split("-")[0]);
  return [
    bar("Техпроцедуры", "/"),
    el("main", { class: "wrap" },
      [...groups].map(([g, list]) =>
        el("div", { class: "card" },
          el("h2", {}, GROUP_TITLE[g] || g),
          el("div", { class: "list" },
            list.map((p) =>
              el("a", { class: "row", href: `#/procedures/${p.code}` },
                el("span", { class: "code" }, p.code),
                el("span", {}, p.name),
                p.status !== "ready" ? el("span", { class: "tag" }, p.status) : null,
                el("span", { class: "chev" }, "›")))))),
    ),
  ];
}

function viewProcedure(code) {
  const proc = cat.byCode.get(code);
  if (!proc) return [bar(code, "/procedures"), el("main", { class: "wrap" }, el("p", { class: "muted" }, "Не найдено"))];
  const host = el("div", {});
  if (code.startsWith("DIA")) mountDiagnostics(host, { onDone: () => go("/procedures") });
  else mountRunner(host, proc, { onDone: () => go("/procedures") });
  return [bar(proc.code, "/procedures", el("span", { class: "sub" }, proc.name)), host];
}

function viewPrices() {
  const prices = loadPrices();
  const groups = groupBy(billableOps, (p) => blockOf(p.code));
  const wrap = el("main", { class: "wrap" },
    el("p", { class: "small muted" },
      "Работа + разброс. Трудности — надбавки: на оценке по каждой ставится будет / не будет / неизвестно. Запчасти — отдельной строкой в счёте, по остаткам. Значения черновые."));
  const numRow = (label, val, on, pad) => el("div", { style: `display:flex;gap:8px;align-items:center;margin-top:6px${pad ? ";padding-left:64px" : ""}` },
    el("span", { class: "small muted", style: "flex:1" }, label),
    el("input", { type: "number", value: val || 0, style: "width:88px;text-align:right", onchange: (ev) => on(+ev.target.value || 0) }),
    el("span", { class: "muted small" }, "₽"));
  for (const title of [...BLOCK_TITLES, "Прочее"]) {
    const list = groups.get(title);
    if (!list || !list.length) continue;
    const card = el("div", { class: "card" }, el("h2", {}, title));
    for (const p of list) {
      const e = prices[p.code] || { work: 0 };
      const row = el("div", { class: "price-row" },
        el("div", { style: "display:flex;gap:8px;align-items:center" },
          el("span", { class: "code" }, p.code),
          el("span", { style: "flex:1" }, p.name),
          el("input", {
            type: "number", value: e.work, style: "width:88px;text-align:right",
            onchange: (ev) => { const a = loadPrices(); a[p.code] = { ...(a[p.code] || {}), work: +ev.target.value || 0 }; savePrices(a); },
          }),
          el("span", { class: "muted small" }, "₽")),
        numRow("разброс (± в максимум)", e.spread, (v) => { const a = loadPrices(); a[p.code] = { ...(a[p.code] || {}), spread: v }; if (!v) delete a[p.code].spread; savePrices(a); }));
      (e.difficulties || []).forEach((d, i) =>
        row.append(el("div", { style: "display:flex;gap:8px;align-items:center;margin-top:6px;padding-left:64px" },
          el("span", { class: "small muted", style: "flex:1" }, "+ " + d.label),
          el("input", {
            type: "number", value: d.add, style: "width:88px;text-align:right",
            onchange: (ev) => {
              const a = JSON.parse(JSON.stringify(loadPrices()));
              if (a[p.code]?.difficulties?.[i]) { a[p.code].difficulties[i].add = +ev.target.value || 0; savePrices(a); }
            },
          }),
          el("span", { class: "muted small" }, "₽"))));
      card.append(row);
    }
    wrap.append(card);
  }
  return [
    bar("Прайс-лист", "/", el("button", { class: "sub", style: "border:0;background:none", onclick: () => { localStorage.removeItem(PRICE_KEY); router(); } }, "сброс")),
    wrap,
  ];
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
      el("div", { class: "list" },
        orders.map((o) => {
          const bike = d.bikes.find((b) => b.number === o.bikeNumber);
          const client = d.clients.find((c) => c.phone === o.clientPhone);
          return el("a", { class: "row", href: `#/orders/${o.number}` },
            el("span", { class: "code" }, o.number),
            el("span", {}, bike ? bikeLabel(bike) : o.bikeNumber,
              el("br"), el("span", { class: "small muted" }, client?.name || o.clientPhone),
              o.status === "в работе"
                ? el("span", { class: "small muted" }, " · " + (o.occupiedByName ? "занята: " + o.occupiedByName : "свободна"))
                : null),
            statusTag(o.status));
        }))),
  ];
}

function viewNewOrder() {
  // Запрос клиента и диагностика — уже внутри обращения, здесь только клиент и велосипед.
  const f = { phone: "+7 ", name: "", consent: true, bike: "new", kind: "шоссе", suspension: "нет", brand: "" };

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
            el("input", { type: "text", value: f.name, oninput: (e) => (f.name = e.target.value) }),
            el("label", { class: "opt", style: "margin-top:10px" },
              el("input", { type: "checkbox", checked: f.consent, onchange: (e) => (f.consent = e.target.checked) }),
              el("span", {}, "Согласие на обзвон"))),
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
        el("span", {}, bikeLabel(b) || "велосипед", el("span", { class: "small muted" }, " · " + b.kind))));
    }
    if (owned.length)
      bikeSlot.append(el("label", { class: "opt" },
        el("input", { type: "radio", name: "bike", checked: f.bike === "new", onchange: () => { f.bike = "new"; drawBike(); } }),
        el("span", {}, "Новый велосипед")));
    bikeFields.replaceChildren();
    if (f.bike === "new")
      bikeFields.append(
        el("label", {}, "Тип"),
        el("select", { onchange: (e) => { f.kind = e.target.value; f.suspension = suspensionByKind[f.kind] || "нет"; drawBike(); } },
          BIKE_KINDS.map((k) => el("option", { value: k, selected: f.kind === k }, k))),
        el("label", {}, "Тип амортизации"),
        el("select", { onchange: (e) => (f.suspension = e.target.value) },
          ["нет", "вилка", "полная"].map((s) => el("option", { value: s, selected: f.suspension === s }, s))),
        el("label", {}, "Марка и модель"),
        el("input", { type: "text", value: f.brand, oninput: (e) => (f.brand = e.target.value) }));
    bikeSlot.append(bikeFields);
  }

  const wrap = el("main", { class: "wrap" },
    el("div", { class: "card" }, el("h2", {}, "Клиент"),
      el("label", {}, "Телефон"),
      el("input", { type: "tel", value: f.phone, placeholder: "900 000-00-00", oninput: (e) => { f.phone = e.target.value; drawClient(); } }),
      clientSlot),
    bikeSlot);
  drawClient();

  return [
    bar("Новое обращение", "/"),
    wrap,
    el("div", { class: "actions" }, el("div", { class: "actions-inner" },
      el("button", { class: "btn-primary", onclick: () => {
        const p = f.phone.trim();
        if (!p) return alert("Введите телефон");
        let number = "";
        editDB((d) => {
          if (!d.clients.some((c) => c.phone === p)) d.clients.push({ phone: p, name: f.name.trim(), consentToCall: f.consent });
          let bn = f.bike;
          if (bn === "new" || !d.bikes.some((b) => b.number === bn)) {
            bn = nextBikeKey(d, p);
            d.bikes.push({ number: bn, kind: f.kind, suspension: f.suspension, brand: f.brand.trim(), model: "", ownerPhone: p });
          }
          number = nextOrderNumber(d);
          d.orders.push({ number, clientPhone: p, bikeNumber: bn, request: "", diagnosticNotes: [], status: "приём", items: [], createdAt: new Date().toISOString() });
        });
        go("/orders/" + number);
      } }, "Оформить обращение"))),
  ];
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
  const refresh = () => render(viewOrder(number));

  function addItem(code, notes = "") {
    editOrder(number, (o) => {
      const ex = o.items.find((i) => i.code === code);
      if (ex) { if (notes) ex.notes = ex.notes ? `${ex.notes}; ${notes}` : notes; return; }
      o.items.push(makeItem(code, notes));
    });
  }
  function onFaults(faults, comment, checkText) {
    const notes = [];
    for (const fa of faults) {
      if (fa.code) addItem(fa.code, [fa.label, fa.note, comment].filter(Boolean).join("; "));
      else notes.push([fa.label, comment].filter(Boolean).join(" — "));
    }
    if (faults.length === 0 && comment) notes.push(`${shortCheck(checkText)}: ${comment}`);
    if (notes.length) editOrder(number, (o) => { o.diagnosticNotes = [...(o.diagnosticNotes || []), ...notes]; });
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
      onFaults,
      onDone: refresh,
      suspension: bike?.suspension || (bike?.kind === "МТБ" ? "вилка" : "нет"),
      request: order.request || "",
      onRequest: (v) => editOrder(number, (o) => (o.request = v)),
    });
  }
  function openRunner(code) {
    const host = el("div", {});
    render([subBar(code), host]);
    mountRunner(host, cat.byCode.get(code), { onDone: refresh });
  }
  function openPicker(onPick) {
    const host = el("main", { class: "wrap" });
    const q = el("input", { type: "text", placeholder: "поиск по коду или названию" });
    const listBox = el("div", { class: "list", style: "margin-top:10px" });
    const draw = () => {
      const ql = q.value.trim().toLowerCase();
      listBox.replaceChildren(
        ...billableOps
          .filter((p) => !order.items.some((i) => i.code === p.code))
          .filter((p) => !ql || p.code.toLowerCase().includes(ql) || p.name.toLowerCase().includes(ql))
          .map((p) => el("button", { class: "row", onclick: () => { onPick(p.code); } },
            el("span", { class: "code" }, p.code), el("span", {}, p.name), el("span", { class: "chev" }, "+"))),
      );
    };
    q.addEventListener("input", draw);
    host.append(q, listBox);
    draw();
    render([
      el("header", { class: "bar" },
        el("button", { class: "back", style: "border:0;background:none", onclick: refresh }, "‹"),
        el("h1", {}, "Добавить работу")),
      host,
    ]);
  }

  const range = orderRange(order);
  const head = el("div", { class: "card" },
    el("h2", {}, bike ? `${bikeLabel(bike)} · ${bike.kind}`.trim() : "велосипед"),
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
  const setStatus = (s, extra) => { editOrder(number, (o) => { o.status = s; if (extra) extra(o); }); refresh(); };

  if (order.status === "приём") {
    main.append(stage("Диагностика и список работ",
      el("div", { class: "btn-row" },
        el("button", { class: "btn-primary", onclick: () => openDiagnostics() }, "Пройти диагностику"),
        el("button", { onclick: () => openPicker((code) => { addItem(code); refresh(); }) }, "+ работа")),
      itemList(order), order.items.length
        ? el("button", { class: "btn-primary", style: "width:100%;margin-top:12px", onclick: () => setStatus("оценка") }, "К оценке стоимости")
        : null));
  }

  if (order.status === "оценка") {
    const body = el("div", {},
      el("p", { class: "small muted" }, "По каждой возможной трудности: будет / не будет / неизвестно."));
    order.items.forEach((it) => body.append(assessItem(it,
      (di, st) => {
        editOrder(number, (o) => { const x = o.items.find((i) => i.code === it.code); if (x?.difficulties?.[di]) x.difficulties[di].state = st; });
        refresh();
      },
      (val) => {
        editOrder(number, (o) => { const x = o.items.find((i) => i.code === it.code); if (x) x.partsPrice = val; });
        refresh();
      })));
    body.append(
      el("div", { class: "card", style: "background:var(--bg)" },
        el("span", { class: "muted small" }, "Итого клиенту"),
        el("div", { class: "price-range" }, rangeText(range))),
      el("button", { onclick: () => openPicker((code) => { addItem(code); refresh(); }) }, "+ работа"),
      el("button", { class: "btn-primary", style: "width:100%;margin-top:12px", onclick: () => setStatus("согласование") }, "К согласованию"));
    main.append(stage("Оценка трудностей и стоимости", body));
  }

  if (order.status === "согласование") {
    const body = el("div", {});
    order.items.forEach((it) => {
      const r = itemRange(it);
      body.append(el("label", { class: "opt" },
        el("input", { type: "checkbox", checked: it.agreed, onchange: (e) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === it.code); if (x) x.agreed = e.target.checked; }); refresh(); } }),
        el("span", { style: "flex:1" }, el("b", {}, it.name), el("br"),
          el("span", { class: "small muted" }, `${it.code} · ${rangeText(r)}`))));
    });
    body.append(
      el("div", { class: "card", style: "background:var(--bg)" },
        el("span", { class: "muted small" }, "Согласовано на"),
        el("div", { class: "price-range" }, rangeText(range))),
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
        })));
        body.append(el("button", { onclick: () => openPicker((code) => { addItem(code); editOrder(number, (o) => { const x = o.items.find((i) => i.code === code); if (x) x.agreed = true; }); refresh(); }) }, "+ доп. работа"));
        body.append(el("button", { style: "margin-top:10px", onclick: leaveOrder }, "Завершить и выйти — освободить заявку"));
        const allDone = order.items.filter((i) => i.agreed).length > 0 && order.items.filter((i) => i.agreed).every((i) => i.done);
        if (allDone) body.append(el("button", { class: "btn-primary", style: "width:100%;margin-top:12px", onclick: () => setStatus("проверка", (o) => { o.finishedAt = new Date().toISOString(); o.occupiedBy = null; o.occupiedByName = ""; }) }, "На проверку"));
      })();
      main.append(stage("Ремонт", body));
    }
  }

  if (order.status === "проверка") {
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

  return [bar(order.number, "/orders", el("span", { class: "sub" }, order.status)), main];
}

function stage(title, ...body) { return el("div", { class: "card" }, el("h2", {}, title), ...body); }

function itemRow(it, showFacts) {
  const r = itemRange(it);
  return el("div", { class: "row", style: "cursor:default;align-items:flex-start" },
    el("span", { class: "code" }, it.code),
    el("span", { style: "flex:1" }, it.name,
      it.notes ? el("span", { class: "small muted" }, el("br"), it.notes) : null,
      showFacts && it.done && (it.parts.length || it.doneBy) ? el("span", { class: "small muted" }, el("br"),
        [it.parts.length ? it.parts.join(", ") : null, it.doneBy].filter(Boolean).join(" · ")) : null),
    el("span", { class: "small muted" }, rangeText(r)));
}

// Наряд сгруппирован по узлам велосипеда (блоки диагностики), порядок — как в diagnostics.json.
function itemList(order, showFacts) {
  if (order.items.length === 0) return el("p", { class: "muted small" }, "Работ пока нет.");
  const groups = groupBy(order.items, (it) => blockOf(it.code));
  const box = el("div", { style: "margin-top:8px" });
  for (const title of [...BLOCK_TITLES, "Прочее"]) {
    const list = groups.get(title);
    if (!list || !list.length) continue;
    box.append(
      el("p", { class: "small muted", style: "margin:14px 0 4px;letter-spacing:.05em" }, title.toUpperCase()),
      el("div", { class: "list" }, list.map((it) => itemRow(it, showFacts))));
  }
  return box;
}

function assessItem(it, onSet, onParts) {
  const cost = "работа " + money(it.workPrice || 0);
  const box = el("div", { class: "assess" },
    el("div", {}, el("b", {}, it.name), " ", el("span", { class: "small muted" }, "· " + cost)));
  box.append(el("div", { style: "display:flex;gap:8px;align-items:center;margin-top:6px" },
    el("span", { class: "small muted", style: "flex:1" }, "Запчасти (детали) в счёт"),
    el("input", { type: "number", value: it.partsPrice || 0, style: "width:96px;text-align:right",
      onchange: (e) => onParts(+e.target.value || 0) }),
    el("span", { class: "muted small" }, "₽")));
  if ((it.difficulties || []).length === 0) box.append(el("p", { class: "small muted" }, "Трудностей не ожидается."));
  (it.difficulties || []).forEach((d, di) => {
    box.append(el("div", { style: "margin-top:8px" },
      el("div", { class: "small" }, d.label, " ", el("span", { class: "muted" }, `(+${money(d.add)})`)),
      el("div", { class: "tri", style: "margin-top:4px" },
        el("button", { class: d.state === "yes" ? "sel-yes" : "", onclick: () => onSet(di, "yes") }, "будет"),
        el("button", { class: d.state === "no" ? "sel-no" : "", onclick: () => onSet(di, "no") }, "не будет"),
        el("button", { class: d.state === "unknown" ? "sel-unk" : "", onclick: () => onSet(di, "unknown") }, "неизвестно"))));
  });
  const r = itemRange(it);
  box.append(el("div", { class: "small", style: "margin-top:8px" }, "Вилка: ", el("b", {}, rangeText(r))));
  return box;
}

function repairItem(it, stock, { onRun, onSave }) {
  const box = el("div", { class: "assess" });
  const top = el("div", { style: "display:flex;gap:8px;align-items:center" },
    el("span", { style: "flex:1" }, el("b", {}, it.name), " ", el("span", { class: "small muted" }, it.code),
      it.done ? el("span", { class: "pill", style: "margin-left:6px" }, "готово") : null));
  const form = el("div", { style: "margin-top:8px" });
  let open = false;
  if (!it.done) {
    top.append(
      el("button", { onclick: onRun }, "по шагам"),
      el("button", { class: "btn-primary", onclick: () => { open = !open; form.style.display = open ? "block" : "none"; } }, "отметить"));
  }
  box.append(top);
  if (it.notes) box.append(el("p", { class: "small muted" }, it.notes));
  if (!it.done) {
    form.style.display = "none";
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
        doneBy: it.doneBy ?? SESSION?.name ?? undefined,
      }) }, "Готово"));
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
          el("h2", {}, `${proc.code} · ${proc.name}`),
          proc.entry ? el("p", { class: "small muted" }, "Вход: " + proc.entry) : null,
          proc.tools ? el("p", { class: "small muted" }, "Инструмент: " + proc.tools) : null,
          proc.consumables ? el("p", { class: "small muted" }, "Расходники: " + proc.consumables) : null),
        el("div", { class: "card" },
          el("label", {}, "Режим показа"),
          el("div", { class: "btn-row" },
            ["master", "standard", "training"].map((m) =>
              el("button", { class: mode === m ? "btn-primary" : "", onclick: () => { mode = m; draw(); } }, MODE_LABEL[m]))),
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
    enterCall(t, note) { log.push({ k: "call", t: `${t.code} · ${t.name}${note ? " — " + note : ""}` }); },
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

function mountDiagnostics(host, { onFaults, onDone, suspension, request = "", onRequest }) {
  let sus = suspension || "нет"; // нет | вилка | полная
  let req = request;
  let mode = "master"; // master | training
  const states = {}; // instId -> { state, faults:Set<number>, comment }
  const openRef = new Set();
  const st = (id) => (states[id] ||= { state: "ok", faults: new Set(), comment: "" });

  const instances = () => {
    const out = [];
    for (const b of diagBlocks) {
      if (b.showIf === "подвеска" && sus === "нет") continue;
      if (b.perSide) {
        out.push({ b, id: b.id + ".F", label: `${b.title} · перед` });
        out.push({ b, id: b.id + ".R", label: `${b.title} · зад` });
      } else out.push({ b, id: b.id, label: b.title });
    }
    return out;
  };
  const blockFaults = (b) => b.sections.flatMap((s) => s.faults.map((f) => ({ ...f, section: s.title })));

  function draw() {
    const list = instances();
    const wrap = el("main", { class: "wrap" });

    wrap.append(el("div", { class: "card" },
      el("h2", {}, "Диагностика"),
      el("p", { class: "small muted" }, mode === "master"
        ? "Все узлы по умолчанию «Норма». Отметь только те, где есть проблема."
        : "По каждому узлу — «Норма» или «Проблема»; в проблеме доступна справка по неисправностям."),
      el("div", { class: "btn-row" },
        [["master", "Мастер"], ["training", "Обучение"]].map(([m, lbl]) =>
          el("button", { class: mode === m ? "btn-primary" : "", onclick: () => { mode = m; draw(); } }, lbl))),
      el("label", { class: "small muted", style: "margin-top:10px" }, "Подвеска на велосипеде"),
      el("div", { class: "btn-row" },
        [["нет", "нет"], ["вилка", "вилка"], ["полная", "вилка + аморт"]].map(([v, lbl]) =>
          el("button", { class: sus === v ? "btn-primary" : "", onclick: () => { sus = v; draw(); } }, lbl))),
      onRequest ? el("label", { class: "small muted", style: "margin-top:10px" }, "Запрос клиента (со слов)") : null,
      onRequest ? el("textarea", { rows: 2, value: req, placeholder: "с чем пришёл",
        onchange: (e) => { req = e.target.value.trim(); onRequest(req); } }) : null));

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
        let sec = null;
        faults.forEach((f, i) => {
          if (mode === "training" && f.section !== sec) {
            sec = f.section;
            fb.append(el("p", { class: "small muted", style: "margin:10px 0 2px" }, sec));
          }
          fb.append(el("label", { class: "opt" },
            el("input", { type: "checkbox", checked: s.faults.has(i),
              onchange: () => { s.faults.has(i) ? s.faults.delete(i) : s.faults.add(i); } }),
            el("span", {}, f.label,
              f.code ? el("span", { class: "pill" }, `${f.code} · ${rangeText(codeRange(f.code))}`) : null)));
          if (mode === "training") {
            const key = inst.id + "#" + i;
            const t = training[f.label];
            fb.append(el("button", { class: "small hint-toggle",
              onclick: () => { openRef.has(key) ? openRef.delete(key) : openRef.add(key); draw(); } },
              (openRef.has(key) ? "▾ " : "▸ ") + "справка"));
            if (openRef.has(key)) {
              const rows = t && (t.how || t.signs || t.means)
                ? [t.how && "Как проверить: " + t.how, t.signs && "Признаки: " + t.signs, t.means && "Что значит: " + t.means].filter(Boolean)
                : ["Материал появится позже."];
              rows.forEach((r) => fb.append(el("div", { class: "note" }, r)));
            }
          }
        });
        fb.append(el("input", { type: "text", placeholder: "комментарий", value: s.comment,
          style: "margin-top:6px", oninput: (e) => (s.comment = e.target.value) }));
        card.append(fb);
      }
      wrap.append(card);
    }

    const problems = list.filter((i) => st(i.id).state === "problem").length;
    host.replaceChildren(wrap,
      el("div", { class: "actions" }, el("div", { class: "actions-inner" },
        el("span", { class: "small muted", style: "flex:0 0 auto;align-self:center" }, `проблемных узлов: ${problems}`),
        el("button", { class: "btn-primary", onclick: finish }, "Готово"))));
  }

  function finish() {
    for (const inst of instances()) {
      const s = st(inst.id);
      if (s.state !== "problem") continue;
      const faults = blockFaults(inst.b);
      const picked = [...s.faults].map((i) => faults[i]).filter(Boolean)
        .map((f) => ({ label: f.label, code: f.code, note: f.note }));
      onFaults?.(picked, (s.comment || "").trim(), inst.label);
    }
    onDone();
  }

  draw();
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
      el("div", { class: "list" },
        homeLink("Мастера", "/admin/masters", ICONS.masters),
        homeLink("Остатки по запчастям", "/admin/stock", ICONS.stock))),
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
