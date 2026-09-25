// ============================================================================
//  Веломастерская Veloterra — экраны и роутер.
//  Обычный JavaScript. Ни сборщиков, ни фреймворков — npm run build просто
//  склеивает несколько файлов в один <script> (см. scripts/build-html.js).
//
//    CATALOG  — узлы велосипеда для группировки работ (вшиты в HTML при сборке)
//    DB       — обращения, клиенты, велосипеды (localStorage браузера + /api/db)
//
//  Устройство по файлам:
//    dom.js     — el/bar/toast/openSheet: строительные блоки интерфейса,
//                 без бизнес-логики.
//    store.js   — данные: DB/BASE, синхронизация с сервером, сессия,
//                 кэш серверных справочников (остатки, работы, мастера).
//    pricing.js — общая формула цены работы (используется и тут, и в
//                 выгрузке для 1С).
//    order-calc.js — цена/время работы и статус заявки (готово/ждёт
//                 запчасть): чистые функции, покрыты юнит-тестами напрямую
//                 (tests/order-calc.test.js), без браузера.
//    app.js (этот файл) — роутер и все экраны (view*): строят DOM из
//                 данных store.js и примитивов dom.js.
//
//  Как всё устроено:
//    1. Роутер смотрит на #адрес и вызывает нужный экран (view*).
//    2. Экран строит DOM и кладёт его в #app.
//
//  Все ремонтные работы заводит администратор вручную через приложение
//  (catalog/repairs, /api/repairs) — старый встроенный каталог процедур
//  ранней версии приложения (catalog/*.proc) удалён целиком.
// ============================================================================

import { itemWorkValue } from "./pricing.js";
import { matchesQuery } from "./search.js";
import { reportEntries } from "./report-entries.js";
import { app, money, iconBtnStyle, toast, closeAllSheets, openSheet, el, bar, backLink, setBackHandler } from "./dom.js";
import {
  quantityModeOf, usesQuantity, repeatsWholeItem, WORK_INSTANCE_LIMIT, WORK_QUANTITY_LIMIT,
  instanceLimitOf, workQuantityLimitOf, itemRange, itemPartsCost, itemMinutes, orderRange, orderRangeAll, orderMinutes,
  orderAllDone, orderWaitingForPart, orderPausedForPart, orderHasFreeWork, waitingLast, orderWaitingLast, customFaultRange,
} from "./order-calc.js";
import {
  dirty, setInSubScreen,
  SESSION, NEEDS_SETUP, authAction, loadSession, logout,
  repairsCache, clearRepairsCache, ensureRepairs,
  clearUsersCache, ensureUsers, usersCache, primeUsersCache,
  stockCache, clearStockCache, ensureStock,
  loadDB, syncFromServer,
  editDB, editOrder, deleteOrderApi, deleteClientApi, deleteBikeApi, pushDbNow, flushPending,
  reopenOrderApi, restoreOrder,
} from "./store.js";

const RAW = window.CATALOG;
// Версия — время сборки страницы (проставляется при npm run build / деплое).
const BUILD_TIME = RAW.generatedAt
  ? new Date(RAW.generatedAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
  : "";

// Блоки узлов велосипеда из catalog/diagnostics.json используются как
// структура каталога работ: колёса, тормоз, каретка и т.д.
// Мойка не диагностируется, но пусть тоже группируется по-человечески, а не в «Прочее».
const diagBlocks = RAW.diagnosticBlocks || [];
const BLOCK_TITLES = [...diagBlocks.map((b) => b.title), "Мойка и консервация"];
const blockByPrefix = { WSH: "Мойка и консервация" };
for (const b of diagBlocks) for (const pre of b.codes || []) blockByPrefix[pre] = b.title;
const blockOf = (code) => blockByPrefix[String(code || "").split("-")[0]] || "Прочее";
// То же самое, но id блока (WHL/BRK/...), а не название — для группировки
// запчастей по узлу: у какой работы какие детали предлагать первыми.
const blockIdByPrefix = { WSH: "WSH" };
for (const b of diagBlocks) for (const pre of b.codes || []) blockIdByPrefix[pre] = b.id;
const blockIdOf = (code) => blockIdByPrefix[String(code || "").split("-")[0]] || "";
// Свои неисправности (catalog/repairs) привязаны к узлу напрямую через group
// (id блока), а не через префикс кода (у них у всех один и тот же CF-N) —
// их так по коду не сгруппировать, нужно смотреть group на самом пункте.
const blockTitleById = Object.fromEntries([...diagBlocks, { id: "WSH", title: "Мойка и консервация" }].map((b) => [b.id, b.title]));
// it.group — на самом пункте наряда (проставляется при добавлении, см.
// makeCustomItem); но у пунктов, добавленных ДО того как это поле завели,
// его нет — тогда для своих неисправностей (CF-id) смотрим узел в текущем
// каталоге repairsCache по id по названию, а не по коду (см. viewOrder,
// где кэш прогревается заранее).
const partBlockIdOf = (it) => {
  if (it.group) return it.group;
  if (it.code && it.code.startsWith("CF-")) {
    const r = (repairsCache || []).find((x) => `CF-${x.id}` === it.code);
    if (r && r.group) return r.group;
  }
  return blockIdOf(it.code);
};

const yy = () => String(new Date().getFullYear()).slice(2);
// Локальный счётчик одинаков на двух устройствах, поэтому для новых записей
// используем случайный ключ. Старые номера и ссылки на них сохраняются.
const uniqueSuffix = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
const nextOrderNumber = () => `V${yy()}-${uniqueSuffix()}`;
// Велосипед привязан к телефону владельца (уникальный ключ клиента); у телефона
// может быть несколько велосипедов. Номер не показываем — только бренд/модель.
const nextBikeKey = (_d, phone) => `${phone}#${uniqueSuffix()}`;

// ---------------------------- расчёт цен ------------------------------------
//
// itemRange/itemMinutes/orderRange и статус заявки (готово/ждёт запчасть) —
// в web/order-calc.js: чистые функции без DOM, проверяются юнит-тестами
// напрямую (см. tests/order-calc.test.js), без браузера.

// Пункт наряда неделим — его делает один мастер целиком, от начала до конца
// (qty > 1, если стоит «несколько», влияет только на цену/время, не на то,
// сколько человек его выполняли). Если работу реально нужно поделить между
// несколькими мастерами — она оформляется отдельными позициями наряда, а не
// дележом одной (см. instanceCode ниже и openRepairSheet).
// Стоимость самой работы (без запчастей) — то, на что начисляется процент
// мастера: цена работы за все качественные единицы плюс подтвердившиеся
// усложнения. Запчасти — расходники, в доход мастера не идут.
const completionsSummary = (it) => it.doneBy?.masterName || "";
// «Код» позиции наряда, добавляемой не из каталога напрямую, а как копия
// уже существующей работы (кнопка «+ ещё раз» — когда реально нужен второй
// мастер) или как материализованное усложнение (см. openRepairSheet). Метка
// времени + случайный хвост — коллизии с обычными кодами каталога и друг с
// другом на практике исключены, без необходимости смотреть на весь список
// позиций заявки.
const instanceCode = (base) => `${base}~${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const rangeText = (r) => (r.min === r.max ? money(r.min) : `${money(r.min)} – ${money(r.max)}`);
// Компактный вид предварительной цены: вместо тяжёлой вилки «600–1 200 ₽»
// показываем базовую сумму и знак «+», если возможны усложнения.
const rangePlusText = (r) => r.min === r.max ? money(r.min) : `${Number(r.min || 0).toLocaleString("ru-RU")}+ ₽`;
function minutesText(m) {
  if (!m) return null;
  const h = Math.floor(m / 60), mm = m % 60;
  return "ориентировочно " + (h ? `${h} ч${mm ? " " + mm + " мин" : ""}` : `${mm} мин`);
}

// Неисправность, заведённая администратором вручную (без кода .proc-процедуры) —
// цена/время/усложнения лежат прямо в ней самой.
function makeCustomItem(fa, notes = "") {
  return {
    code: fa.code, name: fa.label, group: fa.group || "", agreed: false, done: false, parts: [], notes,
    workPrice: fa.price || 0,
    estimateMinutes: fa.minutes || 0,
    partsPrice: 0,
    quantityMode: quantityModeOf(fa), maxInstances: instanceLimitOf(fa),
    multiple: quantityModeOf(fa) === "quantity", qty: 1,
    difficulties: (fa.complications || []).map((c) => ({ label: c.label, add: c.add, addMinutes: c.addMinutes || 0, multiple: !!c.multiple, qty: 1, state: "no" })),
  };
}

const BIKE_KINDS = ["шоссе", "гревел", "хардтейл", "двухподвес", "детский", "колесо", "любой другой"];
// Одна строка на весь велосипед («Stels Navigator», «BMX жёлтый» — как
// удобно, без отдельных полей марка/модель), см. migrateBikes для старых
// записей, где марка и модель ещё хранились раздельно.
const bikeLabel = (b) => b?.name || "";
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
  // Подсказки из контактов айфона тут не нужны: text + inputmode=tel даёт
  // ту же цифровую клавиатуру, но iOS реже распознаёт поле как «телефон».
  input.type = "text";
  input.inputMode = "tel";
  input.autocomplete = "off";
  input.addEventListener("input", () => {
    const before = input.value;
    const caret = input.selectionStart ?? before.length;
    // Считаем только цифры самого номера, без кода страны: в маске «+7»
    // есть всегда, а в набранном тексте его может не быть (первая цифра
    // в пустое поле) — иначе курсор вставал перед только что набранной.
    const typedDigits = before.replace(/\D/g, "");
    const hasCountryCode = typedDigits[0] === "7" || typedDigits[0] === "8";
    const digitsBeforeCaret = Math.max(0, before.slice(0, caret).replace(/\D/g, "").length - (hasCountryCode ? 1 : 0));
    const value = applyPhoneMask(before);
    input.value = value;
    let seen = 0, pos = 2; // сразу после «+7»
    for (let i = 2; i < value.length && seen < digitsBeforeCaret; i++) {
      if (/\d/.test(value[i]) && ++seen === digitsBeforeCaret) pos = i + 1;
    }
    input.setSelectionRange(pos, pos);
    onChange(value);
  });
}

// Список работ для «+ работа»: только работы, заведённые администратором
// вручную (catalog/repairs). Старый встроенный каталог процедур больше не
// подмешиваем: он остался от ранней версии приложения и не должен появляться
// при создании новых нарядов. Уже созданные наряды это не меняет.
async function loadWorkPool(bikeKind) {
  const repairs = await ensureRepairs();
  return repairs.map((r) => ({
    code: `CF-${r.id}`, name: r.label, label: r.label, custom: true, id: r.id, group: r.group,
    price: r.price, minutes: r.minutes, complications: r.complications,
    quantityMode: quantityModeOf(r), maxInstances: instanceLimitOf(r),
  }));
}

// onPick получает объект {code, name, custom, ...} — обычную операцию из
// каталога или неисправность, заведённую админом вручную.
function openWorkPicker({ existingItems, bikeKind, onBack, onPick, allowDuplicates = false }) {
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
    // Разовая услуга «вне блоков» — быстрое создание прямо тут, без захода в
    // диагностику. Только для этого наряда: не заводится в общий каталог,
    // сразу отдаётся в onPick тем же способом, что и выбор обычной работы.
    let creating = false;
    const draftFa = { label: "", price: 0, minutes: 0 };
    const createBox = el("div", { style: "margin-top:10px" });
    const drawCreate = () => {
      if (!creating) return createBox.replaceChildren();
      createBox.replaceChildren(el("div", { class: "card card-flush" },
        el("label", {}, "Название разовой услуги"),
        el("input", { placeholder: "напр. Мойка велосипеда", value: draftFa.label, oninput: (e) => (draftFa.label = e.target.value) }),
        el("div", { style: "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px" },
          el("div", { style: "flex:1;min-width:120px" }, el("label", {}, "Цена, ₽"), el("input", { type: "number", oninput: (e) => (draftFa.price = +e.target.value || 0) })),
          el("div", { style: "flex:1;min-width:120px" }, el("label", {}, "Минуты"), el("input", { type: "number", oninput: (e) => (draftFa.minutes = +e.target.value || 0) }))),
        el("div", { class: "btn-row", style: "margin-top:10px" },
          el("button", { class: "btn-primary", onclick: () => {
            if (!draftFa.label.trim()) return alert("Укажите название");
            onPick({
              code: `MISC-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
              name: draftFa.label.trim(), label: draftFa.label.trim(), custom: true,
              price: draftFa.price, minutes: draftFa.minutes, complications: [], multiple: false,
            });
          } }, "Создать и добавить"),
          el("button", { onclick: () => { creating = false; drawCreate(); } }, "Отмена"))));
    };
    const createToggle = el("button", {
      class: "small", style: "margin-top:10px;border:0;background:none;color:var(--muted);text-decoration:underline;padding:0",
      onclick: () => { creating = !creating; drawCreate(); },
    }, "+ разовая услуга");
    const draw = () => {
      const ql = q.value.trim().toLowerCase();
      const rows = pool
        .filter((p) => allowDuplicates || !existingItems.some((i) => (i.sourceCode || i.code) === p.code))
        .filter((p) => !ql || matchesQuery(ql, p.code, p.name));
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
    host.append(q, listBox, createToggle, createBox);
    draw();
    render([header(), host]);
  });
}

const STATUS_TAG_CLASS = {
  "приём": "tag-new", "согласование": "tag-approve",
  "взята в работу": "tag-progress", "выдан": "tag-done",
};
const statusTag = (status) => el("span", { class: "tag " + (STATUS_TAG_CLASS[status] || "") }, status);
// «Взята в работу» — сырой статус ничего не говорит о том, что реально
// происходит с заявкой в списке, поэтому тут не он, а более точная метка:
// все работы готовы — «Готово к выдаче» (это важнее, чем занята она или
// нет — надо звонить клиенту); иначе, без хозяина (только что оформлена
// или освобождена кнопкой «Выйти») — «Свободна».
const orderStatusTag = (o) => {
  if (o.status === "взята в работу" && orderAllDone(o)) return el("span", { class: "tag tag-check" }, "Готова к выдаче");
  if (o.status === "взята в работу" && orderPausedForPart(o)) return el("span", { class: "tag tag-block" }, "Ожидает запчасть");
  if (o.status === "взята в работу" && orderHasFreeWork(o)) return el("span", { class: "tag tag-new" }, "Свободна");
  if (o.status === "взята в работу") return el("span", { class: "tag tag-progress" }, "В работе");
  return statusTag(o.status);
};

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
  [/^\/profile$/, viewProfile],
  [/^\/profile\/report$/, () => masterReportScreen(SESSION?.id, "/profile")],
  [/^\/profile\/settings$/, viewSettings],
  [/^\/admin$/, adminOnly(viewAdmin)],
  [/^\/admin\/masters$/, adminOnly(viewMasters)],
  [/^\/admin\/clients$/, adminOnly(viewClients)],
  [/^\/admin\/clients\/([^/]+)\/bikes\/([^/]+)$/, adminOnly((m) => viewClientDetails(decodeURIComponent(m[1]), decodeURIComponent(m[2])))],
  [/^\/admin\/clients\/([^/]+)$/, adminOnly((m) => viewClientDetails(decodeURIComponent(m[1])))],
  [/^\/admin\/reports$/, adminOnly(viewAllMastersReport)],
  [/^\/admin\/reports\/([^/]+)$/, adminOnly((m) => masterReportScreen(m[1], "/admin/masters"))],
  [/^\/admin\/stock$/, adminOnly(viewStock)],
  [/^\/admin\/1c$/, adminOnly(view1cSync)],
];
function router() {
  closeAllSheets();
  setInSubScreen(false); // хеш-навигация всегда уводит из любого экрана мимо router()
  if (!SESSION) return render(NEEDS_SETUP ? viewSetup() : viewLogin());
  const path = location.hash.replace(/^#/, "") || "/";
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) return render(fn(m));
  }
  render(viewHome());
}
const go = (hash) => { location.hash = hash; };

// «Назад» — всегда на тот экран, где был только что: и кнопка «‹», и свайп,
// и кнопка «назад» Android идут через историю браузера одной дорогой.
// Раньше «‹» открывала заранее заданный «родительский» экран новой записью
// в истории — и после неё свайп возвращал обратно, туда, откуда ушёл.
// Каждой записи истории ставим номер (history.state.idx): по нему видно,
// есть ли позади экран этого приложения. Если нет (открыли по ссылке,
// перезагрузили на первом экране) — «‹» ведёт на fallback, заменяя запись.
let navIdx = 0;
const stampEntry = (extra) => history.replaceState({ ...(history.state || {}), ...extra, idx: navIdx }, "");
if (Number.isInteger(history.state?.idx)) navIdx = history.state.idx; else stampEntry();
// Сменить текущий экран, не оставляя в истории того, с которого ушли
// (созданный наряд вместо мастера создания, новый адрес клиента).
function goReplace(hash) {
  history.replaceState({ idx: navIdx }, "", "#" + hash);
  onRoute();
}
function goBack(fallback = "/") {
  if (navIdx > 0) history.back();
  else goReplace(fallback);
}
setBackHandler(goBack);
// keepScroll — для точечных обновлений текущего экрана (галочка, чекбокс,
// правка поля): не дёргать страницу вверх при каждом клике. Без него — как
// при обычном переходе на новый экран, скролл сбрасывается в начало.
let renderSeq = 0;
function render(nodes, { keepScroll } = {}) {
  const list = Array.isArray(nodes) ? nodes.filter(Boolean) : [nodes];
  const y = window.scrollY;
  // Смена экрана с анимацией применяется не сразу, а чуть позже; если за
  // это время экран уже перерисовали (догрузились данные) — старую
  // заглушку поверх свежего не кладём.
  const seq = ++renderSeq;
  const swap = () => {
    if (seq !== renderSeq) return;
    app.replaceChildren(...list);
    reattachInlineWork();
    window.scrollTo(0, keepScroll ? y : 0);
  };
  // Переход на другой экран: надпись, по которой нажали, «перелетает» в
  // заголовок нового экрана, а при возврате — заголовок обратно на своё
  // место в списке (View Transitions браузера; где их нет — обычная смена).
  const pair = keepScroll ? null : titleMorphPair(list);
  if (!pair) return swap();
  pair.from.style.viewTransitionName = "screen-title";
  const t = document.startViewTransition(() => { swap(); pair.to.style.viewTransitionName = "screen-title"; });
  t.finished.finally(() => { pair.from.style.viewTransitionName = ""; pair.to.style.viewTransitionName = ""; });
}

// Какую надпись с какой связать при смене экрана. Сравниваем по тексту без
// «+», стрелок и регистра: «Выполненные работы» в профиле ↔ заголовок
// «Выполненные работы», название велосипеда в строке ↔ заголовок наряда.
const normTitle = (s) => String(s || "").replace(/^[\s+›‹>#]+/, "").replace(/\s+/g, " ").trim().toLowerCase();
let lastTap = null; // по чему нажали последним — откуда «вылетает» надпись
document.addEventListener("click", (e) => {
  lastTap = { el: e.target.closest?.("a, button, .row"), at: Date.now() };
}, true);
// Надпись с ровно этим текстом. Берём сам текст, обёрнутый в строчный span
// по его ширине, а не растянутый на всю строку контейнер: иначе при
// перелёте в заголовок буквы сплющиваются. Если текст разбит на части —
// самый глубокий элемент с ним целиком.
function findTitleLabel(roots, title) {
  for (const root of roots) {
    if (!root?.querySelectorAll) continue;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (normTitle(n.nodeValue) !== title) continue;
      const parent = n.parentNode;
      if (parent.childNodes.length === 1 && getComputedStyle(parent).display === "inline") return parent;
      const span = document.createElement("span");
      parent.insertBefore(span, n);
      span.append(n);
      return span;
    }
  }
  for (const root of roots) {
    if (!root?.querySelectorAll) continue;
    for (const el of [root, ...root.querySelectorAll("*")]) {
      if (normTitle(el.textContent) === title && ![...el.children].some((c) => normTitle(c.textContent) === title)) return el;
    }
  }
  return null;
}
function titleMorphPair(list) {
  if (!document.startViewTransition || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
  const newH1 = list.map((n) => n.matches?.("header.bar") ? n.querySelector("h1") : n.querySelector?.("header.bar h1")).find(Boolean);
  const oldH1 = app.querySelector("header.bar h1");
  const newTitle = normTitle(newH1?.textContent), oldTitle = normTitle(oldH1?.textContent);
  if (!newH1 || !oldH1 || !newTitle || newTitle === oldTitle) return null;
  // Вперёд: надпись на том, по чему только что нажали, → заголовок.
  if (lastTap?.el && Date.now() - lastTap.at < 1500 && app.contains(lastTap.el)) {
    const from = findTitleLabel([lastTap.el], newTitle);
    if (from) return { from, to: newH1 };
  }
  // Назад: заголовок → та же надпись в списке нового экрана.
  const to = findTitleLabel(list, oldTitle);
  return to ? { from: oldH1, to } : null;
}
function onRoute() { router(); if (SESSION) syncFromServer(); }
window.addEventListener("hashchange", () => {
  // Новая запись (ссылка, go()) приходит без номера — она на шаг дальше.
  // При шаге по истории номер уже есть и уже учтён в popstate.
  if (!Number.isInteger(history.state?.idx)) { navIdx++; stampEntry(); }
  onRoute();
});

// Полноэкранные под-экраны (диагностика, техпроцедура, подбор работы) внутри
// обращения не меняют #хеш при входе — рисуются прямо поверх текущего экрана
// через render(). Явная кнопка «‹» в их шапке об этом знает и просто зовёт
// refresh(), а вот системный жест «смахнуть назад» (и аппаратная кнопка
// «назад» на Android) смотрит на историю браузера — а там для этого
// под-экрана нет отдельной записи, так что жест уводит не на один шаг назад
// (к обращению), а мимо него — туда, где браузер был ДО открытия обращения.
// Чиним тем же приёмом, что и модалки в обычных SPA: при входе добавляем
// пустую запись в историю (тот же #хеш, без изменений — используем это,
// чтобы не задеть обычный hashchange/router()) и слушаем popstate — оно
// срабатывает что от жеста, что от аппаратной кнопки, что от программного
// history.back(). Явную кнопку «‹» тоже переводим на history.back(), чтобы
// оба пути шли одной и той же дорогой и не расходились между собой.
let subScreenExit = null;
let editingItemCode = null; // код работы в наряде, у которой сейчас открыта форма редактирования
function enterSubScreen(onExit) {
  setInSubScreen(true);
  subScreenExit = onExit;
  history.pushState({ sub: true, idx: ++navIdx }, "");
}
function leaveSubScreen() {
  history.back();
}
window.addEventListener("popstate", () => {
  if (Number.isInteger(history.state?.idx)) navIdx = history.state.idx;
  closeAllSheets();
  const fn = subScreenExit;
  subScreenExit = null;
  setInSubScreen(false);
  if (fn) fn();
});

// На iOS фикс.-позиционированные панели (.actions — нижняя строка поиска,
// нижние кнопки) остаются привязаны к низу layout-viewport, который клавиатура
// не двигает — поэтому панель молча уезжает под клавиатуру, а не поднимается
// над ней. VisualViewport знает фактическую видимую высоту — по ней считаем,
// на сколько клавиатура «съела» экран, и поднимаем панели на эту величину
// через CSS-переменную (см. .actions в app.css).
(function setupKeyboardOffset() {
  if (!window.visualViewport) return;
  const vv = window.visualViewport;
  // Высоты недостаточно: как только клавиатура открылась, iOS следом сам
  // прокручивает страницу, чтобы поднять сфокусированное поле над ней — от
  // этого visualViewport ещё и сдвигается внутри layout-viewport
  // (vv.offsetTop), а «resize» на это уже не срабатывает повторно. Без
  // поправки на offsetTop панель после этого доскролла зависает
  // где-то в середине экрана, оторвавшись от настоящей клавиатуры.
  // Раньше слушали offsetTop и через "scroll" тоже, но без привязки к тому,
  // открыта ли вообще клавиатура — то же событие летит и от обычного
  // оттягивания страницы вниз до упора (резиновый bounce-скролл iOS), из-за
  // чего панель на секунду подпрыгивала вверх при долистывании. Поэтому
  // "scroll" пересчитывает панель, только пока по высоте видно, что
  // клавиатура правда открыта — во время bounce-скролла без клавиатуры этот
  // пересчёт просто не включается.
  let kbOpen = false;
  const update = () => {
    const heightDiff = Math.max(0, window.innerHeight - vv.height);
    kbOpen = heightDiff > 50;
    document.documentElement.classList.toggle("kb-open", kbOpen);
    const offset = kbOpen ? Math.max(0, heightDiff - vv.offsetTop) : 0;
    document.documentElement.style.setProperty("--kb-offset", offset + "px");
    document.documentElement.style.setProperty("--vv-h", vv.height + "px");
  };
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", () => { if (kbOpen) update(); });
  update();
})();

// ---------------------------------------------------------------------------
// Вернуть случайно удалённое обращение: кнопка «↶» на несколько секунд сразу
// после удаления или встряхивание телефона в течение минуты (сначала вопрос).
// Остальные действия отменяются обычным интерфейсом, отдельной отмены у них нет.
// ---------------------------------------------------------------------------

// Вопрос посреди экрана с двумя кнопками, как системный на iPhone.
// onYes вызывается прямо в обработчике нажатия — это важно для запроса
// доступа к датчику движения: iOS разрешает его только в ответ на нажатие.
let dialogOpen = false;
function askDialog({ title, message, yes = "Да", no = "Нет", onYes, onNo }) {
  if (dialogOpen) return;
  dialogOpen = true;
  const close = () => { dialogOpen = false; backdrop.remove(); };
  const backdrop = el("div", { class: "dialog-backdrop" },
    el("div", { class: "dialog", role: "alertdialog" },
      el("div", { class: "dialog-text" }, el("b", {}, title), message ? el("p", {}, message) : null),
      el("div", { class: "dialog-buttons" },
        el("button", { type: "button", onclick: () => { close(); onNo?.(); } }, no),
        el("button", { type: "button", class: "dialog-yes", onclick: () => { close(); onYes?.(); } }, yes))));
  document.body.append(backdrop);
}

// Кнопка «↶»: маленькая, в углу, сама исчезает через 4 секунды.
let undoChip = null, undoChipTimer = null;
function hideUndoChip() { clearTimeout(undoChipTimer); undoChip?.classList.remove("show"); }
function showUndoChip(onClick) {
  if (!undoChip) {
    undoChip = el("button", { type: "button", class: "undo-chip", "aria-label": "Вернуть удалённое обращение",
      html: ICON_SVG('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>') });
    document.body.append(undoChip);
  }
  undoChip.onclick = onClick;
  undoChip.classList.add("show");
  clearTimeout(undoChipTimer);
  undoChipTimer = setTimeout(hideUndoChip, 4000);
}

// Встряхивание — только чтобы вернуть только что удалённое обращение (в
// течение минуты после удаления). Для остальных действий — кнопка «↶».
// Доступ к датчику движения на iPhone спрашиваем в момент удаления: iOS
// разрешает запрос только по нажатию, а в остальное время приложение датчик
// не трогает и ничего не спрашивает (раньше вопрос всплывал слишком часто).
const SHAKE_WINDOW_MS = 60 * 1000;
let lastDeleted = null; // { order, at } — последнее удалённое обращение
function armShakeForDelete() { // вызывать прямо в обработчике нажатия «Удалить»
  const DM = window.DeviceMotionEvent;
  if (!DM) return;
  if (typeof DM.requestPermission === "function") {
    DM.requestPermission().then((res) => { if (res === "granted") listenShake(); }).catch(() => {});
  } else listenShake();
}
function rememberDeleted(order) {
  if (!order) return;
  lastDeleted = { order: structuredClone(order), at: Date.now() };
  showUndoChip(restoreDeleted);
}
function restoreDeleted() {
  const d = lastDeleted;
  lastDeleted = null;
  hideUndoChip();
  if (!d) return;
  if (!restoreOrder(d.order)) return toast("Обращение уже на месте");
  toast("Обращение возвращено");
  closeAllSheets();
  router();
}
function onShake() {
  if (!SESSION || dialogOpen || !lastDeleted || Date.now() - lastDeleted.at > SHAKE_WINDOW_MS) return;
  askDialog({ title: "Вернуть удалённое обращение?", message: "Вы только что удалили обращение — восстановить его?",
    yes: "Вернуть", no: "Нет", onYes: restoreDeleted });
}
let shakeListening = false;
function listenShake() {
  if (shakeListening) return;
  shakeListening = true;
  let last = null, hits = [], quietUntil = 0;
  window.addEventListener("devicemotion", (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;
    if (last) {
      // Резкая смена ускорения три раза за 0.8 с — встряхнули. Ходьба и
      // телефон в кармане до такого порога не доходят, а если и дойдут —
      // без «Вернуть» ничего не произойдёт.
      const jolt = Math.abs(a.x - last.x) + Math.abs(a.y - last.y) + Math.abs(a.z - last.z);
      const now = Date.now();
      if (jolt > 25 && now > quietUntil) {
        hits = hits.filter((t) => now - t < 800);
        hits.push(now);
        if (hits.length >= 3) { hits = []; quietUntil = now + 2000; onShake(); }
      }
    }
    last = { x: a.x, y: a.y, z: a.z };
  });
}

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

// Оформление: стиль (Аэро и ещё пять, см. web/themes.css) и тема —
// светлая, тёмная или как на телефоне. Хранится в учётной записи
// (api/auth.js, setLook) и копией на телефоне — чтобы при следующем
// открытии нужный вид был сразу, ещё до ответа сервера (см. template.html).
const STYLE_PRESETS = [
  { id: "aero", name: "Аэро", note: "Объём, глянец, небо", sw: ["#bfe3fb", "#ffffff", "#007aff"] },
  { id: "calm", name: "Спокойный", note: "Плоский, как настройки айфона", sw: ["#f2f2f7", "#ffffff", "#007aff"] },
  { id: "soft", name: "Мягкий", note: "Формы выдавлены из фона", sw: ["#e4e9f0", "#c3cad5", "#4f6bed"] },
  { id: "workshop", name: "Мастерская", note: "Крупно и контрастно", sw: ["#ffcc00", "#ffffff", "#111111"] },
  { id: "graphite", name: "Графит", note: "Матовый, оранжевый акцент", sw: ["#282828", "#ececec", "#ff8a1f"] },
  { id: "paper", name: "Бумага", note: "Тёплый, с засечками", sw: ["#f4ede1", "#fffaf1", "#2e6b4f"] },
  { id: "terminal", name: "Командная строка", note: "Моноширинный шрифт, как в терминале", sw: ["#000000", "#f2f2f2", "#39ff6a"] },
];
const THEME_OPTIONS = [["auto", "Как на телефоне"], ["light", "Светлая"], ["dark", "Тёмная"]];
const DARK_MQ = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
// Стиль по умолчанию — для тех, кто ещё ничего не выбирал в профиле.
const DEFAULT_STYLE = "calm";
const normalizeLook = (l) => ({
  style: STYLE_PRESETS.some((p) => p.id === l?.style) ? l.style : DEFAULT_STYLE,
  theme: THEME_OPTIONS.some(([v]) => v === l?.theme) ? l.theme : "auto",
});
let currentLook = normalizeLook((() => { try { return JSON.parse(localStorage.getItem("veloterra-look")); } catch { return null; } })());
function applyLook(look) {
  currentLook = normalizeLook(look);
  const d = document.documentElement;
  d.dataset.style = currentLook.style;
  d.dataset.theme = currentLook.theme === "auto" ? (DARK_MQ?.matches ? "dark" : "light") : currentLook.theme;
  try { localStorage.setItem("veloterra-look", JSON.stringify(currentLook)); } catch {}
}
DARK_MQ?.addEventListener?.("change", () => applyLook(currentLook));
applyLook(currentLook);
// Вход выполнен — решает то, что сохранено в аккаунте; ничего не выбрано —
// стиль по умолчанию (копия на телефоне могла остаться от прежнего
// умолчания, её не считаем выбором).
const applySessionLook = () => { if (SESSION) applyLook(SESSION.look || {}); };

(async () => {
  await loadSession();
  applySessionLook();
  router();
  if (SESSION) { if (dirty) await flushPending(); else syncFromServer(); }
})();
window.addEventListener("online", () => { if (SESSION && dirty) flushPending(); });

// ============================================================================
//  ЭКРАНЫ
// ============================================================================

// width/height — запасной размер: без явного атрибута или CSS-правила у
// samостоятельного <svg> нет внутреннего размера, он схлопывается в 0×0
// (кнопка становится невидимой и некликабельной). Там, где место уже
// стилизовано отдельным CSS-классом (.swipe-action-btn svg и т.п.), тот
// правило просто перебивает этот атрибут по специфичности — не мешает.
const ICON_SVG = (inner) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
// Пиктограммы узлов на экране добавления работ (id блока из
// catalog/diagnostics.json) — узел находится глазами быстрее, чем по слову.
const BLOCK_ICONS = {
  WHL: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.8"/><path d="M12 3v7.2M12 13.8V21M3 12h7.2M13.8 12H21M5.6 5.6l5.1 5.1M13.3 13.3l5.1 5.1M18.4 5.6l-5.1 5.1M10.7 13.3l-5.1 5.1"/>',
  BRK: '<circle cx="11" cy="13" r="8"/><circle cx="11" cy="13" r="2.5"/><path d="M11 7.4v.1M16.6 13h-.1M11 18.6v-.1M5.4 13h.1"/><path d="M15 3.5h4.5A1.5 1.5 0 0 1 21 5v5.5"/>',
  // Каретка — ключ для чашек Hollowtech II; ручка уходит за край значка.
  BB: '<path d="M-9.76 28.17L6.17 12.24A8.3 8.3 0 1 1 11.26 17.33L-4.67 33.26"/><path d="M19.3 9.5Q17.57 10.46 18.59 12.15Q16.62 12.12 16.65 14.09Q14.96 13.07 14 14.8Q13.04 13.07 11.35 14.09Q11.38 12.12 9.41 12.15Q10.43 10.46 8.7 9.5Q10.43 8.54 9.41 6.85Q11.38 6.88 11.35 4.91Q13.04 5.93 14 4.2Q14.96 5.93 16.65 4.91Q16.62 6.88 18.59 6.85Q17.57 8.54 19.3 9.5z" stroke-width="1.5"/>',
  // Рулевая — верхняя и нижняя чашки рулевой колонки, сбоку.
  STR: '<path d="M4.5 4 19.5 4 19.5 5.8 17 5.8 17 9.2 7 9.2 7 5.8 4.5 5.8z"/><path d="M4.5 20 19.5 20 19.5 18.2 17 18.2 17 14.8 7 14.8 7 18.2 4.5 18.2z"/>',
  FRM: '<path d="M4.5 17 10 8h9l-4.5 9h-10z"/><path d="M10 8 9 5H7"/><path d="M19 8l.7-3"/>',
  // Трансмиссия — цепь по диагонали: звено и половинки соседних звеньев
  // (маска прячет половинки под наружным звеном).
  DRV: '<g transform="rotate(-45 12 12)" stroke-width="1.5"><mask id="chain-m"><rect x="-10" y="-10" width="44" height="44" fill="#fff"/><path d="M8 8.8Q12.0 9.92 16 8.8A3.2 3.2 0 0 1 16 15.2Q12.0 14.08 8 15.2A3.2 3.2 0 0 1 8 8.8z" fill="#000" stroke="#000" stroke-width="3"/></mask><g mask="url(#chain-m)"><path d="M1 10.6Q5.55 10.6 8 9.3A2.7 2.7 0 0 1 8 14.7Q5.55 13.4 1 13.4"/><path d="M23 10.6Q18.45 10.6 16 9.3A2.7 2.7 0 0 0 16 14.7Q18.45 13.4 23 13.4"/></g><path d="M8 8.8Q12.0 9.92 16 8.8A3.2 3.2 0 0 1 16 15.2Q12.0 14.08 8 15.2A3.2 3.2 0 0 1 8 8.8z"/><circle cx="8" cy="12" r="1.1" fill="currentColor"/><circle cx="16" cy="12" r="1.1" fill="currentColor"/></g>',
  TCH: '<path d="M3 8.5c0-1.3 1.6-2 4.5-2 3 0 4.6 1.6 8.5 2.2 3 .4 5 1 5 2.3s-2 1.8-5 1.8c-2.6 0-4 1.2-6.5 1.5C5.5 14.8 3 12.5 3 8.5z"/><path d="M11 14.5V21"/>',
  WSH: '<path d="M12 3s6 6.6 6 11a6 6 0 0 1-12 0c0-4.4 6-11 6-11z"/>',
};
const BLOCK_ICON_DEFAULT = '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8z"/>';
// Поле «Уточнения»: иконка слева, подсказка по центру строки, а не в углу
// высокой пустой рамки; поле само растёт по мере текста.
const ICON_NOTE = ICON_SVG('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12.5h5"/>');
function requestField(value, onChange, extraClass = "") {
  const ta = el("textarea", { class: "request-field", rows: 1, value, placeholder: "Уточнения клиента",
    onchange: (e) => onChange(e.target.value.trim()) });
  const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
  ta.addEventListener("input", fit);
  requestAnimationFrame(fit);
  return el("label", { class: ("request-box " + extraClass).trim() },
    el("span", { class: "request-icon", html: ICON_NOTE }), ta);
}
const blockIcon = (id) => el("span", { class: "block-icon", html: ICON_SVG(BLOCK_ICONS[id] || BLOCK_ICON_DEFAULT) });
// Иконки для кнопок правки/удаления в свайпе (см. swipeActions) — вместо
// символов ✎/✕ из системного шрифта, которые на разных устройствах
// выглядят по-разному и не в стиле остальных SVG-иконок приложения.
const ICON_EDIT = ICON_SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>');
const ICON_CLOSE = ICON_SVG('<path d="M18 6 6 18"/><path d="M6 6l12 12"/>');
const ICON_CHECK = ICON_SVG('<path d="M20 6 9 17l-5-5"/>');
const ICON_PHONE = ICON_SVG('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/>');
const ICONS = {
  prices: ICON_SVG('<path d="M12.6 3H6a2 2 0 0 0-2 2v6.6a2 2 0 0 0 .6 1.4l8.4 8.4a2 2 0 0 0 2.8 0l5.6-5.6a2 2 0 0 0 0-2.8L13 3.6a2 2 0 0 0-1.4-.6Z"/><circle cx="8.5" cy="8.5" r="1.3"/>'),
  admin: ICON_SVG('<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z"/>'),
  profile: ICON_SVG('<circle cx="12" cy="9" r="3"/><path d="M6 19c1.2-3 3.6-4.5 6-4.5s4.8 1.5 6 4.5"/>'),
  masters: ICON_SVG('<circle cx="9" cy="8" r="2.5"/><path d="M4 19c.8-2.6 2.6-4 5-4s4.2 1.4 5 4"/><circle cx="17" cy="9" r="2"/><path d="M15.5 12c1.9.4 3 1.6 3.5 3.2"/>'),
  clients: ICON_SVG('<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><circle cx="9" cy="11" r="2"/><path d="M6.3 16c.5-1.7 1.8-2.6 3.3-2.6"/><path d="M14 10h4M14 13.5h4"/>'),
  stock: ICON_SVG('<path d="M3.5 7.5 12 3l8.5 4.5V16L12 20.5 3.5 16V7.5Z"/><path d="M3.5 7.5 12 12l8.5-4.5M12 12v8.5"/>'),
  settings: ICON_SVG('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>'),
  report: ICON_SVG('<path d="M4 20V10"/><path d="M11 20V4"/><path d="M18 20v-7"/>'),
  sync: ICON_SVG('<path d="M4 12a8 8 0 0 1 14-5.2M20 12a8 8 0 0 1-14 5.2"/><path d="M18 3v4h-4M6 21v-4h4"/>'),
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

// Свайп влево на строке списка открывает действия под ней — кружок-кнопку с
// подписью, как в Почте/Телефоне на iOS. Открыта всегда только одна строка:
// свайп другой строки или тап вне списка закрывают предыдущую. onDelete —
// async, должен вернуть false при неудаче (тогда строка возвращается в
// закрытое состояние и кнопку можно нажать ещё раз).
let openSwipeClose = null;
function closeOpenSwipe() { const c = openSwipeClose; openSwipeClose = null; if (c) c(); }
document.addEventListener("pointerdown", (e) => {
  if (openSwipeClose && !e.target.closest(".swipe-row")) closeOpenSwipe();
}, true);

// Ширина области под свайпом: боковые поля + кружки + зазоры между ними —
// общая формула для одного действия (swipeToDelete) и нескольких подряд
// (swipeActions), чтобы дистанция свайпа всегда точно совпадала с тем, что
// нарисовано под строкой.
const SWIPE_CIRCLE = 50, SWIPE_GAP = 14, SWIPE_PAD = 15;
const swipeActionsWidth = (n) => SWIPE_PAD * 2 + SWIPE_CIRCLE * n + SWIPE_GAP * (n - 1);

function swipeToDelete(rowNode, onDelete, label = "Удалить") {
  const ACTION_W = swipeActionsWidth(1);
  const wrap = el("div", { class: "swipe-row" });
  const action = el("button", { class: "swipe-action-btn warn", "aria-label": label, html: ICON_CLOSE });
  const bar = el("div", { class: "swipe-actions" }, action);
  rowNode.classList.add("swipe-content");
  rowNode.setAttribute("draggable", "false"); // иначе браузер начинает нативный drag ссылки вместо свайпа
  wrap.append(bar, rowNode);

  let x = 0, dragging = false, locked = null, moved = false, startX = 0, startY = 0, fromX = 0, pid = null;
  const apply = (animate) => {
    rowNode.style.transition = animate ? "transform .22s cubic-bezier(.2,.8,.2,1)" : "none";
    rowNode.style.transform = x ? `translateX(${x}px)` : "";
  };
  const close = (animate = true) => { x = 0; apply(animate); };
  const openFull = (animate = true) => { x = -ACTION_W; apply(animate); openSwipeClose = close; };

  action.onclick = async (e) => {
    e.preventDefault(); e.stopPropagation();
    action.disabled = true;
    const ok = await onDelete();
    if (ok === false) { action.disabled = false; close(); if (openSwipeClose === close) openSwipeClose = null; }
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
  // stopImmediatePropagation — не только preventDefault(): rowNode может сам
  // по себе иметь собственный click-обработчик (строка-переключатель, см.
  // диагностику), зарегистрированный ДО этого. preventDefault гасит только
  // штатное поведение (например переключение чекбокса через label), но не
  // чужие addEventListener-слушатели — без stopImmediatePropagation
  // свайп-жест долетал бы до них как обычный тап и срабатывал бы заодно.
  rowNode.addEventListener("click", (e) => {
    if (moved) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (x !== 0) { e.preventDefault(); e.stopImmediatePropagation(); close(); if (openSwipeClose === close) openSwipeClose = null; }
  });

  return wrap;
}

// Тот же жест, что и swipeToDelete, но открывает несколько кружков-иконок
// подряд (например правка + удаление), а не один — для плотных списков
// (правка неисправностей в диагностике), где такие кнопки прямо в строке
// смотрятся слишком мелко и тесно. actions — [{label, ariaLabel, onClick,
// className}] (label — иконка кнопки).
function swipeActions(rowNode, actions) {
  const width = swipeActionsWidth(actions.length);
  const wrap = el("div", { class: "swipe-row" });
  const bar = el("div", { class: "swipe-actions" },
    actions.map((a) => el("button", {
      class: `swipe-action-btn ${a.className || ""}`,
      "aria-label": a.ariaLabel || "Действие",
      html: a.label,
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); close(); if (openSwipeClose === close) openSwipeClose = null; a.onClick(); },
    })));
  rowNode.classList.add("swipe-content");
  rowNode.setAttribute("draggable", "false");
  wrap.append(bar, rowNode);

  let x = 0, dragging = false, locked = null, moved = false, startX = 0, startY = 0, fromX = 0, pid = null;
  const apply = (animate) => {
    rowNode.style.transition = animate ? "transform .22s cubic-bezier(.2,.8,.2,1)" : "none";
    rowNode.style.transform = x ? `translateX(${x}px)` : "";
  };
  const close = (animate = true) => { x = 0; apply(animate); };
  const openFull = (animate = true) => { x = -width; apply(animate); openSwipeClose = close; };

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
    x = Math.max(-width - 16, Math.min(0, fromX + ddx));
    apply(false);
  });
  const finish = (e) => {
    if (!dragging || (e && e.pointerId !== pid)) return;
    dragging = false;
    if (locked === "x") {
      if (x < -width / 2) openFull();
      else { close(); if (openSwipeClose === close) openSwipeClose = null; }
    }
  };
  rowNode.addEventListener("pointerup", finish);
  rowNode.addEventListener("pointercancel", finish);
  // stopImmediatePropagation — не только preventDefault(): rowNode может сам
  // по себе иметь собственный click-обработчик (строка-переключатель, см.
  // диагностику), зарегистрированный ДО этого. preventDefault гасит только
  // штатное поведение (например переключение чекбокса через label), но не
  // чужие addEventListener-слушатели — без stopImmediatePropagation
  // свайп-жест долетал бы до них как обычный тап и срабатывал бы заодно.
  rowNode.addEventListener("click", (e) => {
    if (moved) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (x !== 0) { e.preventDefault(); e.stopImmediatePropagation(); close(); if (openSwipeClose === close) openSwipeClose = null; }
  });

  return wrap;
}

// .rows полагается на CSS :last-child, чтобы убрать разделитель у последней
// строки — когда строки обёрнуты в .swipe-row, эта связь рвётся (последняя
// .row больше не последний ребёнок .rows). Снимаем разделитель явно.
// flat — список уже внутри своей карточки (например, узла диагностики) и
// не должен рисовать ещё одну рамку вокруг себя, только убрать разделитель
// у последней строки, как обычно. separate — каждая строка отдельной
// карточкой (список самостоятельных объектов вроде обращений), а не одной
// склеенной группой.
function rowsList(nodes, flat = false, separate = false) {
  if (nodes.length) {
    const last = nodes[nodes.length - 1];
    const rowEl = last.matches?.(".row") ? last : last.querySelector?.(".row");
    if (rowEl) rowEl.style.borderBottom = "0";
  }
  return el("div", { class: flat ? null : separate ? "rows rows-separate" : "rows" }, nodes);
}

function formatDateShort(iso) {
  return iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) : null;
}

// Строка обращения в списке активных обращений на главном экране (без
// номера обращения — мастерам он не нужен, только путает). onDelete, если
// передан, включает свайп-удаление строки.
function orderRow(o, d, onDelete) {
  const bike = d.bikes.find((b) => b.number === o.bikeNumber);
  const client = d.clients.find((c) => c.phone === o.clientPhone);
  const row = el("a", { class: "row", href: `#/orders/${o.number}` },
    el("span", { style: "flex:1;min-width:0" }, bike ? bikeLabel(bike) : (client?.name || o.clientName || "Обращение без данных"),
      (client?.name || o.clientName || o.clientPhone) ? el("br") : null,
      (client?.name || o.clientName || o.clientPhone) ? el("span", { class: "small muted" }, client?.name || o.clientName || o.clientPhone) : null,
      // Занятость мастером — теперь сама по себе статус («взята в работу»),
      // тут только его имя.
      null),
    orderStatusTag(o));
  return onDelete ? swipeToDelete(row, () => onDelete(o)) : row;
}

async function deleteOrderWithAlert(o) {
  armShakeForDelete();
  const ok = await deleteOrderApi(o.number);
  if (!ok) alert("Не удалось удалить — нет соединения. Попробуйте ещё раз, когда будет интернет.");
  else rememberDeleted(o);
  return ok;
}

// Главный экран сразу показывает активные обращения (всё, кроме выданных) —
// не нужно лишний раз заходить в «Обращения», чтобы увидеть, что в работе.
// Кнопка добавления — внизу, всегда на виду и одного размера (как везде в
// приложении), архив выданных — по ссылке отдельно.
function viewHome() {
  const d = loadDB();
  const active = [...d.orders].reverse().filter((o) => o.status !== "выдан").sort(orderWaitingLast);
  return [
    el("header", { class: "bar" }, el("h1", {}, "Veloterra"),
      el("a", { class: "sub", href: "#/profile" }, SESSION?.name || SESSION?.login || "")),
    el("main", { class: "wrap", style: "min-height:calc(100dvh - 56px);display:flex;flex-direction:column" },
      el("h2", { class: "small section-title", style: "margin:0 0 8px;font-weight:700;letter-spacing:.06em" }, "АКТИВНЫЕ ОБРАЩЕНИЯ"),
      active.length === 0
        ? emptyState("Активных обращений нет.")
        : rowsList(active.map((o) => orderRow(o, d, deleteOrderWithAlert)), false, true)),
    el("div", { class: "actions" }, el("div", { class: "actions-inner" },
      el("button", { class: "btn-primary", onclick: () => go("/orders/new") }, "+ Новое обращение"))),
  ];
}

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}


// Новое обращение: сначала собираем сам наряд и видим его стоимость, затем
// при желании указываем клиента/телефон/велосипед. Диагностики, отдельной
// оценки и согласования в этом потоке нет: выбранные позиции сразу считаются
// частью наряда. Одинаковую операцию можно добавить несколько раз — каждая
// копия становится самостоятельной работой со своим исполнителем и фактом.
function viewNewOrder() {
  const draft = { items: [], request: "" };

  const addDraftItem = (pick) => {
    const item = makeCustomItem(pick);
    if (draft.items.some((i) => (i.sourceCode || i.code) === pick.code)) {
      item.sourceCode = pick.code;
      item.code = instanceCode(pick.code);
    }
    item.agreed = true;
    draft.items.push(item);
  };

  function stepWorks() {
    const host = el("div", {});
    render([bar("Новое обращение", "/"), host]);
    mountDiagnostics(host, {
      // Это не отдельная «Диагностика»: экран просто служит каталогом работ,
      // разложенным по привычным узлам велосипеда.
      request: draft.request,
      onRequest: (v) => (draft.request = v),
      onCheck: (fa) => {
        if (!draft.items.some((it) => (it.sourceCode || it.code) === fa.code)) addDraftItem(fa);
      },
      onUncheck: (fa) => {
        draft.items = draft.items.filter((it) => (it.sourceCode || it.code) !== fa.code);
      },
      getInstanceCount: (fa) => draft.items.find((it) => (it.sourceCode || it.code) === fa.code)?.qty || 0,
      getQuantity: (fa) => draft.items.find((it) => (it.sourceCode || it.code) === fa.code)?.qty || 1,
      onQuantity: (fa, qty) => {
        const item = draft.items.find((it) => (it.sourceCode || it.code) === fa.code);
        if (item) item.qty = qty;
      },
      onInstanceCount: (fa, count) => {
        let item = draft.items.find((it) => (it.sourceCode || it.code) === fa.code);
        if (count <= 0) {
          if (item) draft.items = draft.items.filter((it) => it.code !== item.code);
          return;
        }
        if (!item) { addDraftItem(fa); item = draft.items.find((it) => (it.sourceCode || it.code) === fa.code); }
        if (item) item.qty = count;
      },
      onOpen: async (fa, redraw) => {
        const it = draft.items.find((item) => (item.sourceCode || item.code) === fa.code);
        if (!it) return;
        const stock = await ensureStock();
        openPendingSheet(it, stock, {
          onSet: (code, di, state) => {
            const item = draft.items.find((x) => x.code === code);
            if (item?.difficulties?.[di]) item.difficulties[di].state = state;
            redraw();
          },
          onDiffQty: (code, di, qty) => {
            const item = draft.items.find((x) => x.code === code);
            if (item?.difficulties?.[di]) item.difficulties[di].qty = qty;
            redraw();
          },
          onParts: (code, parts) => {
            const item = draft.items.find((x) => x.code === code);
            if (item) item.parts = parts;
            redraw();
          },
        }, [it]);
      },
      getItemRange: (fa) => {
        const items = draft.items.filter((it) => (it.sourceCode || it.code) === fa.code);
        if (!items.length) return null;
        return itemsRangeWithParts(items);
      },
      totalText: () => ({ range: orderRangeAll(draft), count: draft.items.length, items: draft.items }),
      // Второй шаг — отдельная запись в истории: «‹», свайп и «Назад»
      // одинаково возвращают к выбору работ, черновик остаётся.
      onDone: () => { stepClient(); enterSubScreen(stepWorks); },
    });
  }

  function stepClient() {
    const f = { phone: "", name: "", bike: "new", bikeName: "" };
    // Смена клиента (другой телефон) — отдельно от простого f.bike: нужно
    // отличить «сбросить выбор велосипеда, потому что это уже другой
    // клиент» от «перерисовали форму, потому что мастер сам кликнул радио».
    // Раньше сброс шёл при каждой перерисовке, если f.bike не входит в
    // owned[].number — а "new" туда никогда и не входит, так что осознанный
    // выбор «Новый велосипед» тут же затирался обратно на первый велосипед.
    let lastClientKey;

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
              el("input", { type: "text", value: f.name, placeholder: "не обязательно", oninput: (e) => (f.name = e.target.value) })),
      );
      drawBike();
    }

    function drawBike() {
      const ec = findClientByPhone(loadDB().clients, f.phone);
      const owned = ec ? loadDB().bikes.filter((b) => b.ownerPhone === ec.phone) : [];
      const clientKey = ec?.phone ?? null;
      // По умолчанию — уже существующий велосипед клиента (первый на учёте),
      // а не «новый»: новый велосипед — редкий случай, не тот, что чаще всего
      // нужен при повторном визите. Но только когда сменился сам клиент —
      // иначе клик по «Новый велосипед» сбрасывался бы обратно тут же.
      if (clientKey !== lastClientKey) {
        lastClientKey = clientKey;
        f.bike = owned.length ? owned[0].number : "new";
      }
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
        bikeFields.append(el("input", {
          type: "text", value: f.bikeName, placeholder: "Марка, модель",
          oninput: (e) => (f.bikeName = e.target.value),
        }));
      bikeSlot.append(bikeFields);
    }

    const phoneInput = el("input", { type: "tel", value: f.phone, placeholder: "+7 — необязательно" });
    attachPhoneMask(phoneInput, (v) => { f.phone = v; drawClient(); });

    const wrap = el("main", { class: "wrap" },
      el("div", { class: "card" }, el("h2", {}, "Клиент"),
        el("label", {}, "Телефон"),
        phoneInput,
        clientSlot),
      bikeSlot);
    drawClient();

    const createOrder = () => {
      const hasPhone = maskedDigits(f.phone).length > 0;
      if (hasPhone && !isValidPhone(f.phone)) return alert("Проверьте номер телефона или оставьте поле пустым");
      let number;
      editDB((d) => {
        let p = "";
        if (hasPhone) {
          const existing = findClientByPhone(d.clients, f.phone);
          p = existing ? existing.phone : f.phone;
          if (!existing) d.clients.push({ phone: p, name: f.name.trim() });
        }
        let bn = "";
        if (f.bike !== "new" && d.bikes.some((b) => b.number === f.bike)) bn = f.bike;
        else if (f.bikeName.trim()) {
          bn = nextBikeKey(d, p || "anonymous");
          d.bikes.push({ number: bn, name: f.bikeName.trim(), ownerPhone: p });
        }
        number = nextOrderNumber(d);
        d.orders.push({
          number, clientPhone: p, clientName: f.name.trim(), bikeNumber: bn,
          request: draft.request, diagnosticNotes: [], status: "взята в работу",
          occupiedBy: null, occupiedByName: "",
          items: draft.items.map((it) => ({ ...it, agreed: true })), createdAt: new Date().toISOString(),
        });
      });
      // Созданный наряд встаёт на место мастера создания: «назад» из него —
      // туда, откуда начинали, а не обратно в пустую форму.
      subScreenExit = () => goReplace(`/orders/${number}`);
      leaveSubScreen();
    };

    render([
      bar("Новое обращение", "/"),
      wrap,
      el("div", { class: "actions" }, el("div", { class: "actions-inner" },
        el("button", { onclick: leaveSubScreen }, "Назад"),
        el("button", { class: "btn-primary", onclick: createOrder }, "Создать обращение"))),
    ]);
  }

  // router() сам отрисовывает возвращённые узлы. Если вызвать stepWorks()
  // синхронно и вернуть пустой массив, его внешний render([]) тут же сотрёт
  // уже построенный экран. Сначала отдаём лёгкую заглушку роутеру, а полный
  // экран черновика рисуем следующей микрозадачей.
  queueMicrotask(stepWorks);
  return [bar("Новое обращение", "/"), el("main", { class: "wrap" }, skeletonRows(2))];
}

// ============================================================================
//  ЭКРАН ОБРАЩЕНИЯ — стадии
// ============================================================================

function viewOrder(number) {
  // Сюда возвращаются и через router() (уже сбросил флаг), и напрямую через
  // refresh() из под-экранов (диагностика и т.п.) — сбрасываем и тут, иначе
  // после refresh() флаг остаётся true и фоновые обновления больше никогда
  // не подхватятся автоматически.
  setInSubScreen(false);
  const d = loadDB();
  const order = d.orders.find((o) => o.number === number);
  if (!order) return [bar(number, "/"), el("main", { class: "wrap" }, el("p", { class: "muted" }, "Не найдено"))];
  const bike = d.bikes.find((b) => b.number === order.bikeNumber);
  const client = d.clients.find((c) => c.phone === order.clientPhone);
  // Прогреваем кэш своих неисправностей заранее (не дожидаясь) — нужен
  // partBlockIdOf, чтобы верно определить узел у пунктов, добавленных до
  // того, как в них завели поле group (см. partBlockIdOf).
  if (!repairsCache) ensureRepairs();
  // keepScroll: мелкая правка (чекбокс, будет/не будет/неизвестно, ✎/✕ у работы)
  // не должна дёргать страницу вверх — только переход между стадиями наряда.
  const refresh = () => render(viewOrder(number), { keepScroll: true });

  function openOrderDetailsEditor() {
    const state = {
      name: client?.name || order.clientName || "",
      phone: order.clientPhone ? applyPhoneMask(order.clientPhone) : "",
      bikeName: bikeLabel(bike),
    };
    const phoneInput = el("input", { type: "tel", value: state.phone, placeholder: "+7 — необязательно" });
    attachPhoneMask(phoneInput, (v) => (state.phone = v));
    const error = el("p", { class: "small", style: "color:var(--warn);display:none" });
    let sheet;
    const save = async () => {
      const hasPhone = maskedDigits(state.phone).length > 0;
      if (hasPhone && !isValidPhone(state.phone)) {
        error.textContent = "Проверьте номер телефона или оставьте поле пустым";
        error.style.display = "";
        return;
      }
      const newPhone = hasPhone ? state.phone : "";
      const oldPhone = order.clientPhone || "";
      const duplicate = newPhone && loadDB().clients.find((c) => c.phone !== oldPhone && phoneDigits(c.phone) === phoneDigits(newPhone));
      if (duplicate) {
        error.textContent = `Этот номер уже принадлежит клиенту «${duplicate.name || duplicate.phone}»`;
        error.style.display = "";
        return;
      }
      const ok = await pushDbNow((d) => {
        const o = d.orders.find((x) => x.number === number);
        if (!o) return;
        const c = oldPhone ? findClientByPhone(d.clients, oldPhone) : null;
        if (c) {
          c.name = state.name.trim();
          if (newPhone && phoneDigits(newPhone) !== phoneDigits(oldPhone)) {
            c.phone = newPhone;
            for (const b of d.bikes) if (b.ownerPhone === oldPhone) b.ownerPhone = newPhone;
            for (const x of d.orders) if (x.clientPhone === oldPhone) x.clientPhone = newPhone;
          }
        } else if (newPhone) {
          d.clients.push({ phone: newPhone, name: state.name.trim() });
        }
        o.clientPhone = newPhone;
        o.clientName = state.name.trim();
        let b = d.bikes.find((x) => x.number === o.bikeNumber);
        if (b) {
          b.name = state.bikeName.trim();
          if (newPhone) b.ownerPhone = newPhone;
        } else if (state.bikeName.trim()) {
          const bikeNumber = nextBikeKey(d, newPhone || "anonymous");
          b = { number: bikeNumber, name: state.bikeName.trim(), ownerPhone: newPhone };
          d.bikes.push(b);
          o.bikeNumber = bikeNumber;
        }
      });
      if (!ok) {
        error.textContent = "Не удалось сохранить — проверьте соединение";
        error.style.display = "";
        return;
      }
      sheet.close();
      toast("Данные изменены");
      refresh();
    };
    sheet = openSheet("Клиент и велосипед", el("div", {},
      el("label", {}, "Имя"),
      el("input", { value: state.name, placeholder: "необязательно", oninput: (e) => (state.name = e.target.value) }),
      el("label", { style: "margin-top:10px" }, "Телефон"), phoneInput,
      el("label", { style: "margin-top:10px" }, "Велосипед"),
      el("input", { value: state.bikeName, placeholder: "необязательно", oninput: (e) => (state.bikeName = e.target.value) }),
      error,
      el("button", { class: "btn-primary", style: "width:100%;margin-top:16px", onclick: save }, "Сохранить")));
  }

  // agreed — работы, отмеченные на приёме (диагностика или «+ работа» на
  // этой же стадии), сразу считаются согласованными: количество и
  // усложнения уже настраиваются тут же, отдельного шага-подтверждения для
  // них не нужно. Позиции, добавленные позже («+ доп. работа» в ремонте),
  // остаются agreed:false и ждут подтверждения через «Ждёт согласования».
  function addItem(fa, notes = "", agreed = false) {
    editOrder(number, (o) => {
      const ex = o.items.find((i) => i.code === fa.code);
      if (ex) { if (notes) ex.notes = ex.notes ? `${ex.notes}; ${notes}` : notes; return; }
      const item = makeCustomItem(fa, notes);
      if (agreed) item.agreed = true;
      o.items.push(item);
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
    toast("Работа убрана из обращения");
  }
  // Ещё один экземпляр той же повторяющейся работы (quantityMode:"instances")
  // прямо с экрана «Ремонт» — клонируем статические поля (название/цена/
  // усложнения) у уже существующего экземпляра, «свои» поля этого
  // конкретного экземпляра (занятость/готово/детали/усложнения по факту)
  // обнуляем — это независимый новый экземпляр, а не копия чужого прогресса.
  function addWorkInstance(template) {
    const base = template.sourceCode || template.code;
    const item = {
      ...template,
      code: instanceCode(base),
      sourceCode: base,
      agreed: true, done: false, doneBy: null, claimedBy: null, waitingForPart: null, parts: [], notes: "",
      difficulties: (template.difficulties || []).map((d) => ({ label: d.label, add: d.add, addMinutes: d.addMinutes || 0, multiple: d.multiple, qty: 1, state: "no" })),
    };
    editOrder(number, (o) => { o.items.push(item); });
    refresh();
    return item;
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
  // Без code — только заголовок (экран «Добавить работу» во время ремонта).
  function subBar(code, title = bike ? bikeLabel(bike) : client?.name || "Обращение") {
    return el("header", { class: "bar" },
      el("button", { class: "back", style: "border:0;background:none", onclick: leaveSubScreen }, "‹"),
      el("h1", {}, title), code ? el("span", { class: "sub" }, code) : null);
  }
  // Работа, отмеченная тут (на приёме), попадает в наряд сразу agreed:true —
  // количество и усложнения настраиваются не тут, а прямо в «Списке работ»
  // на экране обращения (см. editableItemRow), отдельный экран-подтверждение
  // после неё не нужен. Это отличается от «+ доп. работы» на экране ремонта
  // ниже: там позиция добавляется уже после того, как наряд согласован с
  // клиентом, и ждёт отдельного явного подтверждения через карточку «Ждёт
  // согласования» (см. pendingAgreementRow).
  function openDiagnostics() {
    const host = el("div", {});
    render([subBar("Диагностика"), host]);
    enterSubScreen(refresh);
    mountDiagnostics(host, {
      onCheck: (fa) => addItem(fa, "", true),
      onUncheck: (fa) => removeItemQuiet(fa.code),
      onDone: (notes) => {
        if (notes.length) editOrder(number, (o) => { o.diagnosticNotes = [...(o.diagnosticNotes || []), ...notes]; });
        leaveSubScreen();
      },
      request: order.request || "",
      onRequest: (v) => editOrder(number, (o) => (o.request = v)),
      onlyBlocks: bike?.kind === "колесо" ? ["WHL"] : null,
      getItemRange: (fa) => {
        const liveItems = (loadDB().orders.find((o) => o.number === number)?.items) || order.items;
        const items = liveItems.filter((it) => (it.sourceCode || it.code) === fa.code);
        if (!items.length) return null;
        return itemsRangeWithParts(items);
      },
    });
  }
  // onPick — оборачиваем, а не передаём как есть: выбор работы должен так же
  // вернуть на экран обращения, как и явная «‹» — иначе после подбора работы
  // в истории остаётся неизрасходованная запись под этот под-экран, и один
  // будущий свайп/тап «назад» уйдёт в никуда, ничего не изменив на экране.
  function openPicker(onPick) {
    openWorkPicker({ existingItems: order.items, bikeKind: bike?.kind, onBack: leaveSubScreen, onPick: (p) => { onPick(p); leaveSubScreen(); } });
    enterSubScreen(refresh);
  }

  // Режим интеграции включают только после установки обмена в УНФ.
  // До этого сохраняется привычная выдача без ожидания кассы.
  async function openPayment() {
    if (!(await flushPending())) return toast("Сначала сохраните обращение на сервере");
    let checkoutMode;
    try {
      const response = await fetch("/api/checkout-mode", { cache: "no-store" });
      if (!response.ok) throw new Error();
      checkoutMode = (await response.json()).enabled;
    } catch { return toast("Не удалось проверить режим оплаты, повторите попытку"); }
    const main = el("main", { class: "wrap" },
      el("div", { class: "card" },
        el("h2", {}, "Оплата"),
        el("p", { class: "muted" }, checkoutMode
          ? `Откройте обращение ${number} в 1С и оформите оплату. После чека обновите статус здесь.`
          : "Экран оплаты в разработке."),
        totalRow(orderRange(loadDB().orders.find((o) => o.number === number) || order), 2, "К оплате")));
    const handOver = () => {
      editOrder(number, (o) => {
        o.status = "выдан"; o.occupiedBy = null; o.occupiedByName = ""; o.handedOverAt = new Date().toISOString();
        // Кто выдал — мастер может сам отменить свою выдачу в первые 15 минут.
        o.handedOverBy = { masterId: SESSION?.id || "", masterName: SESSION?.name || "" };
      });
      // Выдали — обращение закрыто, возвращаемся туда, откуда его открыли.
      subScreenExit = () => goBack("/");
      leaveSubScreen();
    };
    const checkPayment = async () => {
      await syncFromServer();
      const current = loadDB().orders.find((o) => o.number === number);
      if (current?.handedOverAt && current.fiscalReceipt) {
        subScreenExit = () => goBack("/");
        leaveSubScreen();
      } else toast("Подтверждение оплаты из 1С ещё не получено");
    };
    render([subBar(null, "Оплата"), main,
      el("div", { class: "actions" }, el("div", { class: "actions-inner" },
        el("button", { class: "btn-ok", onclick: checkoutMode ? checkPayment : handOver },
          checkoutMode ? "Проверить оплату" : "Выдать клиенту")))]);
    enterSubScreen(refresh);
  }

  // Добавление работ во время ремонта — теми же раскрывающимися блоками,
  // что и при создании наряда. Новые позиции держим локально до «Готово»,
  // чтобы кнопка «назад» действительно отменяла весь незавершённый выбор.
  function openAddWorkBlocks() {
    const host = el("div", {});
    const added = [];
    render([subBar(null, "Добавить работу"), host]);
    enterSubScreen(refresh);
    mountDiagnostics(host, {
      onlyBlocks: bike?.kind === "колесо" ? ["WHL"] : null,
      onCheck: (fa) => {
        if (!added.some((it) => (it.sourceCode || it.code) === fa.code)) {
          const item = makeCustomItem(fa);
          item.agreed = true;
          added.push(item);
        }
      },
      onUncheck: (fa) => {
        const i = added.findIndex((it) => (it.sourceCode || it.code) === fa.code);
        if (i >= 0) added.splice(i, 1);
      },
      getInstanceCount: (fa) => added.find((it) => (it.sourceCode || it.code) === fa.code)?.qty || 0,
      getQuantity: (fa) => added.find((it) => (it.sourceCode || it.code) === fa.code)?.qty || 1,
      onQuantity: (fa, qty) => {
        const item = added.find((it) => (it.sourceCode || it.code) === fa.code);
        if (item) item.qty = qty;
      },
      getInstanceMax: (fa) => {
        return fa.maxInstances > 0 ? fa.maxInstances : 0;
      },
      onInstanceCount: (fa, count) => {
        let item = added.find((it) => (it.sourceCode || it.code) === fa.code);
        if (count <= 0) {
          if (item) added.splice(added.indexOf(item), 1);
          return;
        }
        if (!item) {
          item = makeCustomItem(fa);
          item.agreed = true;
          added.push(item);
        }
        item.qty = count;
      },
      onOpen: async (fa, redraw) => {
        const it = added.find((item) => (item.sourceCode || item.code) === fa.code);
        if (!it) return;
        const stock = await ensureStock();
        openPendingSheet(it, stock, {
          onSet: (code, di, state) => { const x = added.find((v) => v.code === code); if (x?.difficulties?.[di]) x.difficulties[di].state = state; redraw(); },
          onDiffQty: (code, di, qty) => { const x = added.find((v) => v.code === code); if (x?.difficulties?.[di]) x.difficulties[di].qty = qty; redraw(); },
          onParts: (code, parts) => { const x = added.find((v) => v.code === code); if (x) x.parts = parts; redraw(); },
        }, [it]);
      },
      getItemRange: (fa) => {
        const items = added.filter((it) => (it.sourceCode || it.code) === fa.code);
        if (!items.length) return null;
        return itemsRangeWithParts(items);
      },
      onDone: () => {
        if (added.length) editOrder(number, (o) => {
          for (const draftItem of added) {
            const item = { ...draftItem };
            const source = item.sourceCode || item.code;
            if (o.items.some((it) => (it.sourceCode || it.code) === source)) {
              item.sourceCode = source;
              item.code = instanceCode(source);
            }
            o.items.push(item);
          }
        });
        leaveSubScreen();
      },
    });
  }

  const range = orderRange(order);
  // Карточка клиента — строки как в настройках айфона: слева одна колонка
  // иконок (человек, облачко уточнений), тексты с одной линии, между
  // строками тонкий разделитель, трубка справа. Раньше уточнения были
  // отдельной коробкой внутри карточки, а имя висело над ней само по себе.
  const clientName = client?.name || order.clientName;
  const headIcon = (html) => el("span", { class: "head-icon", html });
  const head = el("div", { class: "card order-head" },
    // Название велосипеда уже крупно в шапке экрана — тут не повторяем,
    // только тип. Номер обращения из вида убрали — мастерам он не нужен.
    bike?.kind ? el("h2", {}, bike.kind) : null,
    // Вся строка — ссылка tel:, а не только номер: на телефоне так проще
    // попасть пальцем, а кнопка-трубка справа сразу подсказывает, что тут
    // можно позвонить. Номер не показываем — звонок и так по трубке.
    order.clientPhone
      ? el("a", { href: `tel:${order.clientPhone.replace(/[^\d+]/g, "")}`, class: "client-line head-row" },
          headIcon(ICONS.profile),
          el("span", { style: "flex:1;min-width:0" },
            clientName ? el("b", {}, clientName) : el("span", { class: "muted" }, "Позвонить клиенту")),
          el("span", { class: "call-btn", html: ICON_PHONE }))
      : (clientName ? el("div", { class: "client-line head-row" }, headIcon(ICONS.profile), el("b", {}, clientName)) : null),
    order.status === "выдан"
      ? (order.request ? el("div", { class: "head-row head-note" }, headIcon(ICON_NOTE), el("span", { class: "muted" }, order.request)) : null)
      : requestField(order.request || "", (v) => { editOrder(number, (o) => (o.request = v)); refresh(); }, "head-row request-inline"));

  if ((order.diagnosticNotes || []).length) {
    const ul = el("ul", { style: "margin:4px 0 0;padding-left:18px" });
    order.diagnosticNotes.forEach((n, i) =>
      ul.append(el("li", { class: "small" }, n, " ",
        order.status !== "выдан" ? el("button", { class: "small", style: "border:0;background:none;color:var(--muted)", onclick: () => { editOrder(number, (o) => o.diagnosticNotes.splice(i, 1)); refresh(); } }, "✕") : null)));
    head.append(el("div", { class: "small", style: "margin-top:8px" }, el("span", { class: "muted" }, "Замечания с диагностики:"), ul));
  }

  // У выданного обращения без клиента и уточнений карточке нечего показать.
  const main = el("main", { class: "wrap" }, head.childElementCount ? head : null);
  // Закреплённая внизу экрана панель действий — как «Готово» на диагностике:
  // одна кнопка слева, другая справа (одна ведёт вперёд по стадиям, другая —
  // назад/в сторону), обе всегда в зоне досягаемости, даже если список работ
  // длинный и укатился за экран. Наполняется ниже, по статусу заявки.
  let actions = null;
  // Переход на новую стадию — это новый экран, тут скролл наверх уместен.
  const setStatus = (s, extra) => { editOrder(number, (o) => { o.status = s; if (extra) extra(o); }); render(viewOrder(number)); };

  if (order.status === "приём") {
    const onDiffSet = (code, di, st) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === code); if (x?.difficulties?.[di]) x.difficulties[di].state = st; }); refresh(); };
    const onDiffQty = (code, di, qty) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === code); if (x?.difficulties?.[di]) x.difficulties[di].qty = qty; }); refresh(); };
    main.append(stage("Диагностика и список работ",
      el("div", { class: "btn-row" },
        el("button", { class: "btn-primary", onclick: () => openDiagnostics() }, "Пройти диагностику"),
        el("button", { onclick: () => openPicker((pick) => { addItem(pick, "", true); refresh(); }) }, "+ работа")),
      itemList(order, false, { onRemove: removeItem, onSave: saveItemEdit, refresh, onDiffSet, onDiffQty }),
      totalRow(orderRangeAll(order), order.items.length, "Итого клиенту",
        minutesText(orderMinutes(order, false)) ? el("div", { class: "small muted" }, minutesText(orderMinutes(order, false))) : null),
      order.items.length
        ? el("button", { class: "btn-primary", style: "width:100%;margin-top:12px", onclick: () => setStatus("согласование") }, "К согласованию")
        : null));
  }

  if (order.status === "согласование") {
    const body = el("div", {});
    order.items.forEach((it) => {
      const r = itemRange(it);
      body.append(el("label", { class: "opt" },
        el("input", { type: "checkbox", checked: it.agreed, onchange: (e) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === it.code); if (x) x.agreed = e.target.checked; }); refresh(); } }),
        el("span", { style: "flex:1" }, el("b", {}, it.name), usesQuantity(it) && (it.qty || 1) > 1 ? ` × ${it.qty}` : "", el("br"),
          el("span", { class: "small muted" }, rangeText(r)))));
    });
    body.append(
      totalRow(range, 2, "Согласовано на",
        minutesText(orderMinutes(order, true)) ? el("div", { class: "small muted" }, minutesText(orderMinutes(order, true))) : null),
      el("button", {
        class: "btn-primary", style: "width:100%",
        onclick: () => setStatus("взята в работу", (o) => { o.occupiedBy = null; o.occupiedByName = ""; }),
      }, "В работу"));
    main.append(stage("Согласование с клиентом", body));
  }

  if (order.status === "взята в работу") {
    // Раньше заявку мог вести только один мастер одновременно — остальные
    // видели её только на чтение. Теперь несколько мастеров могут вести
    // заявку разом (нужно для повторяющихся работ — один экземпляр себе
    // забирает один мастер, другой экземпляр другой, см. repairGroupItem/
    // openRepairSheet). occupiedBy остаётся только информационной меткой
    // «кто сюда заходил», ни на что не влияет и ничего не блокирует.
    const leaveOrder = () => goBack("/");

    {
      // Склад почти всегда уже в кэше (его подтягивали раньше на этом же
      // экране) — строим список сразу, без заглушек-скелетонов: иначе каждое
      // «Готово»/«Отменить» дёргает refresh() → viewOrder() заново, и список
      // на миг мигает пустыми полосками вместо того, чтобы просто остаться
      // на месте с обновлённым пунктом.
      const buildBody = (stock) => {
        const b = el("div", {});
        const pendingCard = pendingAgreementCard(order, pendingHandlers, stock);
        if (pendingCard) b.append(pendingCard);
        // Разные экземпляры одной работы всегда остаются отдельными задачами.
        // Они могут иметь разных исполнителей, усложнения и запчасти, поэтому
        // не объединяем их общей карточкой и не прячем в карусель.
        order.items.filter((i) => i.agreed).sort(waitingLast).forEach((it) => {
          b.append(repairItem(it, stock, {
            onClaim: () => {
              if (!it.claimedBy && !it.done) {
                editOrder(number, (o) => {
                  const x = o.items.find((i) => i.code === it.code);
                  if (x && !x.claimedBy) x.claimedBy = { masterId: SESSION?.id, masterName: SESSION?.name };
                });
                refresh();
              }
            },
            onSave: (patch) => {
              editOrder(number, (o) => {
                const x = o.items.find((i) => i.code === it.code);
                if (x) Object.assign(x, patch);
              });
              refresh();
            },
            onQty: (it.claimedBy && it.claimedBy.masterId !== SESSION?.id && SESSION?.role !== "admin") ? null : (qty) => { editOrder(number, (o) => { const x = o.items.find((i) => i.code === it.code); if (x) { x.qty = qty; x.claimedBy ||= { masterId: SESSION?.id, masterName: SESSION?.name }; } }); refresh(); },
            onRemove: (!it.claimedBy || it.claimedBy.masterId === SESSION?.id || SESSION?.role === "admin") ? (code) => removeItem(code) : null,
          }));
        });
        // Итог по всем согласованным работам — раньше был только на отдельном
        // экране-смете, теперь его увели вместе с самим экраном; тут он нужен
        // так же, звонить клиенту с итоговой суммой можно прямо отсюда.
        const total = totalRow(range, order.items.filter((i) => i.agreed).length);
        if (total) b.append(total);
        return b;
      };
      const body = stockCache ? buildBody(stockCache) : el("div", {}, skeletonRows(2));
      if (!stockCache) ensureStock().then((s) => { body.replaceChildren(...buildBody(s).childNodes); reattachInlineWork(); });
      main.append(stage("Ремонт", body));
      // «+ доп. работа» — отдельным блоком под «Ремонт», а не последней
      // строкой в той же карточке со списком и итогом: это самостоятельное
      // действие, а не часть текущего наряда. Разворачивает список узлов
      // (Колёса, Тормоз…) прямо тут же (тот же mountDiagnostics, что и
      // в остальных местах приложения), его собственная закреплённая кнопка
      // «Готово» снизу заменяет собой «Выйти»/«Готово к выдаче», пока
      // развёрнуто; сам mountDiagnostics уже рисует свои карточки по узлам,
      // отдельная обёртка вокруг него не нужна.
      main.append(el("button", {
        style: "width:100%;margin-bottom:var(--sp-4)", onclick: openAddWorkBlocks,
      }, "+ Добавить работу"));
      const allDone = orderAllDone(order);
      // Кнопка видна всегда, но недоступна, пока не все работы отмечены
      // готовыми — так сразу понятно, что дальше по плану, а не как будто
      // кнопка «появляется из ниоткуда» в неожиданный момент.
      // Пока развёрнута «+ доп. работа» — снизу уже своя кнопка «Готово» от
      // mountDiagnostics, вторую закреплённую панель поверх неё не показываем.
      // Как только все согласованные работы отмечены готовыми, «Выдать
      // клиенту» становится доступна прямо тут — отдельного экрана-сметы
      // для этого больше нет, он показывал тот же список работ и итог,
      // что уже виден выше.
      actions = el("div", { class: "actions" }, el("div", { class: "actions-inner" },
        el("button", { onclick: leaveOrder }, "Выйти"),
        el("button", { class: "btn-ok", disabled: !allDone, onclick: openPayment }, "Оплатить")));
    }
  }

  if (order.status === "выдан") {
    const agreedItems = order.items.filter((i) => i.agreed);
    const itemsBlock = el("div", { class: "rows", style: "margin-top:8px" }, agreedItems.map(detailedItemRow));
    main.append(stage("Выдан", itemsBlock, totalRow(range, agreedItems.length)));
  }

  return [
    // Название велосипеда вместо номера обращения, покрупнее остальных
    // заголовков — по нему сразу видно, с чем работаешь. Номер обращения
    // нигде в интерфейсе не показываем — мастерам он не нужен, только путает.
    // «‹» — туда, откуда открыли обращение (главный, выполненные работы,
    // карточка клиента); если открыли по ссылке — на главный.
    el("header", { class: "bar" },
      backLink("/"),
      el("h1", { class: "bar-title-lg" }, bike ? bikeLabel(bike) : client?.name || order.clientName || "Обращение"),
      // Раньше — отдельная кнопка на всю ширину под «Уточнениями», ниже
      // текста и легко терялась. Карандаш в строке заголовка — тот же
      // паттерн, что и везде в приложении для «изменить», и сразу виден,
      // не занимая места среди самих данных заявки.
      order.status === "взята в работу" ? el("button", {
        class: "edit-btn", "aria-label": "Изменить клиента и велосипед", style: iconBtnStyle, html: ICON_EDIT, onclick: openOrderDetailsEditor,
      }) : null,
      order.status === "выдан" && (SESSION?.role === "admin" || canReopenIssued(order)) ? el("button", {
        class: "edit-btn", "aria-label": "Изменить выданное обращение", style: iconBtnStyle, html: ICON_EDIT,
        onclick: () => openIssuedOrderSheet(order),
      }) : null),
    main,
    actions,
  ];
}

// Выданное обращение — учётная запись (выработка мастеров, выгрузка в 1С).
// Ошибочную выдачу можно откатить, пока обращение не прошло через 1С:
// администратор — всегда, мастер — свою и в первые 15 минут. Те же правила
// проверяет сервер (api/_issued-order.js), тут — только что показывать.
const ISSUED_REOPEN_WINDOW_MS = 15 * 60 * 1000;
const issuedIn1C = (o) => !!o.fiscalReceipt || !!o.exportedTo1C;
function canReopenIssued(o) {
  if (issuedIn1C(o)) return false;
  if (SESSION?.role === "admin") return true;
  return o.handedOverBy?.masterId === SESSION?.id &&
    Date.now() - Date.parse(o.handedOverAt || "") <= ISSUED_REOPEN_WINDOW_MS;
}
function openIssuedOrderSheet(order) {
  let sheet;
  const reopen = () => askDialog({
    title: "Вернуть обращение в работу?",
    message: "Выдача отменится, обращение снова появится на главном — его можно будет изменить и выдать заново.",
    yes: "Вернуть", no: "Отмена",
    onYes: async () => {
      const res = await reopenOrderApi(order.number);
      if (!res.ok) return toast("Не получилось: " + res.error);
      sheet?.close();
      toast("Обращение снова в работе");
      router();
    },
  });
  const remove = () => askDialog({
    title: "Удалить обращение насовсем?",
    message: "Оно пропадёт из выполненных работ и выработки мастеров. Вернуть будет нельзя.",
    yes: "Удалить", no: "Отмена",
    onYes: async () => {
      armShakeForDelete();
      if (!(await deleteOrderApi(order.number))) return toast("Не получилось удалить — проверьте связь и права");
      sheet?.close();
      rememberDeleted(order);
      toast("Обращение удалено");
      goBack("/");
    },
  });
  const body = issuedIn1C(order)
    ? el("p", { class: "muted", style: "margin:0 0 8px" },
        order.fiscalReceipt
          ? "Оплата прошла через кассу 1С — это обращение менять нельзя. Если оплата ошибочная, сначала отмените чек в 1С."
          : "Обращение уже выгружено в 1С — менять его нельзя. Если оно ошибочное, сначала исправьте документ в 1С.")
    : el("div", {},
        el("p", { class: "muted", style: "margin:0 0 14px" },
          "Выдача прошла не через 1С — её можно отменить: вернуть обращение в работу, чтобы исправить, или удалить совсем (например, тестовое)."),
        el("button", { class: "btn-primary", style: "width:100%", onclick: reopen }, "Вернуть в работу"),
        SESSION?.role === "admin"
          ? el("button", { class: "btn-warn", style: "width:100%;margin-top:10px", onclick: remove }, "Удалить обращение")
          : null);
  sheet = openSheet("Обращение выдано", body);
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
function partsEditor(parts, stock, onChange, blockId, sideAction = null) {
  // Раньше уже добавленные запчасти шли просто списком сразу под результатами
  // поиска — без подписи и без рамок между строками всё сливалось в один
  // нечитаемый блок, особенно с длинными названиями в 3-4 строки. Теперь у
  // добавленного — свой заголовок и оформление списком, как везде в
  // приложении (граница + тонкий разделитель между строками).
  const listLabel = el("p", { class: "small muted", style: "margin:16px 0 4px" }, "Добавлено к этой работе");
  const list = el("div", { class: "rows" });
  // Цена запчасти в наряде может отличаться от складской (скидка клиенту,
  // ручная позиция без цены на складе и т.п.) — тап по цене открывает поле
  // прямо в строке, без отдельной формы.
  const editingPriceFor = new Set();
  const drawList = () => {
    listLabel.style.display = parts.length ? "" : "none";
    list.style.display = parts.length ? "" : "none";
    list.replaceChildren(...parts.map((p, i) => el("div", { class: "row", style: "cursor:default;gap:8px" },
      el("span", { style: "flex:1;min-width:0" }, p.name),
      editingPriceFor.has(i)
        ? el("input", {
            type: "number", value: p.price, style: "width:76px;text-align:right;flex:0 0 auto",
            // drawList() отложен на тик: он заменяет этот же <input> целиком
            // (replaceChildren), а onchange у iOS/Safari срабатывает как раз
            // при потере фокуса — синхронная замена элемента изнутри его
            // собственного blur-обработчика гоняется с браузером за узел и
            // изредка валит "node no longer a child of this node".
            onchange: (e) => {
              p.price = Math.max(0, +e.target.value || 0);
              editingPriceFor.delete(i);
              onChange();
              setTimeout(drawList, 0);
            },
          })
        : el("button", {
            class: "small muted", style: "border:0;background:none;padding:0;text-decoration:underline dotted;flex:0 0 auto",
            onclick: () => { editingPriceFor.add(i); drawList(); },
          }, money(p.price)),
      qtyStepper(p.qty, (qty) => { p.qty = qty; drawList(); onChange(); }, p.maxQty,
        () => { parts.splice(i, 1); drawList(); drawResults(); onChange(); }))));
  };
  drawList();

  // Своя запчасть — не из остатков (например деталь, которой нет на складе,
  // купленная под заказ). Название и цена вписываются вручную, sku пустой —
  // такую позицию не с чем сопоставить в остатках/1С, только строкой в наряде.
  let manualOpen = false;
  const manualDraft = { name: "", price: 0 };
  const manualBox = el("div", { style: "margin-top:8px" });
  const drawManual = () => {
    if (!manualOpen) return manualBox.replaceChildren();
    manualBox.replaceChildren(el("div", { class: "card card-flush" },
      el("label", {}, "Название запчасти"),
      el("input", { placeholder: "напр. Прокладка", value: manualDraft.name, oninput: (e) => (manualDraft.name = e.target.value) }),
      el("label", { style: "margin-top:8px" }, "Цена, ₽"),
      el("input", { type: "number", value: manualDraft.price || "", oninput: (e) => (manualDraft.price = +e.target.value || 0) }),
      el("div", { class: "btn-row", style: "margin-top:10px" },
        el("button", {
          class: "btn-primary", onclick: () => {
            if (!manualDraft.name.trim()) return alert("Укажите название");
            parts.push({ name: manualDraft.name.trim(), sku: "", price: manualDraft.price, qty: 1, maxQty: 0 });
            manualOpen = false; manualDraft.name = ""; manualDraft.price = 0;
            drawManual(); drawList(); onChange();
          },
        }, "Добавить"),
        el("button", { onclick: () => { manualOpen = false; drawManual(); } }, "Отмена"))));
  };
  const manualToggle = el("button", {
    class: "small parts-text-action",
    onclick: () => { manualOpen = !manualOpen; drawManual(); },
  }, "+ запчасть");

  // maxQty — необязательный потолок у складской позиции (спицы можно взять
  // 64, а цепь — только одну); переносим на саму запчасть в наряде, чтобы
  // qtyStepper мог его учитывать и после того, как список остатков закрыт.
  const isAdded = (s) => parts.some((p) => p.name === s.name && p.price === (s.price || 0));
  const addPart = (s) => {
    const existing = parts.find((p) => p.name === s.name && p.price === (s.price || 0));
    if (existing) existing.qty = Math.min((existing.qty || 1) + 1, existing.maxQty || Infinity);
    // sku — артикул со склада, тот же, что видит 1С: без него списанную
    // запчасть в наряде нечем сопоставить с позицией номенклатуры при
    // выгрузке (см. api/1c-export.js), сверяться по одному названию
    // ненадёжно — оно может разойтись, если название в остатках потом
    // поправят.
    else parts.push({ name: s.name, sku: s.sku || "", price: s.price || 0, qty: 1, maxQty: s.maxQty || 0 });
    drawList();
    drawResults();
    onChange();
    toast(`Добавлено: ${s.name}`);
  };

  // Список ничего не показывает, пока не начали вводить — только результаты
  // поиска, без списка «по умолчанию» (на реальном складе он либо пуст, либо
  // показывает произвольные позиции не в тему). Пока не расширили поиск
  // вручную — ищем только в узле этой работы (тормоз чиним — среди тормозных),
  // не по всему складу. Если работа не привязана ни к какому узлу (свой/старый
  // пункт) — сразу ищем по всем остаткам, сужать нечем.
  let wide = !blockId;
  const q = el("input", { type: "text", placeholder: "Поиск детали по названию" });
  const clearBtn = el("button", {
    type: "button", class: "search-clear", html: ICON_CLOSE, style: "display:none",
    onclick: () => { q.value = ""; clearBtn.style.display = "none"; drawResults(); q.focus(); },
  });
  const results = el("div", { class: "rows parts-results" });
  const widenLink = el("p", { class: "small", style: "margin-top:2px" },
    el("a", { href: "#", onclick: (e) => { e.preventDefault(); wide = true; drawResults(); } }, "Искать среди всех остатков →"));
  const drawResults = () => {
    const query = q.value.trim().toLowerCase();
    // Пустая рамка без строк смотрится как лишняя полоска — прячем блок
    // целиком, когда показывать нечего, а не просто очищаем содержимое.
    // Подсказки — только с трёх символов: по одной-двум буквам совпадает
    // почти весь склад, список бесполезно мелькает при каждом нажатии.
    if (query.replace(/\s+/g, "").length < 3) { results.style.display = "none"; results.replaceChildren(); return; }
    results.style.display = "";
    if (!stock.length) { results.replaceChildren(el("p", { class: "small muted", style: "padding:10px 0" }, "Остатки пусты.")); return; }
    const scoped = wide ? stock : stock.filter((s) => s.group === blockId);
    // Уже добавленное не повторяем в результатах — и так видно ниже, в
    // «Добавлено», где у него есть свой счётчик количества с «+».
    const matched = scoped.filter((s) => !isAdded(s) && matchesQuery(query, s.name, s.sku)).slice(0, 40);
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
  q.addEventListener("input", () => { clearBtn.style.display = q.value ? "" : "none"; drawResults(); });
  drawResults();

  return el("div", {}, el("div", { class: "search-wrap" }, q, clearBtn), results,
    el("div", { class: sideAction ? "parts-action-row" : "parts-action-row parts-action-single" }, manualToggle, sideAction),
    manualBox, listLabel, list);
}

function itemRow(it, showFacts) {
  return el("div", { class: "row", style: "cursor:default;align-items:flex-start" },
    el("span", { style: "flex:1" }, it.name,
      usesQuantity(it) && (it.qty || 1) > 1 ? el("span", { class: "small muted" }, ` × ${it.qty}`) : null,
      showFacts && !it.agreed ? el("span", { class: "pill", style: "background:var(--fill);color:var(--muted)" }, "не согласовано") : null,
      it.notes ? el("span", { class: "small muted" }, el("br"), it.notes) : null,
      showFacts && it.done && (it.parts.length || it.doneBy) ? el("span", { class: "small muted" }, el("br"),
        [it.parts.length ? it.parts.map(partLabel).join(", ") : null, completionsSummary(it)].filter(Boolean).join(" · ")) : null),
    el("div", { class: "price-row" }, itemPriceTags(it)));
}

// Счётчик количества (сколько раз сделана работа/усложнение — два колеса,
// несколько спиц и т.п.). Показывается только когда у работы или усложнения
// стоит галочка «несколько», иначе количество всегда 1 и не отображается.
// max — необязательный потолок (например, у запчасти на складе); 0/undefined
// значит без ограничения. При достижении потолка «+» просто отключается —
// это подстраховка от случайного «натыкал лишнего», а не жёсткий запрет.
// onRemove — необязательный: если задан, «−» при количестве 1 убирает
// позицию целиком. Сам элемент всегда остаётся одной капсулой «− 1 +», как
// счётчик количества в корзинах приложений доставки.
function qtyStepper(value, onChange, max, onRemove) {
  const atMax = max > 0 && (value || 1) >= max;
  const atMin = (value || 1) <= 1;
  const removesAtMin = atMin && onRemove;
  return el("div", { class: "qty-stepper", onclick: (e) => e.stopPropagation() },
    el("button", {
      type: "button",
      "aria-label": removesAtMin ? "Убрать" : "Уменьшить",
      disabled: atMin && !onRemove,
      onclick: () => { if (removesAtMin) onRemove(); else onChange(Math.max(1, (value || 1) - 1)); },
    }, "−"),
    el("span", { class: "qty-stepper-value" }, String(value || 1)),
    el("button", { type: "button", "aria-label": "Увеличить", disabled: atMax,
      onclick: () => onChange(max > 0 ? Math.min(max, (value || 1) + 1) : (value || 1) + 1) }, "+"));
}

// Одна кнопка выбора для работ и усложнений. В невыбранном состоянии это
// «+», в выбранном — «×». Раньше одинаковая кнопка собиралась отдельно на
// экране приёмки и в карточке ремонта, поэтому правки размера и скругления
// приходилось повторять в нескольких местах.
function addRemoveControl(selected, onChange, ariaLabel, disabled = false) {
  return el("button", {
    type: "button",
    class: "work-select-btn" + (selected ? " selected" : ""),
    disabled,
    "aria-label": ariaLabel,
    onclick: (e) => { e.stopPropagation(); onChange(!selected); },
  }, selected ? "×" : "+");
}

// Как работа считается в наряде. Одинаковые экземпляры повторяют целиком
// одну работу с общей карточкой и мастером. Новую независимую задачу мастер
// добавляет повторным выбором этой работы из каталога.
// Описание работы (что в неё входит) — заводит администратор в каталоге.
// Обычно нигде не показывается, только в меню усложнений работы. Берём из
// каталога по коду, чтобы правка описания сразу была видна и в уже
// созданных нарядах.
function workDescription(it) {
  const code = it.sourceCode || it.code;
  return (repairsCache || []).find((r) => `CF-${r.id}` === code)?.description || "";
}
function workDescriptionNode(it) {
  const text = workDescription(it);
  return text ? el("p", { class: "work-description" }, text) : null;
}
function descriptionField(draft) {
  return [el("label", { style: "margin-top:8px" }, "Описание"),
    el("textarea", { rows: 3, value: draft.description || "", placeholder: "Что входит в работу — мастер увидит в меню усложнений",
      oninput: (e) => (draft.description = e.target.value) })];
}
function quantityModeEditor(draft) {
  const fieldName = `quantity-mode-${Math.random().toString(36).slice(2)}`;
  const modes = [
    ["single", "Один раз · 1", "Одна задача, один исполнитель"],
    ["instances", "Одинаковые экземпляры · до 5", "Одна строка, общие усложнения, запчасти и мастер"],
    ["quantity", "Общим количеством · до 64", "Одна операция × количество, один исполнитель"],
  ];
  const choices = el("div", { class: "quantity-mode-list" },
    ...modes.map(([value, title, hint]) => el("label", { class: "opt quantity-mode-row" },
      el("input", {
        type: "radio", name: fieldName, value, checked: draft.quantityMode === value,
        onchange: () => {
          draft.quantityMode = value;
          draft.maxInstances = value === "instances" ? WORK_INSTANCE_LIMIT : 0;
        },
      }),
      el("span", { style: "line-height:1.25" }, title,
        el("span", { class: "small muted", style: "display:block;margin-top:5px;line-height:1.4" }, hint)))));
  draft.maxInstances = instanceLimitOf(draft);
  return el("div", { style: "margin-top:18px;margin-bottom:4px" },
    el("label", { style: "display:block;margin:0" }, "Как учитывать работу"), choices);
}

// Редактор списка усложнений (название + надбавка к цене + надбавка к времени
// + «неск.») — общий для форм правки работы каталога, своей неисправности и
// позиции наряда. Мутирует list на месте, box перерисовывается сам.
function complicationsEditor(list) {
  const box = el("div", {});
  // Каждое усложнение — своим блоком: название на всю ширину, ниже два
  // обычных поля (надбавка и время) с подписями, крупная галочка «несколько
  // раз». Раньше всё было мелкими полями в одну строку и не читалось.
  const numField = (label, value, suffix, aria, onInput) => el("div", { class: "complication-num" },
    el("label", {}, label),
    el("div", { class: "complication-num-box", style: `--sfx:${suffix.length}` },
      el("input", { type: "number", inputmode: "numeric", value, "aria-label": aria, oninput: (e) => onInput(+e.target.value || 0) }),
      el("span", { class: "complication-num-suffix" }, suffix)));
  const draw = () => {
    box.replaceChildren(
      ...list.map((c, ci) => el("div", { class: "complication-edit-item" },
        el("div", { class: "complication-edit-head" },
          el("input", { placeholder: "Название усложнения", value: c.label, oninput: (e) => (c.label = e.target.value) }),
          el("button", { class: "complication-remove", "aria-label": "Удалить усложнение", html: ICON_CLOSE, onclick: () => { list.splice(ci, 1); draw(); } })),
        el("div", { class: "complication-edit-nums" },
          numField("Надбавка", c.add || "", "₽", "Надбавка в рублях", (v) => (c.add = v)),
          numField("Время", c.addMinutes || "", "мин", "Надбавка во времени", (v) => (c.addMinutes = v))),
        el("label", { class: "complication-multiple" },
          el("input", { class: "chk", type: "checkbox", checked: !!c.multiple, onchange: (e) => (c.multiple = e.target.checked) }),
          el("span", {}, "Может быть несколько раз")))),
      el("button", { class: "complication-add", onclick: () => { list.push({ label: "", add: 0, addMinutes: 0, multiple: false }); draw(); } }, "+ Добавить усложнение"),
    );
  };
  draw();
  return box;
}

// Строка работы в наряде на стадии «приём» — можно убрать (✕) или изменить
// название/цену/время/усложнения (✎), не выходя из наряда. Количество и то,
// какие усложнения ожидаются (будет/не будет/неизвестно) — сразу видны и
// настраиваются тут же, прямо в списке, без отдельного экрана-дубликата.
function editableItemRow(it, { onRemove, onSave, refresh, onDiffSet, onDiffQty }) {
  const isEditing = editingItemCode === it.code;
  // Имя — на своей строке (растягивается на всю ширину, переносится
  // предсказуемо), цена/счётчик количества — строкой ниже, всегда в одном
  // и том же порядке независимо от длины названия. ✎/✕ — как везде в
  // приложении, за свайпом влево, а не отдельными кнопками в строке.
  const rowContent = el("div", { class: "row", style: "align-items:flex-start;flex-direction:column;gap:6px" },
    el("span", { style: "width:100%" }, it.name, it.notes ? el("span", { class: "small muted" }, el("br"), it.notes) : null),
    el("div", { style: "display:flex;align-items:center;gap:10px;width:100%" },
      usesQuantity(it) ? qtyStepper(it.qty, (qty) => onSave(it.code, { qty }), workQuantityLimitOf(it), () => onRemove(it.code)) : null,
      el("div", { class: "price-row", style: "margin-left:auto" }, itemPriceTags(it))));
  const header = swipeActions(rowContent, [
    { label: ICON_EDIT, ariaLabel: "Изменить работу", onClick: () => { editingItemCode = isEditing ? null : it.code; refresh(); } },
    { label: ICON_CLOSE, ariaLabel: "Убрать работу", className: "warn", onClick: () => { if (confirm(`Убрать «${it.name}» из обращения?`)) onRemove(it.code); } },
  ]);
  const diffs = (it.difficulties || []).length
    ? el("div", { style: "width:100%;margin-top:2px" },
        difficultyList(it.difficulties, (di, st) => onDiffSet(it.code, di, st), (di, qty) => onDiffQty(it.code, di, qty), false))
    : null;
  if (!isEditing) return el("div", {}, header, diffs);

  const d = {
    name: it.name, workPrice: it.workPrice || 0, estimateMinutes: it.estimateMinutes || 0, notes: it.notes || "",
    difficulties: JSON.parse(JSON.stringify(it.difficulties || [])),
  };
  const compsBox = complicationsEditor(d.difficulties);
  const form = el("div", { class: "card card-flush", style: "margin-top:8px" },
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
  return el("div", {}, header, diffs, form);
}

// Наряд сгруппирован по узлам велосипеда (блоки диагностики), порядок — как в diagnostics.json.
// edit — {onRemove, onSave, refresh, onDiffSet, onDiffQty}: если передан, работы
// на стадии «приём» можно убрать, изменить или отметить усложнения прямо в списке.
// grouped=false — плоский список без заголовков по узлам (КОЛЁСА, ПРОЧЕЕ…),
// просто список работ; так, например, показан уже добавленный в наряд
// список прямо на диагностике — там это не нужно, там и так одна тема.
function itemList(order, showFacts, edit, detailed, grouped = true) {
  if (order.items.length === 0) return emptyState("Работ пока нет.");
  const row = (it) => (edit ? editableItemRow(it, edit) : detailed ? detailedItemRow(it) : itemRow(it, showFacts));
  if (!grouped) return el("div", { class: "rows", style: "margin-top:8px" }, [...order.items].sort(waitingLast).map(row));
  const groups = groupBy(order.items, (it) => blockOf(it.code));
  const box = el("div", { style: "margin-top:8px" });
  for (const title of [...BLOCK_TITLES, "Прочее"]) {
    const list = groups.get(title);
    if (!list || !list.length) continue;
    box.append(
      el("p", { class: "small muted", style: "margin:14px 0 4px;letter-spacing:.05em" }, title.toUpperCase()),
      el("div", { class: "rows" }, [...list].sort(waitingLast).map(row)));
  }
  return box;
}

// Разбивка стоимости работы по составляющим — сама работа, каждая запчасть
// (с ценой и количеством) и каждое подтвердившееся усложнение отдельной
// строкой. Общая для списков «в работе» и «выдан», чтобы мастер сразу видел,
// из чего складывается сумма, не открывая форму по каждому пункту.
function costLines(it) {
  const qty = it.qty || 1;
  const wholeItemQty = repeatsWholeItem(it) ? qty : 1;
  const lines = [`работы ${money((it.workPrice || 0) * qty)}`];
  for (const p of it.parts || []) lines.push(`${partLabel(p)} ${money((p.price || 0) * (p.qty || 1) * wholeItemQty)}`);
  if (it.partsPrice) lines.push(`запчасти ${money(it.partsPrice * wholeItemQty)}`);
  for (const d of it.difficulties || []) {
    if (d.state === "yes") lines.push(`${d.label} ${money((d.add || 0) * (d.qty || 1) * wholeItemQty)}`);
  }
  return lines;
}

function costBreakdown(it) {
  return el("div", { class: "small muted", style: "margin-top:4px" },
    costLines(it).map((line) => el("div", {}, "– " + line)));
}

function workStatePill(it) {
  if (it.waitingForPart && !it.done) {
    return el("span", { class: "pill", style: "background:var(--yellow-weak);color:var(--yellow-ink)" }, "ждёт запчасть");
  }
  if (it.done) return el("span", { class: "pill" }, it.doneBy?.masterName || completionsSummary(it) || "Готово");
  if (it.claimedBy) return el("span", { class: "pill pill-muted" }, it.claimedBy.masterName || "Занята");
  return el("span", { class: "pill pill-muted" }, "Свободно");
}

// Та же вёрстка, что у repairItem («В работе») — только без клика на форму
// (тут карточка для сверки перед звонком клиенту/выдачей, редактировать
// нечего): имя+статус «готово» одной строкой, сумма отдельной строкой
// покрупнее, разбивка по составляющим ниже. Раньше была своя, более сжатая
// вёрстка — то же самое выглядело по-разному в двух соседних стадиях.
function detailedItemRow(it) {
  const nameRow = el("div", { style: "display:flex;align-items:center;gap:8px" },
    el("b", { style: "flex:1;min-width:0" }, it.name, usesQuantity(it) && (it.qty || 1) > 1 ? el("span", { class: "small muted" }, ` × ${it.qty}`) : null),
    workStatePill(it));
  return el("div", { class: "assess" },
    nameRow,
    costBreakdown(it),
    it.notes ? el("p", { class: "small muted", style: "margin-top:4px" }, it.notes) : null,
    priceRow(it, "margin-top:16px"));
}

// Список усложнений — на «Оценке» (прикидка для клиента, ещё не известно
// наверняка) три варианта: будет/не будет/неизвестно. При отметке работы
// готовой (fact=true) — уже по факту, там только было/не было, «неизвестно»
// не бывает для завершённой работы.
const DIFFICULTY_STATE_LABELS = { yes: "будет", no: "не будет", unknown: "неизвестно" };
const DIFFICULTY_FACT_LABELS = { yes: "было", no: "не было" };

// Общие элементы усложнения для приёмки и ремонта. Режимы отличаются только
// способом выбора состояния; количество, итоговая надбавка и строка одни и те
// же, чтобы правки внешнего вида и расчёта не расходились между экранами.
const difficultyQty = (d) => d.multiple ? Math.max(1, d.qty || 1) : 1;
const difficultyAmount = (d) => (d.add || 0) * difficultyQty(d);
const difficultyMinutes = (d) => (d.addMinutes || 0) * difficultyQty(d);

// Цена рядом с кнопкой или счётчиком. Компонент сам задаёт размер, фон и
// скругление, поэтому он одинаков независимо от того, где находится:
// в приёмке, усложнениях или ремонте.
function controlPriceTag(text, included = true) {
  return el("span", { class: "control-price" + (included ? "" : " excluded") }, text);
}
// Цена работы пузырём; если в ней есть запчасти — слева отдельный пузырь
// запчастей другим цветом, чтобы сразу было видно, что за труд, а что за
// детали.
function itemPriceTags(it, included = true) {
  const parts = itemPartsCost(it);
  const r = itemRange(it);
  return [
    parts > 0 ? el("span", { class: "control-price parts" + (included ? "" : " excluded"), title: "Запчасти" },
      el("span", { class: "price-icon", html: ICONS.stock }), money(parts)) : null,
    controlPriceTag(rangeText({ min: r.min - parts, max: r.max - parts }), included),
  ];
}
// Сумма по нескольким позициям одной работы (экземпляры) + сколько из неё
// приходится на запчасти — для раздельных ценников в списке выбора работ.
const itemsRangeWithParts = (items) => items.reduce((a, it) => {
  const r = itemRange(it);
  return { min: a.min + r.min, max: a.max + r.max, parts: a.parts + itemPartsCost(it) };
}, { min: 0, max: 0, parts: 0 });
const priceRow = (it, style = "") => el("div", { class: "price-row", style }, itemPriceTags(it));
// «Итого» тем же пузырём, что и цены работ, только крупнее. Для наряда из
// одной работы не показывается — её цена и так видна прямо над ним.
// onTap — необязательный: цена становится нажимаемой (например, открыть
// список выбранных работ).
function totalRow(range, count, label = "Итого", extra = null, onTap = null) {
  if (count < 2) return null;
  return el("div", { class: "total-row" },
    el("div", {}, el("span", { class: "muted" }, label), extra),
    el("span", { class: "control-price control-price-lg" + (onTap ? " tap" : ""), onclick: onTap }, rangeText(range)));
}
function difficultyPriceTag(d) {
  return controlPriceTag(`+${money(difficultyAmount(d))}`, d.state === "yes");
}
function difficultyStateToggle(d, labels, onSet) {
  const symbols = { yes: "✓", no: "×", unknown: "?" };
  return el("div", { class: "segmented difficulty-state-toggle" },
    Object.entries(labels).map(([value, label]) => el("button", {
      type: "button",
      class: d.state === value ? `active sel-${value}` : "",
      title: label,
      "aria-label": `${d.label}: ${label}`,
      onclick: () => onSet(value),
    }, symbols[value])));
}
function difficultyQtyStepper(d, onQty, onClear) {
  return qtyStepper(difficultyQty(d), onQty, 0, onClear);
}
function pricedControlGroup(price, action) {
  return el("div", { class: "priced-control-group" }, price, action);
}

function difficultyList(difficulties, onSet, onQty, fact) {
  const labels = fact ? DIFFICULTY_FACT_LABELS : DIFFICULTY_STATE_LABELS;
  const box = el("div", {});
  (difficulties || []).forEach((d, di) => {
    const done = d.state === "yes";
    // По факту (fact=true, «Отметить готово») — тот же счётчик, что и у
    // самих работ в списке на «Новый наряд»: не отмечено — «+», отмечено и
    // можно несколько раз — счётчик с корзиной вместо минуса на единице,
    // иначе просто «+/×». Раньше тут был отдельный тумблер и, если можно
    // несколько, ещё отдельный счётчик отдельной строкой ниже — два разных
    // элемента на одно и то же состояние.
    // Повторяемое усложнение во всех режимах управляется одним и тем же
    // счётчиком: нет числа — не выбрано, есть число — входит в стоимость.
    // Тройное состояние нужно только обычному усложнению на этапе приёмки.
    const multipleControl = d.multiple
      ? (done
          ? difficultyQtyStepper(d, (qty) => onQty(di, qty), () => onSet(di, "no"))
          : addRemoveControl(false, () => onSet(di, "yes"), `${d.label}: добавить`))
      : null;
    const factControl = !fact || d.multiple ? null : addRemoveControl(done,
      (selected) => onSet(di, selected ? "yes" : "no"),
      `${d.label}: ${done ? "было" : "не было"}`);
    const stateControl = multipleControl || (fact ? factControl : difficultyStateToggle(d, labels, (state) => onSet(di, state)));
    const addedMinutes = difficultyMinutes(d);
    box.append(el("div", { style: "margin-top:8px" },
      el("div", {
        class: "priced-control-row difficulty-row",
        style: fact ? "cursor:pointer" : "",
        onclick: fact ? (e) => {
          // Плюс, крестик и счётчик обрабатывают нажатие сами. Остальная
          // площадь строки переключает усложнение целиком, как работа в
          // списке новой приёмки.
          if (e.target.closest("button")) return;
          onSet(di, done ? "no" : "yes");
        } : null,
      },
        el("div", { class: "small", style: "flex:1;min-width:0" },
          d.label,
          addedMinutes ? el("span", { class: "muted" }, ` (+${addedMinutes} мин)`) : null),
        pricedControlGroup(difficultyPriceTag(d), stateControl))));
  });
  return box;
}

// Работа, добавленная уже после исходного согласования (доп. работа в
// ремонте, находка на повторной диагностике) — не считается в «Итого» и
// не попадает в список ремонта, пока мастер явно не отметит «Согласовано»
// (позвонив клиенту). Без этого шага работа просто предлагается молча —
// то как «+ доп. работа», то как невидимая навсегда, — и тут явный шаг
// нужен в обоих случаях одинаково.
function pendingAgreementRow(it, { onAgree, onRemove, onSet, onDiffQty, onParts }, stock) {
  const box = el("div", { class: "assess", "data-work-key": it.code, "data-hide-actions": "1" });
  const nameRow = el("div", {
    style: "display:flex;align-items:center;gap:8px;cursor:pointer",
    onclick: () => isInlineOpen(it.code) ? closeInlineWork() : openPendingSheet(it, stock, { onSet, onDiffQty, onParts }),
  },
    el("b", { style: "flex:1;min-width:0" }, it.name, usesQuantity(it) && (it.qty || 1) > 1 ? el("span", { class: "small muted" }, ` × ${it.qty}`) : null),
    el("span", { class: "work-chev" }, "›"));
  box.append(nameRow, priceRow(it, "margin-top:6px"));
  // «Согласовано»/«Убрать» — основное действие для этой карточки, оставляем
  // видимым сразу на строке, не прячем за открытием формы деталей.
  box.append(el("div", { class: "btn-row", style: "margin-top:10px" },
    el("button", { class: "btn-ok", onclick: () => onAgree(it.code) }, "Согласовано"),
    el("button", { onclick: () => { if (confirm(`Убрать «${it.name}» из обращения?`)) onRemove(it.code); } }, "Убрать")));
  return box;
}

// Форма деталей для «Ждёт согласования» — усложнения (прогноз) и запчасти
// на вкладках, тем же bottom sheet, что и у согласованной работы.
const carouselPanelOffset = (track, index) => {
  const panels = [...(track?.querySelectorAll(".instance-panel") || [])];
  return panels[index] ? panels[index].offsetLeft - (panels[0]?.offsetLeft || 0) : 0;
};
const carouselNearestIndex = (track, count) => {
  const panels = [...(track?.querySelectorAll(".instance-panel") || [])];
  if (!panels.length) return 0;
  let nearest = 0;
  for (let i = 1; i < Math.min(count, panels.length); i += 1) {
    if (Math.abs(carouselPanelOffset(track, i) - track.scrollLeft) < Math.abs(carouselPanelOffset(track, nearest) - track.scrollLeft)) nearest = i;
  }
  return nearest;
};

// Работа раскрывается прямо в списке, под своей строкой, а не шторкой
// снизу: экран подкручивается так, чтобы её заголовок встал первым под
// шапкой, порядок работ не меняется. Строка помечена data-work-key (см.
// repairItem/pendingAgreementRow). Экран обращения перерисовывается на
// каждую правку (refresh) — тот же узел с содержимым просто заново
// подвешивается под новую строку (render → reattachInlineWork), поэтому
// состояние внутри (экземпляр в карусели, введённое) не теряется. Где такой
// строки нет (приёмка, «Добавить работу») — как раньше, шторкой.
let inlineWork = null; // { key, panel, close }
const workRowFor = (key) => [...app.querySelectorAll("[data-work-key]")].find((n) => n.dataset.workKey === key) || null;
function reattachInlineWork() {
  if (!inlineWork) return;
  const row = workRowFor(inlineWork.key);
  if (!row) { inlineWork = null; document.body.classList.remove("work-inline-open"); return; }
  row.classList.add("work-open");
  row.parentElement.classList.add("has-open-work");
  row.after(inlineWork.panel);
  // Нижние кнопки экрана прячем только там, где у раскрытого своя главная
  // кнопка (работа в обращении — «Отметить готово»).
  document.body.classList.toggle("work-inline-open", row.dataset.hideActions === "1");
}
const isInlineOpen = (key) => inlineWork?.key === key;
function closeInlineWork() { inlineWork?.close(); }
// Подкрутить экран так, чтобы node встал первым под шапкой. Если ниже не
// хватает высоты — запас снизу у slack (до следующей перерисовки).
function scrollUnderBar(node, slack) {
  // Высота страницы не меньше экрана, поэтому первый добавленный отступ
  // может «съесться» — добираем за пару кадров, пока хватит.
  const step = (n) => requestAnimationFrame(() => {
    const barH = document.querySelector("header.bar")?.offsetHeight || 0;
    const top = Math.max(0, node.getBoundingClientRect().top + window.scrollY - barH - 8);
    const lack = top + window.innerHeight - document.documentElement.scrollHeight;
    if (lack > 0 && slack && n < 4) {
      slack.style.paddingBottom = `${(parseFloat(getComputedStyle(slack).paddingBottom) || 0) + Math.ceil(lack)}px`;
      return step(n + 1);
    }
    window.scrollTo({ top, behavior: "smooth" });
  });
  step(0);
}
// Раскрыть content под строкой с data-work-key=key; нет строки — шторкой.
function presentInline(key, title, content) {
  closeInlineWork();
  const row = workRowFor(key);
  if (!row) return openSheet(title, content);
  const panel = el("div", { class: "work-inline" }, content);
  const handle = {
    key, panel,
    close() {
      if (inlineWork !== handle) return;
      inlineWork = null;
      panel.remove();
      document.body.classList.remove("work-inline-open");
      const r = workRowFor(key);
      r?.classList.remove("work-open");
      r?.parentElement?.classList.remove("has-open-work");
    },
  };
  inlineWork = handle;
  reattachInlineWork();
  scrollUnderBar(row, row.closest("main") || panel);
  return handle;
}
const presentWork = (it, content) => presentInline(workRowFor(it.code) || !it.sourceCode ? it.code : it.sourceCode, it.name, content);

// Усложнения и запчасти — подряд, каждое под своим заголовком (раньше —
// переключатель-вкладки, и половину всегда было не видно).
const workSection = (title, ...kids) => el("div", { class: "work-section" }, el("h3", { class: "sheet-section-title" }, title), ...kids);

function openPendingSheet(it, stock, { onSet, onDiffQty, onParts }, siblings = [it]) {
  let items = siblings.length ? siblings : [it];
  let activeIndex = Math.max(0, items.findIndex((x) => x.code === it.code));
  // Вкладка принадлежит экземпляру и едет вместе с ним в карусели. Так при
  // свайпе меняется вся карточка, а не только содержимое под общим тумблером.
  const content = el("div", {});
  let sheet, track;
  let syncingScroll = false;
  // Прыжок к экземпляру: смахивание пальцем — обычный горизонтальный скролл
  // со scroll-snap (нативный, без своего жеста), тут только для тапа по
  // точке-индикатору — те же координаты, что расставил браузер по снапу.
  function scrollToIndex(index, smooth) {
    if (!track) return;
    syncingScroll = true;
    const left = carouselPanelOffset(track, index);
    if (smooth) track.scrollTo({ left, behavior: "smooth" });
    else track.scrollLeft = left;
    setTimeout(() => { syncingScroll = false; }, smooth ? 260 : 0);
  }
  function panelFor(instance) {
    const hasDiffs = (instance.difficulties || []).length > 0;
    return el("div", { class: "instance-panel" },
      workDescriptionNode(instance),
      hasDiffs ? workSection("Усложнения",
        difficultyList(instance.difficulties, (di, st) => { onSet(instance.code, di, st); draw(); }, (di, qty) => { onDiffQty(instance.code, di, qty); draw(); })) : null,
      workSection("Запчасти", partsEditor(instance.parts, stock, () => { onParts(instance.code, instance.parts); draw(); }, partBlockIdOf(instance))));
  }
  function draw() {
    let dots = null, label = null;
    // Свайп/тап по точке двигает только сам счётчик и подсветку точек, без
    // полной перерисовки шторки (та бы сбросила прокрутку карусели) — но
    // подпись «Экземпляр N из M» тоже часть этого «текущего номера», иначе
    // она молча отстаёт от того, что реально показано под ней.
    const updateActive = () => {
      if (dots) dots.querySelectorAll(".carousel-dot").forEach((btn, index) => btn.classList.toggle("active", index === activeIndex));
      if (label) label.textContent = `Экземпляр ${activeIndex + 1} из ${items.length}`;
    };
    // Горизонтальный scroll-snap-контейнер нужен только когда реально есть
    // несколько экземпляров для пролистывания. При одном экземпляре — просто
    // содержимое панели без обёртки: на iOS Safari .instance-track
    // (overflow-x:auto + scroll-snap-type) в связке с анимацией открытия
    // шторки иногда давал рваный кадр (обрывки текста от «половины» ширины) —
    // такая обёртка ни для чего тут не нужна, если пролистывать нечего.
    if (items.length > 1) {
      track = el("div", {
        class: "instance-track",
        onscroll: () => {
          if (syncingScroll || !track) return;
          const idx = carouselNearestIndex(track, items.length);
          if (idx !== activeIndex) { activeIndex = idx; updateActive(); }
        },
      }, items.map(panelFor));
      dots = el("div", { class: "carousel-dots" },
        items.map((_, index) => el("button", {
          type: "button", class: "carousel-dot" + (index === activeIndex ? " active" : ""),
          "aria-label": `Экземпляр ${index + 1} из ${items.length}`,
          onclick: () => { activeIndex = index; updateActive(); scrollToIndex(index, true); },
        })));
      label = el("p", { class: "small muted", style: "margin:0 0 6px;text-align:center" }, `Экземпляр ${activeIndex + 1} из ${items.length}`);
    } else {
      track = panelFor(items[0]);
    }
    content.replaceChildren(...[
      label,
      track,
      dots,
    ].filter(Boolean));
    // При первом открытии content ещё не в DOM (sheet ниже откроет его
    // позже) — track.clientWidth в этот момент 0, и scrollLeft свёлся бы к 0
    // независимо от activeIndex. Прокручиваем только если track уже виден;
    // самый первый раз — уже после openSheet, см. ниже.
    if (items.length > 1 && track.isConnected) scrollToIndex(activeIndex, false);
  }
  draw();
  sheet = presentWork(it, content);
  if (items.length > 1) scrollToIndex(activeIndex, false);
}

function pendingAgreementCard(order, handlers, stock) {
  const pending = order.items.filter((i) => !i.agreed);
  if (!pending.length) return null;
  return el("div", { class: "card" },
    el("h2", {}, "Ждёт согласования"),
    el("p", { class: "small muted" }, "Добавлено сверх исходной сметы — позвоните клиенту и подтвердите, тогда работа попадёт в обращение и сумму."),
    ...pending.map((it) => pendingAgreementRow(it, handlers, stock)));
}

// Нет отдельной кнопки «отметить/изменить»: тап по работе открывает форму
// факта снизу экрана (bottom sheet) — список работ под ней остаётся на
// месте, не раздувается. Убрать работу — свайп влево, как заявки в архиве.
// Правки в форме (было/не было, запчасти) сохраняются сами, без
// подтверждения, но на статус «готово» не влияют — им управляет одна кнопка
// внизу формы: «Готово» либо «Отменить», в обе стороны без ограничений.
function repairItem(it, stock, { onSave, onQty, onRemove, onAdd, onClaim }) {
  const box = el("div", { class: "assess" });
  const nameRow = el("div", { style: "display:flex;align-items:center;gap:8px" },
    el("b", { style: "flex:1;min-width:0" }, it.name),
    workStatePill(it),
    el("span", { class: "work-chev" }, "›"));
  const quantityControl = usesQuantity(it) && onQty
    ? qtyStepper(it.qty, onQty, workQuantityLimitOf(it), onRemove ? () => onRemove(it.code) : undefined)
    : null;
  const priceControl = itemPriceTags(it);
  // Кликабельна вся карточка (имя + сумма + разбивка по составляющим), а не
  // только строка с именем — с разбивкой карточка стала заметно выше, и тап
  // ниже имени должен так же открывать форму, а не проваливаться в никуда.
  // Счётчик сам гасит всплытие клика, поэтому его кнопки меняют количество,
  // а цена и остальная площадь по-прежнему открывают карточку работы.
  const openArea = el("div", {
    style: "cursor:pointer",
    // openRepairSheet теперь всегда принимает (code, patch) — тут это одна-
    // единственная позиция без соседей, просто отбрасываем code и зовём
    // прежний, привязанный к конкретной работе onSave(patch).
    onclick: () => {
      if (isInlineOpen(it.code)) return closeInlineWork();
      onClaim?.();
      openRepairSheet(it, stock, (code, patch) => onSave(patch), [it], { onAdd, onRemove });
    },
  },
    nameRow,
    // Та же разбивка по составляющим, что и в списке «выдан» — не нужно
    // открывать форму, чтобы увидеть, из чего сложилась сумма.
    costBreakdown(it),
    el("div", { style: "margin-top:10px" }, pricedControlGroup(priceControl, quantityControl)));
  box.append(openArea);
  if (it.notes) box.append(el("p", { class: "small muted" }, it.notes));
  const row = onRemove ? swipeToDelete(box, () => { onRemove(it.code); return true; }) : box;
  row.dataset.workKey = it.code;
  row.dataset.hideActions = "1";
  return row;
}

// Содержимое bottom sheet для repairItem — усложнения/
// запчасти на вкладках (одна, если нечего показывать на другой), плюс
// «Жду запчасть»/«Отметить готово». Правки сохраняются сами по себе сразу.
// siblings.length > 1 — несколько экземпляров одной и той же повторяющейся
// работы: карусель (свайп/точки, тот же паттерн, что и в openPendingSheet)
// вместо одной карточки, свой набор контролов на каждый экземпляр. Вкладка
// «Усложнения»/«Запчасти» — своя у каждого экземпляра (переключается
// независимо, не влияет на соседние панели карусели).
//
// Экземпляр становится «занят» тем мастером, который первым что-то в нём
// реально отметил (усложнение/запчасть/готово/жду запчасть) — просто
// открыть и посмотреть не занимает. Чужой занятый экземпляр виден (не
// спрятан), но заблокирован: контролы недоступны, сверху подпись, кто занял.
//
// track и панели создаются один раз и не пересобираются при каждой правке —
// обновляется только содержимое конкретной панели (redrawPanel). Раньше
// весь track пересоздавался на любое действие (готово/жду запчасть/вкладка)
// и scroll-позиция принудительно выставлялась заново — на iOS Safari это
// иногда роняло scroll-snap в промежуточное положение между двумя
// экземплярами (виден шов, часть текста одной панели рядом с другой).
// Теперь scrollLeft трогается только по явному действию — свайп, точка или
// открытие шторки.
//
// onAddInstance/onRemoveInstance (необязательные, только для quantityMode:
// "instances") — каждый экземпляр самостоятелен, но отображается вместе с
// остальными той же работы: можно добавить ещё один прямо здесь же (мастер
// понял, что спиц не 3, а 4) или убрать конкретный (ошиблись количеством).
// Добавление/удаление персистит через колбэк (editOrder+refresh снаружи,
// см. viewOrder), а локальная карусель донастраивается на месте — без
// полной пересборки шторки и без сброса позиции остальных панелей.
function openRepairSheet(it, stock, onSave, siblings = [it], { onAdd: onAddInstance, onRemove: onRemoveInstance } = {}) {
  let items = siblings.length ? siblings : [it];
  const myId = SESSION?.id || null;
  const isAdmin = SESSION?.role === "admin";
  const isLocked = (inst) => inst.claimedBy && inst.claimedBy.masterId !== myId && !isAdmin;
  const isInstanceWork = (inst) => inst?.quantityMode === "instances";
  // Стейджинг правок — свой на каждый экземпляр, создаётся один раз при
  // открытии из текущих сохранённых значений, а не при каждой перерисовке,
  // иначе несохранённые правки терялись бы при любом redraw. tab — тоже per-
  // instance: по умолчанию «Усложнения», если они у этого экземпляра есть,
  // иначе «Запчасти».
  // «неизвестно» — прогнозное состояние (по умолчанию у новой работы), тут
  // такого выбора нет (см. fact:true ниже) — приводим к «не было», иначе
  // помеченная «готово» работа продолжала бы считаться диапазоном цены,
  // а не точной суммой.
  const stagedFor = (inst) => ({
    diffs: JSON.parse(JSON.stringify(inst.difficulties || [])).map((d) => (d.state === "unknown" ? { ...d, state: "no" } : d)),
    parts: (inst.parts || []).map((p) => ({ ...p })),
  });
  const staged = new Map(items.map((inst) => [inst.code, stagedFor(inst)]));
  let activeIndex = (() => {
    let i = items.findIndex((x) => x.claimedBy?.masterId === myId);
    if (i === -1) i = items.findIndex((x) => !x.claimedBy);
    return i === -1 ? 0 : i;
  })();

  const content = el("div", {});
  let sheet, track, dots, label;
  let syncingScroll = false;
  function scrollToIndex(index, smooth) {
    if (!track) return;
    syncingScroll = true;
    const left = carouselPanelOffset(track, index);
    if (smooth) track.scrollTo({ left, behavior: "smooth" });
    else track.scrollLeft = left;
    setTimeout(() => { syncingScroll = false; }, smooth ? 260 : 0);
  }
  function updateActive() {
    if (dots) dots.querySelectorAll(".carousel-dot").forEach((btn, index) => btn.classList.toggle("active", index === activeIndex));
    if (label) label.textContent = `Экземпляр ${activeIndex + 1} из ${items.length}`;
  }
  // Первое реальное действие над экземпляром — сразу и занимает его тем,
  // кто это сделал (если ещё ничей); дальше он же (или админ) им и правит.
  function save(instance, extra) {
    const s = staged.get(instance.code);
    const patch = { parts: s.parts, difficulties: s.diffs, ...extra };
    if (!instance.claimedBy) {
      instance.claimedBy = { masterId: myId, masterName: SESSION?.name || "—" };
      patch.claimedBy = instance.claimedBy;
    }
    onSave(instance.code, patch);
  }
  const panelBody = new Map(); // code -> хост-узел содержимого панели
  function redrawPanel(instance) {
    const s = staged.get(instance.code);
    const locked = isLocked(instance);
    const hasDiffs = s.diffs.length > 0;
    const diffBox = el("div", {});
    const drawDiffs = () => diffBox.replaceChildren(hasDiffs
      ? difficultyList(s.diffs, (di, st) => { s.diffs[di].state = st; drawDiffs(); save(instance, {}); }, (di, qty) => { s.diffs[di].qty = qty; drawDiffs(); save(instance, {}); }, true)
      : el("p", { class: "small muted" }, "Трудностей не ожидается."));
    drawDiffs();
    // Пункт неделим — один мастер отмечает «готово» целиком.
    const markDone = () => {
      instance.done = true;
      instance.doneBy = { masterId: myId, masterName: SESSION?.name || "—", at: new Date().toISOString() };
      instance.waitingForPart = null;
      save(instance, { done: true, doneBy: instance.doneBy, waitingForPart: null });
      toast("Отмечено готово");
      // Групповую шторку не закрываем — по другим экземплярам ещё есть что
      // делать (себе или другому мастеру); одиночную, как и раньше, закрываем.
      if (items.length === 1) sheet.close(); else redrawPanel(instance);
    };
    const unmarkDone = () => {
      instance.done = false;
      instance.doneBy = null;
      instance.claimedBy = null;
      instance.waitingForPart = null;
      // Освобождение работы должно быть единым изменением на сервере.
      onSave(instance.code, { done: false, doneBy: null, claimedBy: null, waitingForPart: null });
      redrawPanel(instance);
    };
    // «Жду запчасть» — мастер начал работу, но встал из-за отсутствующей
    // детали; занимает эту пометку тот, кто её поставил, снять/продолжить
    // может он же или админ — остальные видят только факт и чьё имя.
    const canManageWait = instance.waitingForPart && (instance.waitingForPart.masterId === myId || isAdmin);
    const waitBlock = instance.done ? null : el("div", { class: "part-wait-control" },
      instance.waitingForPart
        ? el("div", {},
            el("p", { class: "small", style: "color:var(--yellow-ink)" }, `Ждёт запчасть — ${instance.waitingForPart.masterName || "—"}`),
            canManageWait ? el("button", {
              style: "width:100%;margin-top:6px",
              onclick: () => { instance.waitingForPart = null; save(instance, { waitingForPart: null }); redrawPanel(instance); },
            }, "Запчасть пришла — продолжить") : null)
        : el("button", {
            class: "small parts-text-action",
            onclick: () => {
              instance.waitingForPart = { masterId: myId, masterName: SESSION?.name || "—", at: new Date().toISOString() };
              save(instance, { waitingForPart: instance.waitingForPart });
              redrawPanel(instance);
            },
          }, "Жду запчасть"));
    const canUndoDone = isAdmin || instance.doneBy?.masterId === myId || (!instance.doneBy && instance.claimedBy?.masterId === myId);
    const doneBlock = instance.done
      ? canUndoDone ? el("button", { style: "width:100%;margin-top:16px", onclick: unmarkDone }, "Снять отметку «готово»") : null
      : el("button", { class: "btn-ok", style: "width:100%;margin-top:16px", onclick: markDone }, "Отметить готово");
    const inner = el("div", {},
      workDescriptionNode(instance),
      hasDiffs ? workSection("Усложнения", diffBox) : null,
      workSection("Запчасти",
        partsEditor(s.parts, stock, () => save(instance, { parts: s.parts }), partBlockIdOf(instance),
          instance.waitingForPart ? null : waitBlock),
        instance.waitingForPart ? waitBlock : null),
      doneBlock);
    const body = locked
      ? el("div", {},
          el("p", { class: "small", style: "color:var(--muted);margin-bottom:10px" }, `Занято — ${instance.claimedBy?.masterName || "другой мастер"}`),
          el("div", { style: "pointer-events:none;opacity:.5" }, inner))
      : inner;
    panelBody.get(instance.code).replaceChildren(body);
  }

  // Хост-узел содержимого панели создаётся один раз на экземпляр и живёт,
  // пока экземпляр не убрали — переживает пересборку track при добавлении/
  // удалении соседних экземпляров (rebuildTrack просто оборачивает те же
  // узлы заново, redrawPanel их не трогает лишний раз).
  function ensurePanelHost(instance) {
    if (!panelBody.has(instance.code)) panelBody.set(instance.code, el("div", {}));
    return panelBody.get(instance.code);
  }
  function canAddInstance() {
    if (!onAddInstance || !items.length || !isInstanceWork(items[0])) return false;
    const max = items[0].maxInstances || 0;
    return !(max > 0 && items.length >= max);
  }
  // Горизонтальный scroll-snap-контейнер — только когда реально есть
  // несколько экземпляров для пролистывания. Один экземпляр — просто его
  // панель без обёртки: на iOS Safari .instance-track (overflow-x:auto +
  // scroll-snap-type) в связке с анимацией открытия шторки иногда давал
  // рваный кадр (обрывки текста как будто от «половины» ширины экрана) —
  // такая обёртка тут ни для чего не нужна, если пролистывать нечего.
  function rebuildTrack() {
    const panels = items.map((instance) => el("div", { class: "instance-panel" }, ensurePanelHost(instance)));
    if (items.length > 1) {
      track = el("div", {
        class: "instance-track",
        onscroll: () => {
          if (syncingScroll || !track) return;
          const idx = carouselNearestIndex(track, items.length);
          if (idx !== activeIndex) { activeIndex = idx; updateActive(); }
        },
      }, panels);
      dots = el("div", { class: "carousel-dots" },
        items.map((_, index) => el("button", {
          type: "button", class: "carousel-dot" + (index === activeIndex ? " active" : ""),
          "aria-label": `Экземпляр ${index + 1} из ${items.length}`,
          onclick: () => { activeIndex = index; updateActive(); scrollToIndex(index, true); },
        })));
      label = el("p", { class: "small muted", style: "margin:0 0 6px;text-align:center" }, `Экземпляр ${activeIndex + 1} из ${items.length}`);
    } else {
      track = panels[0] || null;
      dots = null;
      label = null;
    }
    const addBtn = canAddInstance() ? el("button", {
      class: "small", style: "margin-top:10px;border:0;background:none;color:var(--accent);text-decoration:underline;padding:0",
      onclick: addInstance,
    }, "+ ещё один экземпляр") : null;
    content.replaceChildren(...[label, track, dots, addBtn].filter(Boolean));
  }
  // Добавление/удаление персистит снаружи (editOrder+refresh, см. viewOrder)
  // и обновляет локальную карусель на месте — остальные панели не трогаются,
  // их scroll-позиция и несохранённые табы не сбрасываются.
  function addInstance() {
    if (!canAddInstance()) return;
    const newItem = onAddInstance(items[items.length - 1]);
    if (!newItem) return;
    items.push(newItem);
    staged.set(newItem.code, stagedFor(newItem));
    ensurePanelHost(newItem);
    redrawPanel(newItem);
    activeIndex = items.length - 1;
    rebuildTrack();
    if (items.length > 1 && track.isConnected) scrollToIndex(activeIndex, false);
  }
  function removeInstance(instance) {
    if (!onRemoveInstance) return;
    onRemoveInstance(instance.code);
    items = items.filter((x) => x.code !== instance.code);
    staged.delete(instance.code);
    panelBody.delete(instance.code);
    if (!items.length) { sheet.close(); return; }
    activeIndex = Math.min(activeIndex, items.length - 1);
    rebuildTrack();
    if (items.length > 1 && track.isConnected) scrollToIndex(activeIndex, false);
  }

  items.forEach((instance) => { ensurePanelHost(instance); redrawPanel(instance); });
  rebuildTrack();
  sheet = presentWork(it, content);
  // scrollToIndex — уже после openSheet: до него content не в DOM, и
  // track.clientWidth равен 0, из-за чего scrollLeft всегда сводился к 0
  // независимо от activeIndex (открывался не тот экземпляр, что задуман).
  if (items.length > 1) scrollToIndex(activeIndex, false);
}

// ============================================================================
//  ДИАГНОСТИКА ПО БЛОКАМ
//  Мастер: все узлы по умолчанию «Норма», мастер отмечает только проблемные.
//  Обучение: тот же список + место под справку по каждой неисправности.
// ============================================================================

// onCheck/onUncheck — список работ живёт у вызывающего (наряд или черновик
// нового обращения) и меняется сразу по тапу на строку, без ожидания
// «Готово». Отмеченное видно прямо по заливке строк в блоках (отдельного
// списка уже добавленного тут нет — только дублировал то же самое ещё раз
// и без пользы растягивал экран).
// onDone(notes) получает только текстовые заметки без привязки к работе.
// inline — true, когда диагностику встраивают прямо в тело другого экрана
// (напр. «+ доп. работа» на «в работе»), а не монтируют как весь экран:
// тогда не оборачиваем содержимое в свой <main class="wrap"> (иначе он
// вложился бы во внешний main.wrap — невалидная вложенность и двойные отступы).
function mountDiagnostics(host, { onCheck, onUncheck, onOpen, onInstanceCount, getInstanceCount, getInstanceMax, onQuantity, getQuantity, getItemRange, onDone, request = "", onRequest, onlyBlocks, inline = false, totalText }) {
  let req = request;
  const states = {}; // instId -> { open, faults:Set<number> }
  const st = (id) => (states[id] ||= { open: false, faults: new Set() });
  let repairs = []; // неисправности, заведённые админом вручную (общие для всех)
  // Разовая услуга — форма «+ добавить разовую услугу» под списком узлов,
  // не привязана ни к одному блоку и не сохраняется в общий каталог.
  let miscOpen = false;
  let chosenOpen = false, chosenJustOpened = false; // «Итого» развёрнуто в список выбранного
  const miscDraft = { label: "", price: 0, minutes: 0 };
  // Добавленные тут разовые услуги — видны списком над формой: в узлах
  // их нет, и раньше после «Добавить» было непонятно, куда она делась.
  const miscAdded = [];
  let miscFlash = null; // код только что добавленной — подсветить строку
  let miscOpening = false; // форма только что открыта — плавно раскрыть
  const reduceMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // Свернуть узел по высоте и только потом перерисовать — видно, что
  // форма закрылась, а не просто исчезла.
  const collapseThen = (node, done) => {
    if (!node?.isConnected || !node.animate || reduceMotion()) return done();
    const h = node.offsetHeight;
    node.style.overflow = "hidden";
    node.animate([
      { height: `${h}px`, opacity: 1 },
      { height: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px", marginTop: "0px", marginBottom: "0px" },
    ], { duration: 220, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" }).onfinish = done;
  };

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
  // Список работ узла — только заведённые администратором вручную
  // (catalog/repairs). Старый встроенный каталог процедур (.proc) отсюда
  // убран — он больше нигде не отображается.
  const blockFaults = (b) => repairs.filter((r) => r.group === b.id).map((r) => ({
    label: r.label, description: r.description || "", code: `CF-${r.id}`, custom: true, id: r.id,
    price: r.price, minutes: r.minutes, complications: r.complications,
    quantityMode: quantityModeOf(r), maxInstances: instanceLimitOf(r),
  }));
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
    clearRepairsCache();
    repairs = await ensureRepairs();
  }

  // Добавление и правка своей работы (только у администратора) — в шторке
  // снизу, как усложнения: форма длинная (описание, цена, режим количества,
  // усложнения), и встроенная прямо в список раздвигала его и терялась
  // среди строк. f — работа для правки (PUT), без неё — новая в блоке blockId.
  function openWorkFormSheet(f, blockId) {
    const draftFa = f
      ? { label: f.label, description: f.description || "", price: f.price || 0, minutes: f.minutes || 0,
          complications: JSON.parse(JSON.stringify(f.complications || [])), quantityMode: quantityModeOf(f), maxInstances: instanceLimitOf(f) }
      : { label: "", description: "", price: 0, minutes: 0, complications: [], quantityMode: "single", maxInstances: 0 };
    const numField = (label, key) => el("div", { style: "flex:1;min-width:120px" }, el("label", {}, label),
      el("input", { type: "number", value: f ? draftFa[key] : "", oninput: (e) => (draftFa[key] = +e.target.value || 0) }));
    let sheet;
    const save = async (e) => {
      if (!draftFa.label.trim()) return alert("Укажите название");
      const fields = { label: draftFa.label.trim(), description: draftFa.description, price: draftFa.price, minutes: draftFa.minutes,
        complications: draftFa.complications, quantityMode: draftFa.quantityMode };
      e.currentTarget.disabled = true;
      const r = await fetch("/api/repairs", {
        method: f ? "PUT" : "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(f ? { id: f.id, ...fields } : { group: blockId, ...fields }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { e.target.disabled = false; return alert(j.error || "ошибка"); }
      sheet.close();
      await reloadRepairs();
      draw();
    };
    const body = el("div", {},
      el("label", { style: "margin-top:0" }, "Название работы"),
      el("input", { value: draftFa.label, oninput: (e) => (draftFa.label = e.target.value) }),
      descriptionField(draftFa),
      el("div", { style: "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px" }, numField("Цена, ₽", "price"), numField("Минуты", "minutes")),
      quantityModeEditor(draftFa),
      el("label", { style: "margin-top:8px" }, "Усложнения"),
      complicationsEditor(draftFa.complications),
      el("button", { class: "btn-primary", style: "width:100%;margin-top:18px", onclick: save }, f ? "Сохранить" : "Добавить"));
    sheet = openSheet(f ? "Изменить работу" : "Новая работа", body);
  }

  // Раскрытый по тапу блок подтягиваем к верху экрана: его работы идут
  // сразу под заголовком, а не уезжают за нижний край. У нижних блоков
  // странице не хватает высоты доехать — добавляем запас снизу (до
  // следующей перерисовки).
  let scrollToInst = null;
  function scrollOpenedIntoView(card, wrap) {
    requestAnimationFrame(() => {
      if (inline) return card.scrollIntoView({ block: "start", behavior: "smooth" });
      const bar = document.querySelector("header.bar");
      const top = Math.max(0, card.getBoundingClientRect().top + window.scrollY - (bar?.offsetHeight || 0) - 12);
      const lack = top + window.innerHeight - document.documentElement.scrollHeight;
      if (lack > 0) wrap.style.paddingBottom = `calc(${getComputedStyle(wrap).paddingBottom} + ${Math.ceil(lack)}px)`;
      window.scrollTo({ top, behavior: "smooth" });
    });
  }

  function draw() {
    const list = instances();
    let openedCard = null;
    const wrap = el(inline ? "div" : "main", { class: inline ? null : "wrap" });

    // При встраивании в «+ доп. работа» (inline) уточнения не нужны — это
    // только про первичный приём. То же поле показано и редактируется и
    // на экране обращения (см. viewOrder/head) — там его тоже можно менять.
    // Отдельный список «Уже добавлено в наряд» тут раньше был, но убрали:
    // отмеченное и так видно по заливке прямо в блоках ниже, а сама эта
    // секция росла НАД блоками и раздвигала список при каждой отметке.
    if (!inline && onRequest) {
      // Поле самостоятельное: дополнительная карточка вокруг него создавала
      // рамку в рамке и не несла никакой функции.
      wrap.append(requestField(req, (v) => { req = v; onRequest(req); }, "request-box-new"));
    }

    for (const inst of list) {
      const s = st(inst.id);
      const header = el("div", {
        style: "display:flex;align-items:center;gap:10px;cursor:pointer",
        onclick: () => { s.open = !s.open; scrollToInst = s.open ? inst.id : null; draw(); },
      },
        // Текст-подсказку («на что смотреть при проверке узла») пока скрыли —
        // делаем версию для опытных мастеров, которым она не нужна. Данные
        // (b.prompt) не трогаем — пригодятся для отдельной версии для новичков.
        blockIcon(inst.b?.id),
        el("div", { style: "flex:1" },
          el("h2", { style: "margin:0" }, inst.label)),
        el("span", {
          style: `flex:0 0 auto;color:var(--line);font-size:19px;transform:rotate(${s.open ? "90deg" : "0deg"});transition:transform .15s ease`,
        }, "›"));
      const card = el("div", { class: "card" }, header);
      if (inst.id === scrollToInst) openedCard = card;

      if (s.open) {
        const fb = el("div", { style: "margin-top:8px" });
        // Плоский список, а не чип-строка на каждую неисправность (.opt как
        // отдельная кнопка-переключатель в других местах) — тут их может
        // быть много подряд, и рамка на рамке на рамке внутри и так уже
        // очерченной карточки узла выглядела тесно. rowsList — тот же
        // способ убрать разделитель у последней строки, что и в остальных
        // списках приложения (обращения, архив, каталог запчастей).
        const faultNodes = [];
        const faults = blockFaults(inst.b);
        faults.forEach((f, i) => {
          const isAdmin = SESSION?.role === "admin";
          // Раньше — чекбокс внутри строки: на плотном списке из многих строк
          // подряд промах мимо мелкого квадратика по пальцу ощущался как
          // «всё съезжает» (задевали соседнюю строку/скролл). Теперь тап в
          // любом месте строки переключает, а галочка справа (без заливки
          // фона — та не задалась ни цветом, ни соседством выбранных строк
          // подряд) — единственный индикатор.
          const instanceMode = quantityModeOf(f) === "instances";
          const quantityMode = quantityModeOf(f) === "quantity";
          const selectedCount = getInstanceCount ? getInstanceCount(f) : (s.faults.has(i) ? 1 : 0);
          const instanceCount = instanceMode ? selectedCount : (selectedCount > 0 ? 1 : 0);
          const quantityCount = quantityMode && getQuantity ? Math.max(1, getQuantity(f) || 1) : 1;
          const instanceMax = instanceMode ? (getInstanceMax ? getInstanceMax(f) : (f.maxInstances || 0)) : 0;
          const instanceUnavailable = instanceMode && !!getInstanceMax && (f.maxInstances || 0) > 0 && instanceMax <= 0;
          const checked = selectedCount > 0;
          const setInstanceCount = (count) => {
            if (instanceUnavailable && count > 0) return;
            const next = Math.max(0, instanceMax > 0 ? Math.min(instanceMax, count) : count);
            if (next) s.faults.add(i); else s.faults.delete(i);
            if (onInstanceCount) onInstanceCount(f, next);
            else if (next && !checked) onCheck(f);
            else if (!next && checked && !codeCheckedElsewhere(f.code, inst.id)) onUncheck(f);
            draw();
          };
          const setQuantityCount = (count) => {
            const next = Math.max(0, Math.min(WORK_QUANTITY_LIMIT, count));
            if (!next) {
              s.faults.delete(i);
              if (checked && f.code && !codeCheckedElsewhere(f.code, inst.id)) onUncheck(f);
            } else {
              s.faults.add(i);
              if (!checked && f.code) onCheck(f);
              if (onQuantity) onQuantity(f, next);
            }
            draw();
          };
          const setSingleSelected = (selected) => {
            if (selected) { s.faults.add(i); if (f.code) onCheck(f); }
            else { s.faults.delete(i); if (f.code && !codeCheckedElsewhere(f.code, inst.id)) onUncheck(f); }
            draw();
          };
          let selectButton = null;
          // Счётчик показывает, сколько самостоятельных строк этой работы
          // будет в наряде. В ремонте они не объединяются: у каждой будет
          // собственный исполнитель, готовность, усложнения и запчасти.
          if (checked && instanceMode) selectButton = qtyStepper(instanceCount, setInstanceCount, instanceMax, () => setInstanceCount(0));
          else if (instanceMode) selectButton = addRemoveControl(false,
            () => setInstanceCount(1), "Добавить работу", instanceUnavailable);
          else if (checked && quantityMode) selectButton = qtyStepper(quantityCount, setQuantityCount, WORK_QUANTITY_LIMIT, () => setQuantityCount(0));
          else selectButton = addRemoveControl(checked, (selected) => {
            if (quantityMode) setQuantityCount(selected ? 1 : 0);
            else setSingleSelected(selected);
          }, checked ? "Убрать работу" : "Добавить работу", instanceUnavailable);
          // Цена — рядом со счётчиком/кнопкой добавления справа, а не сразу
          // после названия: так видно одним взглядом, что именно сейчас
          // считается в сумму. Серая, пока работа не выбрана, и становится
          // синей (тем же акцентом, что и раньше был у рамки) ровно тогда,
          // когда работа реально выбрана и её цена входит в счёт — рамку
          // вокруг всей строки убрали, этого достаточно как индикатора.
          // Пока работа не выбрана — показываем вилку по шаблону
          // (customFaultRange, «от…»). Как только выбрана — вилка больше не
          // годится: реальная сумма зависит от того, что мастер отметил в
          // усложнениях (будет/не будет/неизвестно) для КОНКРЕТНОЙ добавленной
          // позиции, а не от общего диапазона по шаблону. getItemRange считает
          // сумму по факту отмеченного (несколько экземпляров — сразу все
          // вместе), если работа выбрана — иначе fallback на вилку шаблона.
          const definitionRange = customFaultRange(f);
          const liveRange = checked && getItemRange ? getItemRange(f) : null;
          const priceRange = liveRange || definitionRange;
          const hasPossibleExtras = (f.complications || []).length > 0;
          const partsSum = liveRange?.parts || 0;
          const priceNode = priceRange
            ? controlPriceTag(!checked && hasPossibleExtras
              ? `${Number(priceRange.min || 0).toLocaleString("ru-RU")}+ ₽`
              : rangePlusText({ min: priceRange.min - partsSum, max: priceRange.max - partsSum }), checked)
            : null;
          // Запчасти — отдельным ценником слева, как в карточке работы в
          // ремонте (itemPriceTags): труд и детали не смешиваются в одну сумму.
          const partsNode = partsSum > 0
            ? el("span", { class: "control-price parts", title: "Запчасти" },
              el("span", { class: "price-icon", html: ICONS.stock }), money(partsSum))
            : null;
          // align-items:flex-start (не center из .opt) — иначе у длинных
          // названий, переносящихся на 2-3 строки, цена/счётчик съезжали
          // вниз или вверх каждый раз по-разному (центр всей строки, а не
          // по первой строке текста) — соседние строки списка «плясали».
          // Так счётчик всегда на одной и той же высоте, вровень с первой
          // строкой названия, независимо от того, сколько строк оно занимает.
          const rowContent = el("div", { class: "row opt priced-control-row work-picker-row" },
            // min-width:0 — без него flex-item с длинным неразрывным словом
            // (напр. «Обслуживание», «Переспицовка») не мог сжаться уже
            // своего мин-контента, и цена/счётчик справа вылезали за край
            // строки вместо того, чтобы остаться у правого края.
            el("span", { class: "work-picker-name", style: "min-width:0;overflow-wrap:break-word;cursor:pointer" }, f.label),
            pricedControlGroup([partsNode, priceNode],
              selectButton || (checked ? el("span", { class: "row-check", html: ICON_CHECK }) : null)));
          // Слушатель добавлен ПОСЛЕ swipeActions(rowContent, ...) ниже (не
          // через onclick в el() при создании) — важен порядок регистрации:
          // у swipeActions есть свой click-обработчик на этом же узле,
          // который при свайпе гасит клик через stopImmediatePropagation, но
          // только для слушателей, зарегистрированных ПОСЛЕ него. Если бы
          // тут стоял просто onclick в el(), он сработал бы раньше свайпа
          // и отмечал бы галочку даже во время жеста «смахнуть для правки».
          const toggle = () => {
            // Тап по названию раскрывает усложнения и запчасти работы прямо
            // под строкой (presentWork); повторный — сворачивает. Если работа
            // ещё не выбрана — сначала добавляем её. Кнопка «+»/счётчик
            // рядом отвечает только за добавление/снятие, цена — не кнопка.
            if (checked && f.code && isInlineOpen(f.code)) return closeInlineWork();
            if (!checked) {
              if (instanceUnavailable) return;
              if (instanceMode) setInstanceCount(1);
              else { s.faults.add(i); if (f.code) onCheck(f); draw(); }
            }
            if (f.code && onOpen) onOpen(f, draw);
          };
          // Раньше ✎/✕ жили прямо в строке — с плотным списком смотрелись
          // мелко и тесно. Теперь открываются свайпом влево, как удаление
          // в других списках приложения.
          // data-work-key — только у выбранной: раскрытая под невыбранной
          // (сняли галочку) сама закрывается при перерисовке.
          faultNodes.push(el("div", checked && f.code ? { "data-work-key": f.code } : {},
            isAdmin
              ? swipeActions(rowContent, [
                  { label: ICON_EDIT, ariaLabel: "Изменить работу", onClick: () => openWorkFormSheet(f) },
                  { label: ICON_CLOSE, ariaLabel: "Удалить работу", className: "warn", onClick: async () => {
                      if (!confirm(`Убрать «${f.label}» из списка совсем?`)) return;
                      const wasChecked = s.faults.has(i);
                      // Реальный уникальный код (CF-id) — может повторяться на обеих
                      // сторонах, снимаем везде, пока он ещё виден в blockFaults().
                      uncheckByCode(f.code);
                      await fetch("/api/repairs", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: f.id }) });
                      if (wasChecked) onUncheck(f);
                      await reloadRepairs();
                      draw();
                    } },
                ])
              : rowContent));
          rowContent.addEventListener("click", (e) => { if (e.target.closest(".work-picker-name")) toggle(); });
        });
        if (faultNodes.length) fb.append(rowsList(faultNodes, true));
        if (SESSION?.role === "admin") {
          fb.append(el("button", {
            class: "small", style: "margin-top:8px;border:0;background:none;color:var(--muted);text-decoration:underline;padding:0",
            onclick: () => openWorkFormSheet(null, inst.b.id),
          }, "+ своя неисправность"));
        }
        card.append(fb);
      }
      wrap.append(card);
    }

    // Разовая услуга — работа вне узлов, только для этого обращения (не
    // заводится в общий каталог неисправностей и никак не всплывёт у другого
    // велосипеда в будущем): просто ещё один пункт наряда, добавляется сразу
    // через onCheck, как и обычная отмеченная неисправность.
    if (miscAdded.length) {
      wrap.append(el("div", { class: "card misc-added" },
        el("h2", {}, "Разовые услуги"),
        rowsList(miscAdded.map((m) => el("div", { class: "row misc-row" + (m.code === miscFlash ? " just-added" : ""), style: "cursor:default;gap:10px" },
          el("span", { style: "flex:1;min-width:0" }, m.label),
          controlPriceTag(money(m.price)),
          el("button", {
            class: "complication-remove", "aria-label": `Убрать «${m.label}»`, html: ICON_CLOSE,
            onclick: (e) => collapseThen(e.currentTarget.closest(".row"), () => {
              miscAdded.splice(miscAdded.indexOf(m), 1);
              onUncheck({ code: m.code });
              draw();
            }),
          }))), true)));
      miscFlash = null;
    }
    let miscCard = null;
    wrap.append(miscOpen
      ? (miscCard = el("div", { class: "card card-flush" + (miscOpening ? " misc-opening" : "") },
          el("label", {}, "Название разовой услуги"),
          el("input", { value: miscDraft.label, oninput: (e) => (miscDraft.label = e.target.value) }),
          el("div", { style: "display:flex;flex-wrap:wrap;gap:8px;margin-top:8px" },
            el("div", { style: "flex:1;min-width:120px" }, el("label", {}, "Цена, ₽"), el("input", { type: "number", value: miscDraft.price || "", oninput: (e) => (miscDraft.price = +e.target.value || 0) })),
            el("div", { style: "flex:1;min-width:120px" }, el("label", {}, "Минуты"), el("input", { type: "number", value: miscDraft.minutes || "", oninput: (e) => (miscDraft.minutes = +e.target.value || 0) }))),
          el("div", { class: "btn-row", style: "margin-top:10px" },
            el("button", { class: "btn-primary", onclick: () => {
              if (!miscDraft.label.trim()) return alert("Укажите название");
              const m = {
                code: `MISC-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
                label: miscDraft.label.trim(), custom: true,
                price: miscDraft.price, minutes: miscDraft.minutes, complications: [], multiple: false,
              };
              onCheck(m);
              miscAdded.push(m);
              miscFlash = m.code;
              miscDraft.label = ""; miscDraft.price = 0; miscDraft.minutes = 0;
              toast(`Добавлено: ${m.label}`);
              collapseThen(miscCard, () => {
                miscOpen = false;
                draw();
                host.querySelector(".misc-added")?.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
              });
            } }, "Добавить"),
            el("button", { onclick: () => collapseThen(miscCard, () => { miscOpen = false; draw(); }) }, "Отмена"))))
      : el("button", {
          class: "small", style: "margin-top:12px;border:0;background:none;color:var(--muted);text-decoration:underline;padding:0",
          onclick: () => { miscOpen = true; miscOpening = true; draw(); miscOpening = false; },
        }, "+ добавить разовую услугу"));

    const total = totalText?.();
    // Нажатие на «Итого» — карточка разворачивается на месте в список того,
    // что уже выбрано, в том же виде, что «Ремонт» в обращении: название,
    // из чего складывается цена, ценники и счётчик; поднимается под шапку.
    // Повторный тап по «Итого» — свернуть.
    let totalCard = null;
    if (!total || total.count < 2 || !total.items) chosenOpen = false;
    if (chosenOpen) {
      const setQty = (it, n) => {
        const fa = { code: it.sourceCode || it.code };
        if (repeatsWholeItem(it)) onInstanceCount?.(fa, n); else onQuantity?.(fa, n);
        draw();
      };
      const chosenRow = (it) => el("div", { class: "assess" },
        el("b", {}, it.name),
        costBreakdown(it),
        el("div", { class: "price-row", style: "margin-top:12px" }, itemPriceTags(it).filter(Boolean),
          usesQuantity(it) ? qtyStepper(it.qty || 1, (n) => setQty(it, n), workQuantityLimitOf(it)) : null));
      totalCard = el("div", { class: "card chosen-card" + (chosenJustOpened ? " misc-opening" : "") },
        el("h2", {}, "Выбранные работы"),
        ...total.items.map(chosenRow),
        totalRow(total.range, total.count, "Итого", null, () => { chosenOpen = false; draw(); }));
    } else {
      const totalNode = total && totalRow(total.range, total.count, "Итого", null,
        total.items ? () => { chosenOpen = true; chosenJustOpened = true; draw(); } : null);
      if (totalNode) totalCard = el("div", { class: "card" }, totalNode);
    }
    if (totalCard) wrap.append(totalCard);

    host.replaceChildren(wrap,
      el("div", { class: "actions" }, el("div", { class: "actions-inner" },
        el("button", { class: "btn-primary", onclick: finish }, "Далее"))));
    if (openedCard) { scrollToInst = null; scrollOpenedIntoView(openedCard, wrap); }
    if (chosenJustOpened && totalCard) { chosenJustOpened = false; scrollUnderBar(totalCard, wrap); }
    reattachInlineWork();
  }

  // Работы уже добавлены живьём по каждому чекбоксу (см. onCheck) — у
  // всех заведённых через админку работ всегда есть и код, и цена сразу,
  // отдельных текстовых заметок «без кода, определить на разборке» (как у
  // старого каталога процедур) тут больше не бывает.
  function finish() {
    onDone([]);
  }

  host.replaceChildren(el(inline ? "div" : "main", { class: inline ? null : "wrap" }, skeletonRows()));
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

// Строка компактной формы: подпись слева, поле справа, строки — одной
// группой с тонкими разделителями (как в настройках айфона), а не столбик
// огромных отдельных полей. suffix — единица измерения справа («%»).
function formRow(label, control, suffix) {
  return el("label", { class: "form-row" }, el("span", { class: "form-row-label" }, label), control,
    suffix ? el("span", { class: "form-row-suffix" }, suffix) : null);
}
function field(label, name, type, autocomplete) {
  return [el("label", {}, label), el("input", { name, type: type || "text", autocomplete: autocomplete || "off" })];
}
// Логин сотрудника — его номер телефона: поле с той же маской «+7 …»,
// что и у клиентов. На экране входа — autocomplete=username, чтобы
// связка ключей айфона запоминала номер вместе с паролем.
function phoneLoginInput(name, { value = "", autocomplete = "off" } = {}) {
  const input = el("input", { name, placeholder: "+7 900 000 00 00", value: value ? applyPhoneMask(value) : "" });
  attachPhoneMask(input, () => {});
  input.autocomplete = autocomplete;
  return input;
}
// Как показывать логин: номер — с пробелами, старый текстовый — как есть.
const loginLabel = (login) => /^\+7\d{10}$/.test(login || "") ? applyPhoneMask(login) : login || "";

function viewLogin() {
  return authCard("Вход в Veloterra", null,
    [el("label", {}, "Телефон"), phoneLoginInput("login", { autocomplete: "username" }), ...field("Пароль", "password", "password", "current-password")],
    async (form) => {
      await authAction({ action: "login", login: form.login.value.trim(), password: form.password.value });
      await loadSession();
      applySessionLook();
      location.hash = "/";
      router();
    }, "Войти");
}

function viewSetup() {
  return authCard("Первый запуск", "Учётных записей ещё нет. Создайте администратора — дальше он сам заведёт мастеров.",
    [...field("Имя", "name"), el("label", {}, "Телефон"), phoneLoginInput("login", { autocomplete: "username" }),
     ...field("Пароль", "password", "password", "new-password"),
     ...field("Повтор пароля", "password2", "password", "new-password")],
    async (form) => {
      if (form.password.value !== form.password2.value) throw new Error("Пароли не совпадают");
      await authAction({ action: "bootstrap", name: form.name.value.trim(), login: form.login.value.trim(), password: form.password.value });
      await loadSession();
      applySessionLook();
      location.hash = "/";
      router();
    }, "Создать");
}

// Шторка выбора оформления: тема сверху, ниже стили с кружками-образцами
// цветов. Выбор сразу применяется ко всему приложению и сохраняется за
// аккаунтом; если сервер не ответил — вид всё равно остаётся на этом телефоне.
// Оформление — раздел экрана «Настройки» (viewSettings).
function lookEditor() {
  const body = el("div", {});
  const choose = (patch) => {
    applyLook({ ...currentLook, ...patch });
    if (SESSION) SESSION.look = currentLook;
    draw();
    authAction({ action: "setLook", ...currentLook }).catch(() => toast("Не удалось сохранить — вид останется только на этом телефоне"));
  };
  const draw = () => body.replaceChildren(
    el("div", { class: "sheet-section" },
      el("div", { class: "sheet-section-title" }, "Тема"),
      el("div", { class: "segmented" }, THEME_OPTIONS.map(([v, label]) => el("button", {
        type: "button", class: currentLook.theme === v ? "active" : "", onclick: () => choose({ theme: v }),
      }, label)))),
    el("div", { class: "sheet-section" },
      el("div", { class: "sheet-section-title" }, "Стиль"),
      el("div", { class: "rows" }, STYLE_PRESETS.map((p) => el("button", {
        type: "button", class: "row look-row", onclick: () => choose({ style: p.id }),
      },
        el("span", { class: "look-swatch" }, p.sw.map((c) => el("span", { style: `background:${c}` }))),
        el("span", { style: "flex:1;min-width:0" }, el("b", {}, p.name), el("span", { class: "small muted look-note" }, p.note)),
        currentLook.style === p.id ? el("span", { class: "row-check", html: ICON_CHECK }) : null)))));
  draw();
  return body;
}

function viewProfile() {
  // Все пункты профиля — одинаковые ссылки на свои экраны; оформление и
  // смена пароля собраны в «Настройках» (раньше одни пункты открывали
  // экран, а соседние раскрывались на месте — путало).
  return [
    bar(SESSION?.name || SESSION?.login || "Профиль", "/"),
    el("main", { class: "wrap" },
      el("div", { class: "rows rows-separate", style: "margin-bottom:12px" },
        homeLink("Выполненные работы", "/profile/report", ICONS.report),
        SESSION?.role === "admin" ? homeLink("Админка", "/admin", ICONS.admin) : null,
        homeLink("Настройки", "/profile/settings", ICONS.settings)),
      el("div", { style: "display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-top:16px" },
        el("button", { style: "border:0;background:none;color:var(--muted);text-decoration:underline;padding:0;min-height:0", onclick: logout }, "Выйти"),
        // Время сборки = время публикации на сайте (Vercel собирает при каждом
        // пуше) — видно, обновилась ли у мастера страница после выкладки.
        BUILD_TIME ? el("span", { class: "small muted" }, "Версия от " + BUILD_TIME) : null)),
  ];
}

// Настройки: оформление и смена пароля — разделами на одном экране, без
// раскрытий и шторок.
function viewSettings() {
  const error = el("p", { class: "small", style: "color:var(--warn);display:none" });
  const form = el("form", { onsubmit: async (ev) => {
    ev.preventDefault();
    error.style.display = "none";
    try {
      await authAction({ action: "changePassword", currentPassword: ev.target.current.value, newPassword: ev.target.next.value });
      ev.target.reset();
      toast("Пароль изменён");
    } catch (e) {
      error.textContent = e.message || "Не удалось сменить пароль";
      error.style.display = "";
    }
  } },
    ...field("Текущий пароль", "current", "password", "current-password"),
    ...field("Новый пароль", "next", "password", "new-password"),
    error,
    el("button", { class: "btn-primary", type: "submit", style: "width:100%;margin-top:16px" }, "Сменить пароль"));
  return [
    bar("Настройки", "/profile"),
    // Разделы одного уровня — «Тема», «Стиль» (из lookEditor) и «Пароль».
    el("main", { class: "wrap" },
      lookEditor(),
      el("div", { class: "sheet-section" },
        el("div", { class: "sheet-section-title" }, "Пароль"),
        el("div", { class: "card settings-password" }, form))),
  ];
}

// ============================================================================
//  ОТЧЁТ ПО ВЫРАБОТКЕ
// ============================================================================
// Один и тот же экран и для «мой отчёт» в профиле, и для отчёта по одному
// мастеру из админки, и для сводки по всем сразу — отличаются только тем,
// каких мастеров включает workLog/historyList (null — всех) и как считается
// процент (percentOf: masterId → число, у разных мастеров он может быть
// разным). Источник — сама DB (уже вся загружена на клиенте), отдельный API
// не нужен: идём по всем обращениям, по всем выполненным пунктам (doneBy).

// Одна запись — один выполненный пункт наряда (мастер делает пункт целиком,
// без дележа — см. историю про отказ от completions/qty-дележа). masterId
// === null — записи всех мастеров сразу (сводный отчёт).
function workLog(masterId) {
  return reportEntries(loadDB().orders, masterId);
}
// Заработок с одной такой записи — стоимость работы (без запчастей) целиком,
// умноженная на процент мастера, который её выполнил (percentOf — функция
// masterId → процент, а не одно число: в сводном отчёте у каждой строки свой
// мастер и свой процент).
function entryEarned(e, percentOf) {
  return itemWorkValue(e.item) * (percentOf(e.item.doneBy?.masterId) / 100);
}
// Три вкладки отчёта: «Неделя» — по дням, «Месяц» — по неделям, «Год» — по
// месяцам. n — «отрезков назад от текущего» (0 — сегодня/эта неделя/этот
// месяц, отрицательное — будущее). minN на вкладку — жёсткий предел вперёд
// (дальше пусто и листать некуда); назад — без ограничения, догружается по
// мере прокрутки (см. buildReportTab).
const PERIOD_TABS = [
  { key: "week", unit: "day", count: 7, label: "Неделя" },
  { key: "month", unit: "week", count: 4, label: "Месяц" },
  { key: "year", unit: "month", count: 12, label: "Год" },
];
function bucketAt(unit, n) {
  const now = new Date();
  let unitStart;
  if (unit === "day") unitStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  else if (unit === "week") {
    const dow = now.getDay();
    unitStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (dow === 0 ? 6 : dow - 1));
  } else unitStart = new Date(now.getFullYear(), now.getMonth(), 1);
  let from, to, label;
  if (unit === "day") {
    from = new Date(unitStart.getFullYear(), unitStart.getMonth(), unitStart.getDate() - n);
    to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
    label = from.toLocaleDateString("ru-RU", { weekday: "short" });
  } else if (unit === "week") {
    from = new Date(unitStart.getFullYear(), unitStart.getMonth(), unitStart.getDate() - n * 7);
    to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 7);
    label = from.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  } else {
    from = new Date(unitStart.getFullYear(), unitStart.getMonth() - n, 1);
    to = new Date(from.getFullYear(), from.getMonth() + 1, 1);
    label = from.toLocaleDateString("ru-RU", { month: "short" });
  }
  return { n, from, to, label };
}
// Лёгкая вибрация, когда лента графика «доехала» до новой колонки —
// на Android (Vibration API); на iOS Safari эту функцию до сих пор не
// поддерживает ни браузер, ни установленное как приложение (standalone),
// так что там вызов молча ничего не делает (не ошибка — просто нет эффекта
// на этой платформе).
function hapticTick() { try { navigator.vibrate && navigator.vibrate(10); } catch {} }
// masterId === null — история по всем мастерам сразу: в одном обращении
// могли поучаствовать несколько, поэтому каждая строка подписана именем.
function historyList(masterId, percentOf, from, to) {
  const d = loadDB();
  const byOrder = new Map();
  for (const { order: o, item: it } of reportEntries(d.orders, masterId, from, to)) {
    const bike = d.bikes.find((b) => b.number === o.bikeNumber);
    const client = d.clients.find((c) => c.phone === o.clientPhone);
    const c = it.doneBy;
    // Дата выдачи определяет и период оплаты, и порядок в истории.
    if (!byOrder.has(o.number)) byOrder.set(o.number, { order: o, bike, client, lines: [], earned: 0, handedAt: o.handedOverAt });
    const rec = byOrder.get(o.number);
    const earned = entryEarned({ item: it }, percentOf);
    rec.lines.push({ name: it.name, earned, masterName: c.masterName });
    rec.earned += earned;
  }
  return [...byOrder.values()].sort((a, b) => b.handedAt.localeCompare(a.handedAt));
}

// Тело отчёта (переключатель периода + график + история) — общее что для
// одного мастера, что для сводки по всем; header — то, что показывается
// сверху карточки над переключателем (имя+процент или «Все мастера»).
// Полное описание отрезка — для подписи над суммой, когда выбран конкретный
// столбец (короткая подпись под столбцом типа «18» или «сен» там не
// прочитать, что именно выбрано).
function bucketFullLabel(unit, from) {
  if (unit === "day") return from.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
  if (unit === "week") return "неделя с " + from.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  return from.toLocaleDateString("ru-RU", { month: "long", year: "numeric" });
}
// Подпись всего видимого окна, когда столбец не выбран — окно теперь
// листаемое (offset может быть любым), поэтому не «последние N», а
// фактический диапазон дат видимых столбцов.
function windowRangeLabel(unit, buckets) {
  const from = buckets[0].from;
  const toIncl = new Date(buckets[buckets.length - 1].to.getTime() - 1);
  const fmt = unit === "month"
    ? (d) => d.toLocaleDateString("ru-RU", { month: "short", year: "numeric" })
    : (d) => d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  return `${fmt(from)} – ${fmt(toIncl)}`;
}

// Сколько отрезков-«назад» подгружаем сразу и порциями при подскролле к
// началу списка — как история чата: не всё сразу, но и не ждать заново на
// каждый чих. 60 достаточно с запасом даже для «Недели» (по дням — это
// ~2 месяца назад), а для «Года» (по месяцам) — 5 лет.
const REPORT_INITIAL_PAST = 60;
const REPORT_PAST_CHUNK = 30;

// Тело одной вкладки отчёта: настоящая горизонтально прокручиваемая лента
// столбцов (нативный scroll-snap, как строка дат в Яндекс.Go у водителей) —
// не карусель из подменяемых кусков, все колонки уже в DOM и участвуют.
// Прошлое подгружается порциями при подскролле к началу; будущее (n<0)
// зафиксировано жёстким пределом на вкладку — его просто не рендерим дальше.
function buildReportTab(masterId, percentOf, tab) {
  const log = workLog(masterId);
  const minN = -(tab.count - 1);
  let maxN = REPORT_INITIAL_PAST;
  const cache = new Map();
  const bucketFor = (n) => {
    let b = cache.get(n);
    if (b) return b;
    const base = bucketAt(tab.unit, n);
    const entries = log.filter((e) => e.at >= base.from && e.at < base.to);
    b = { ...base, earned: entries.reduce((s, e) => s + entryEarned(e, percentOf), 0), count: entries.length };
    cache.set(n, b);
    return b;
  };
  // Шкала графика — от начальной загруженной истории (не пересчитывается
  // при подгрузке более старых колонок: иначе один крупный старый заказ
  // мог бы задним числом «сплющить» уже привычный масштаб текущих дней).
  for (let n = maxN; n >= minN; n--) bucketFor(n);
  const maxEarned = Math.max(1, ...[...cache.values()].map((b) => b.earned));
  const barHeightPx = (earned) => Math.max(2, Math.min(96, Math.round((earned / maxEarned) * 96)));

  let selectedN = 0; // по умолчанию выбран сегодняшний/текущий отрезок
  let searchPhone = "";
  let rangeFrom = null, rangeTo = null; // диапазон для истории ниже — обновляют updateHeader()/selectColumn()
  // Программная установка стартовой позиции скролла ниже сама по себе
  // стреляет событием "scroll" — без этого флага обработчик тут же принял
  // бы её за жест пользователя и сбросил выбор «сегодня» по умолчанию.
  let suppressNextScroll = false;

  const sumEl = el("div", { class: "price-range", style: "margin-top:14px" });
  const subEl = el("div", { class: "small muted" });
  const historyItemsEl = el("div", {});
  const historySection = el("div", {},
    el("p", { class: "small section-title", style: "margin:16px 0 4px;font-weight:700;letter-spacing:.06em" }, "ИСТОРИЯ ВЫПОЛНЕННЫХ ОБРАЩЕНИЙ"),
    historyItemsEl);

  const colWidthPct = 100 / tab.count;
  const scroller = el("div", { class: "report-scroller", style: "display:flex;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;margin-top:14px;height:120px" });
  const colNodes = new Map(); // n -> {col, bar, label} — для точечной перекраски выбора без пересборки DOM

  const makeCol = (n) => {
    const b = bucketFor(n);
    // Вид столбца — от стиля оформления (.report-bar в app.css/themes.css).
    const bar = el("div", { class: "report-bar", title: money(b.earned), style: `height:${barHeightPx(b.earned)}px` });
    const label = el("span", { class: "small", style: "font-size:10px;white-space:nowrap;color:var(--muted);font-weight:400" }, b.label);
    const col = el("div", {
      style: `flex:0 0 ${colWidthPct}%;min-width:0;scroll-snap-align:start;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end;cursor:pointer`,
      onclick: () => selectColumn(n),
    }, bar, label);
    colNodes.set(n, { col, bar, label });
    return col;
  };
  {
    const frag = document.createDocumentFragment();
    for (let n = maxN; n >= minN; n--) frag.appendChild(makeCol(n));
    scroller.appendChild(frag);
  }

  const restyleSelection = () => {
    for (const [n, { bar, label }] of colNodes) {
      const isSel = selectedN === n;
      const dimmed = selectedN != null && !isSel;
      bar.classList.toggle("dim", dimmed);
      label.style.color = isSel ? "var(--accent)" : "var(--muted)";
      label.style.fontWeight = isSel ? "700" : "400";
    }
  };
  restyleSelection();

  // Какая колонка сейчас крайняя слева по фактической позиции скролла —
  // общее для суммы «по всему окну» и для того, чтобы вибрировать только
  // когда лента реально доехала до новой позиции, а не на каждый тик.
  const currentLeftN = () => {
    const colWidthPx = scroller.clientWidth / tab.count || 1;
    const leftIdx = Math.max(0, Math.round(scroller.scrollLeft / colWidthPx));
    return maxN - leftIdx;
  };
  const visibleWindowBuckets = () => {
    const leftN = currentLeftN();
    const out = [];
    for (let i = 0; i < tab.count; i++) out.push(bucketFor(leftN - i));
    return out;
  };

  const updateHeader = () => {
    if (selectedN != null) {
      const b = bucketFor(selectedN);
      sumEl.textContent = money(b.earned);
      subEl.textContent = `${b.count} работ · за ${bucketFullLabel(tab.unit, b.from)}`;
      rangeFrom = b.from; rangeTo = b.to;
    } else {
      const win = visibleWindowBuckets();
      const earned = win.reduce((s, b) => s + b.earned, 0);
      const count = win.reduce((s, b) => s + b.count, 0);
      sumEl.textContent = money(earned);
      subEl.textContent = `${count} работ · за ${windowRangeLabel(tab.unit, win)}`;
      rangeFrom = win[0].from; rangeTo = win[win.length - 1].to;
    }
  };

  const redrawHistory = () => {
    if (!rangeFrom) return;
    const qDigits = maskedDigits(searchPhone);
    let history = historyList(masterId, percentOf, rangeFrom, rangeTo);
    if (qDigits) history = history.filter((rec) => phoneDigits(rec.order.clientPhone).includes(qDigits));
    historyItemsEl.replaceChildren(
      history.length === 0
        ? emptyState(qDigits ? "Ничего не найдено." : "Пока ничего не выполнено.", qDigits ? EMPTY_ICON_SEARCH : undefined)
        // Карточка — ссылка на само обращение: открыть, посмотреть весь
        // наряд целиком. По сути и есть архив выданных обращений, только
        // тут ещё сразу видно, что в нём сделал этот мастер и за сколько.
        : el("div", { class: "list", style: "gap:10px" }, history.map((rec) => el("a", { class: "card card-link report-history-card", href: `#/orders/${rec.order.number}` },
            el("b", { class: "report-history-title" }, rec.bike ? bikeLabel(rec.bike) : rec.client?.name || "Обращение"),
            rec.handedAt ? el("div", { class: "small muted report-history-date" }, formatDateShort(rec.handedAt)) : null,
            el("div", { class: "small muted report-history-lines" },
              rec.lines.map((l) => el("div", {}, "– ", l.name, " ", money(l.earned)))),
            el("div", { class: "report-history-footer" },
              el("span", { class: "control-price" }, money(rec.earned))))))
    );
  };

  const selectColumn = (n) => {
    selectedN = selectedN === n ? null : n;
    restyleSelection();
    updateHeader();
    redrawHistory();
  };

  // У самого начала ленты (близко к самой старой подгруженной колонке) —
  // молча подгружаем ещё порцию прошлого и правим scrollLeft на её ширину,
  // чтобы лента не дёрнулась под пальцем.
  const maybeExtendPast = () => {
    const colWidthPx = scroller.clientWidth / tab.count || 1;
    if (scroller.scrollLeft > colWidthPx * 8) return;
    const beforeWidth = scroller.scrollWidth;
    const frag = document.createDocumentFragment();
    for (let n = maxN + REPORT_PAST_CHUNK; n > maxN; n--) frag.appendChild(makeCol(n));
    scroller.insertBefore(frag, scroller.firstChild);
    maxN += REPORT_PAST_CHUNK;
    scroller.scrollLeft += scroller.scrollWidth - beforeWidth;
    restyleSelection();
  };

  let settleTimer = null;
  let lastLeftN = currentLeftN();
  scroller.addEventListener("scroll", () => {
    if (suppressNextScroll) { suppressNextScroll = false; return; }
    if (selectedN !== null) { selectedN = null; restyleSelection(); }
    updateHeader();
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      maybeExtendPast();
      redrawHistory();
      const n = currentLeftN();
      if (n !== lastLeftN) { lastLeftN = n; hapticTick(); }
    }, 150);
  }, { passive: true });

  updateHeader();
  redrawHistory();

  // Стартовая позиция — сегодняшняя/текущая колонка последней видимой
  // справа, будущее (если есть) — правее, вне экрана, до свайпа. Реальную
  // ширину знаем только после того, как лента реально встала в документ —
  // поэтому откладываем на следующий кадр.
  requestAnimationFrame(() => {
    const colWidthPx = scroller.clientWidth / tab.count;
    if (colWidthPx > 0) {
      suppressNextScroll = true;
      scroller.scrollLeft = Math.max(0, (maxN - tab.count + 1) * colWidthPx);
      // На случай если браузер не пришлёт "scroll" вовсе (значение и так
      // было тем же) — не оставлять флаг взведённым навсегда.
      setTimeout(() => { suppressNextScroll = false; }, 50);
    }
  });

  return {
    sumEl, subEl, scroller, historySection,
    setSearch: (v) => { searchPhone = v; redrawHistory(); },
  };
}

// Возвращает {content, searchBar} — searchBar рисуется отдельным
// закреплённым низом экрана (как в актуальных iOS-интерфейсах — Почта,
// Сообщения), а не частью прокручиваемого content, поэтому и не
// пересоздаётся на каждой перерисовке списка (иначе поле теряло бы фокус
// на каждый введённый символ). Ищет по номеру телефона клиента — то же,
// что раньше умел архив выданных обращений, который эта история заменила.
function reportContent(masterId, percentOf, header) {
  // По умолчанию — «Неделя».
  let tabKey = "week";
  let searchPhone = "";
  const box = el("div", {});
  let tabApi = null;
  const mountTab = () => {
    const tab = PERIOD_TABS.find((t) => t.key === tabKey);
    tabApi = buildReportTab(masterId, percentOf, tab);
    tabApi.setSearch(searchPhone);
    box.replaceChildren(
      el("div", { class: "card" },
        header,
        el("div", { class: "segmented", style: "margin-top:10px" },
          PERIOD_TABS.map((t) => el("button", { class: tabKey === t.key ? "active" : "", onclick: () => { tabKey = t.key; mountTab(); } }, t.label))),
        tabApi.sumEl, tabApi.subEl, tabApi.scroller),
      tabApi.historySection);
  };
  mountTab();
  // Пустое поле с подсказкой — не «+7» сразу, а только когда по нему
  // тапнули (иначе на пустом экране постоянно висит код страны, будто
  // уже что-то введено). Если ушли с поля, ничего не набрав — подсказка
  // возвращается.
  const searchInput = el("input", { type: "tel", placeholder: "Поиск заявки по номеру телефона", style: "flex:1", value: "" });
  attachPhoneMask(searchInput, (v) => { searchPhone = v; tabApi.setSearch(v); });
  searchInput.addEventListener("focus", () => { if (!searchInput.value) searchInput.value = "+7"; });
  searchInput.addEventListener("blur", () => { if (!maskedDigits(searchInput.value)) searchInput.value = ""; });
  return { content: box, searchBar: el("div", { class: "actions" }, el("div", { class: "actions-inner" }, searchInput)) };
}

function masterReportScreen(masterId, backHash) {
  const host = el("main", { class: "wrap" }, skeletonRows());
  const own = backHash === "/profile";
  const onScreen = () => location.hash === "#" + (own ? "/profile/report" : `/admin/reports/${masterId}`);
  // Из админки (список мастеров) — это и есть экран мастера: в заголовке
  // его имя, справа карандаш с настройками (процент, штрихкод, пароль,
  // доступ). У себя в профиле — просто «Выполненные работы».
  let master = usersCache?.find((u) => u.id === masterId) || null;
  const title = el("h1", {}, own ? "Выполненные работы" : master?.name || "Мастер");
  const editBtn = own ? null : el("button", {
    class: "edit-btn", style: iconBtnStyle, "aria-label": "Настройки мастера", title: "Настройки мастера", html: ICON_EDIT,
    onclick: () => master && openMasterSettings(master, { onChanged: router, onDeleted: () => goBack("/admin/masters") }),
  });
  ensureUsers().then((users) => {
    if (!onScreen()) return;
    master = users.find((u) => u.id === masterId) || { id: masterId, name: "—", commissionPercent: 0 };
    if (!own) title.textContent = master.name;
    const percent = master.commissionPercent || 0;
    // Сам процент — только там, где его редактируют (настройки мастера в
    // админке), тут лишний, не мастеру решать/сверять свою ставку.
    const header = own ? el("div", {}, master.name) : null;
    const { content, searchBar } = reportContent(masterId, () => percent, header);
    host.replaceChildren(content, searchBar);
  });
  return [el("header", { class: "bar" }, backLink(backHash), title, editBtn), host];
}

// Сводка по всем мастерам сразу — тот же экран, что и у одного мастера
// (переключатель день/неделя/месяц, график, история), только не по одному
// человеку, а по всем: у каждой записи в графике/истории свой процент —
// свой у каждого мастера.
function viewAllMastersReport() {
  const host = el("main", { class: "wrap" }, skeletonRows());
  ensureUsers().then((users) => {
    if (location.hash !== "#/admin/reports") return;
    const percentByMaster = Object.fromEntries(users.map((u) => [u.id, u.commissionPercent || 0]));
    const percentOf = (masterId) => percentByMaster[masterId] || 0;
    const header = el("div", {}, "Все мастера");
    const { content, searchBar } = reportContent(null, percentOf, header);
    host.replaceChildren(content, searchBar);
  });
  return [bar("Выполненные работы", "/admin"), host];
}

// ============================================================================
//  АДМИНКА
// ============================================================================

function viewAdmin() {
  const tile = (title, hint, hash, icon) => el("a", { class: "admin-tile card-link", href: "#" + hash },
    el("span", { class: "row-icon", html: icon }),
    el("span", { class: "admin-tile-text" }, el("b", {}, title), el("span", { class: "small muted" }, hint)),
    el("span", { class: "chev" }, "›"));
  return [
    bar("Админка", "/"),
    el("main", { class: "wrap" },
      el("div", { class: "admin-tiles" },
        tile("Выполненные работы", "История и выработка", "/admin/reports", ICONS.report),
        tile("Мастера", "Сотрудники и ставки", "/admin/masters", ICONS.masters),
        tile("Клиенты", "Контакты и велосипеды", "/admin/clients", ICONS.clients),
        tile("Запчасти", "Остатки и цены", "/admin/stock", ICONS.stock),
        tile("Синхронизация с 1С", "Сверить выгрузку обращений", "/admin/1c", ICONS.sync))),
  ];
}

// ---------------------------- мастера ---------------------------------------

async function loadMasters() {
  try {
    const r = await fetch("/api/users", { cache: "no-store" });
    const j = await r.json();
    if (r.ok) primeUsersCache(j.users || []);
    if (location.hash !== "#/admin/masters") return;
    render(mastersScreen(r.ok ? j.users : [], r.ok ? "" : j.error || "ошибка"), { keepScroll: true });
  } catch {
    if (location.hash === "#/admin/masters") render(mastersScreen([], "нет соединения"));
  }
}
function viewMasters() {
  loadMasters();
  // Список уже знаем (вернулись с экрана мастера) — рисуем сразу, без
  // заглушки: так и имя в заголовке плавно возвращается на свою карточку.
  if (usersCache?.length) return mastersScreen(usersCache, "");
  return [bar("Мастера", "/admin"), el("main", { class: "wrap" }, skeletonRows())];
}

async function usersApi(method, body) {
  const r = await fetch("/api/users", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert(j.error || "ошибка"); return null; }
  clearUsersCache(); // список мастеров/процентов изменился — отчётам нужен свежий
  return j;
}

// Настройки мастера (шторка под карандашом на его экране) — по разделам (оплата, пароль, доступ), каждое
// действие со своей кнопкой под своим разделом, а не всё в одну кучу.
function openMasterSettings(u, { onChanged, onDeleted }) {
  let sheet;
  const controls = el("div", { class: "admin-person-controls" });

  controls.append(el("form", {
    class: "sheet-section", onsubmit: async (ev) => {
      ev.preventDefault();
      if (await usersApi("PUT", { id: u.id, login: ev.target.login.value })) { sheet.close(); onChanged(); toast("Телефон для входа сохранён"); }
    },
  },
    el("h3", {}, "Вход"),
    el("div", { class: "form-list" }, formRow("Телефон", phoneLoginInput("login", { value: /^\+7\d{10}$/.test(u.login || "") ? u.login : "" }))),
    el("button", { type: "submit", style: "width:100%;margin-top:10px" }, "Сохранить телефон")));

  controls.append(el("form", {
    class: "sheet-section", onsubmit: async (ev) => {
      ev.preventDefault();
      if (await usersApi("PUT", { id: u.id, commissionPercent: ev.target.commissionPercent.value })) { sheet.close(); onChanged(); toast("Процент обновлён"); }
    },
  },
    el("h3", {}, "Оплата"),
    el("div", { class: "form-list" },
      formRow("Процент от работы", el("input", { name: "commissionPercent", type: "number", min: 0, max: 100, value: u.commissionPercent || 0, inputmode: "numeric" }), "%")),
    el("button", { type: "submit", style: "width:100%;margin-top:10px" }, "Сохранить процент")));

  controls.append(el("form", {
    class: "sheet-section", onsubmit: async (ev) => {
      ev.preventDefault();
      if (await usersApi("PUT", { id: u.id, serviceBarcode1C: ev.target.serviceBarcode1C.value })) {
        sheet.close(); onChanged(); toast("Штрихкод услуги сохранён");
      }
    },
  },
    el("h3", {}, "Услуга в 1С"),
    el("div", { class: "form-list" },
      formRow("Штрихкод услуги мастера", el("input", {
        name: "serviceBarcode1C", inputmode: "numeric", maxlength: 13, value: u.serviceBarcode1C || "",
      }))),
    el("button", { type: "submit", style: "width:100%;margin-top:10px" }, "Сохранить штрихкод")));

  controls.append(el("form", {
    class: "sheet-section", onsubmit: async (ev) => {
      ev.preventDefault();
      const password = ev.target.password.value;
      if (!password) return;
      if (await usersApi("PUT", { id: u.id, password })) { sheet.close(); toast("Пароль обновлён"); }
    },
  },
    el("h3", {}, "Пароль"),
    el("div", { class: "form-list" },
      formRow("Новый пароль", el("input", { name: "password", type: "password", autocomplete: "new-password" }))),
    el("button", { type: "submit", style: "width:100%;margin-top:10px" }, "Сменить пароль")));

  controls.append(el("h3", { class: "sheet-section-title" }, "Доступ"));
  controls.append(el("div", { class: "btn-row" },
    el("button", { onclick: async () => { if (await usersApi("PUT", { id: u.id, active: !u.active })) { sheet.close(); onChanged(); } } },
      u.active ? "Отключить" : "Включить"),
    el("button", {
      class: "btn-warn", onclick: async () => {
        if (!confirm(`Удалить мастера «${u.name}»?`)) return;
        if (await usersApi("DELETE", { id: u.id })) { sheet.close(); onDeleted(); }
      },
    }, "Удалить")));
  sheet = openSheet(u.name, controls);
}

function mastersScreen(list, error) {
  const addForm = el("form", {
    class: "admin-form", onsubmit: async (ev) => {
      ev.preventDefault();
      const ok = await usersApi("POST", {
        name: ev.target.name.value.trim(), login: ev.target.login.value.trim(),
        password: ev.target.password.value, role: ev.target.role.value, commissionPercent: ev.target.commissionPercent.value,
      });
      if (ok) { ev.target.reset(); loadMasters(); }
    },
  },
    el("h2", {}, "Новый сотрудник"),
    el("div", { class: "form-list" },
      formRow("Имя", el("input", { name: "name", autocomplete: "off" })),
      formRow("Телефон", phoneLoginInput("login")),
      formRow("Пароль", el("input", { name: "password", type: "password", autocomplete: "new-password" })),
      formRow("Роль", el("select", { name: "role" }, el("option", { value: "master" }, "Мастер"), el("option", { value: "admin" }, "Администратор"))),
      formRow("Процент", el("input", { name: "commissionPercent", type: "number", min: 0, max: 100, value: 0, inputmode: "numeric" }), "%")),
    el("button", { class: "btn-primary", type: "submit", style: "width:100%;margin-top:16px" }, "Добавить"));


  // Карточка целиком ведёт на экран мастера — его выполненные работы,
  // настройки там под карандашом в шапке.
  const rows = list.map((u) => el("a", { class: "admin-person-card card-link", href: `#/admin/reports/${u.id}` },
    el("div", { class: "admin-person-head" }, el("b", {}, u.name),
      u.role === "admin" ? el("span", { class: "pill" }, "админ") : null,
      !u.active ? el("span", { class: "pill" }, "отключён") : null,
      el("span", { class: "chev" }, "›")),
    el("div", { class: "small muted" }, loginLabel(u.login))));

  return [
    bar("Мастера", "/admin"),
    el("main", { class: "wrap" },
      error ? el("p", { class: "small", style: "color:var(--warn)" }, error) : null,
      el("details", { class: "admin-details admin-add-card" }, el("summary", {}, "+ Добавить сотрудника"), addForm),
      list.length === 0
        ? el("p", { class: "muted", style: "margin-top:12px" }, "Мастеров пока нет.")
        : el("div", { class: "admin-tiles", style: "margin-top:12px" }, rows)),
  ];
}

// ---------------------------- клиенты и их велосипеды -----------------------
// Клиенты/велосипеды — часть общей DB (см. loadDB/editDB в начале файла),
// отдельного API для них нет: та же фоновая синхронизация, что и у обращений,
// поэтому экран строится сразу из loadDB(), без отдельной загрузки.

function viewClients() {
  const box = el("div", {});
  let q = "";
  const redraw = () => {
    const ql = q.trim().toLowerCase();
    const qDigits = phoneDigits(q);
    let list = [...loadDB().clients];
    if (ql || qDigits)
      list = list.filter((c) => (c.name || "").toLowerCase().includes(ql) || (qDigits && phoneDigits(c.phone).includes(qDigits)));
    list.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ru"));
    box.replaceChildren(
      list.length === 0
        ? emptyState(q ? "Ничего не найдено." : "Клиентов пока нет.", q ? EMPTY_ICON_SEARCH : undefined)
        : el("div", { class: "list", style: "gap:10px" }, list.map(clientCard)));
  };
  const searchInput = el("input", { type: "text", placeholder: "Поиск по имени или телефону" });
  searchInput.addEventListener("input", (e) => { q = e.target.value; redraw(); });
  redraw();
  return [
    bar("Клиенты", "/admin"),
    el("main", { class: "wrap" },
      el("div", { class: "admin-search" }, searchInput),
      el("div", { style: "margin-top:12px" }, box)),
  ];
}

const clientHref = (phone) => `/admin/clients/${encodeURIComponent(phone)}`;

function clientCard(c) {
  const db = loadDB();
  const bikes = db.bikes.filter((b) => b.ownerPhone === c.phone);
  const visits = db.orders.filter((o) => o.clientPhone === c.phone).length;
  return el("a", { class: "admin-person-card card-link", href: `#${clientHref(c.phone)}` },
    el("div", { class: "admin-person-head" }, el("b", {}, c.name || "Без имени"), el("span", { class: "chev" }, "›")),
    el("div", { class: "small muted" }, applyPhoneMask(c.phone), visits ? ` · ${visits} обращ.` : ""),
    el("div", { class: "small muted", style: "margin-top:6px" },
      bikes.length ? bikes.map((b) => el("div", {}, bikeLabel(b) || "велосипед (без названия)")) : "Велосипедов нет"));
}

function clientOrderRows(orders, db) {
  if (!orders.length) return el("p", { class: "small muted", style: "margin:8px 0 0" }, "Обращений пока нет.");
  return el("div", { class: "list", style: "gap:10px" },
    [...orders].sort((a, b) => String(b.handedOverAt || b.createdAt || "").localeCompare(String(a.handedOverAt || a.createdAt || "")))
      .map((o) => {
        const bike = db.bikes.find((b) => b.number === o.bikeNumber);
        return el("a", { class: "admin-person-card card-link client-order-row", href: `#/orders/${encodeURIComponent(o.number)}` },
          el("div", { class: "admin-person-head" },
            el("b", {}, bike ? bikeLabel(bike) || "Велосипед" : o.clientName || "Без велосипеда"),
            el("span", { class: "chev" }, "›")),
          el("div", { class: "small muted" }, formatDateShort(o.handedOverAt || o.createdAt) || "Без даты"),
          el("div", { class: "client-order-footer" }, orderStatusTag(o),
            el("span", { class: "control-price" }, rangeText(orderRangeAll(o)))));
      }));
}

function viewClientDetails(phone, initialBike = "") {
  const db = loadDB();
  const client = db.clients.find((c) => c.phone === phone);
  if (!client) return [bar("Клиент", "/admin/clients"), el("main", { class: "wrap" }, emptyState("Клиент не найден."))];
  const bikes = db.bikes.filter((b) => b.ownerPhone === phone);
  const orders = db.orders.filter((o) => o.clientPhone === phone);
  const orderList = el("div", {});
  const showOrders = (bikeNumber) => orderList.replaceChildren(clientOrderRows(
    bikeNumber ? orders.filter((o) => o.bikeNumber === bikeNumber) : orders, db));
  showOrders(bikes.some((b) => b.number === initialBike) ? initialBike : "");
  const onEdit = (newPhone) => {
    if (!newPhone) return goBack("/admin/clients");
    const target = clientHref(newPhone);
    if (location.hash === `#${target}`) router(); else goReplace(target);
  };
  return [bar(client.name || "Клиент", "/admin/clients",
      el("button", { class: "edit-btn", style: iconBtnStyle,
        "aria-label": "Редактировать клиента", title: "Редактировать клиента", html: ICON_EDIT,
        onclick: () => openClientEditor(client, onEdit) })),
    el("main", { class: "wrap" },
      el("a", { class: "admin-person-card card-link client-phone-card", href: `tel:${phone.replace(/[^\d+]/g, "")}`,
        "aria-label": `Позвонить ${applyPhoneMask(phone)}` },
        el("span", { class: "client-phone-number" }, applyPhoneMask(phone)),
        el("span", { class: "call-btn", html: ICON_PHONE })),
      el("h2", { class: "client-detail-heading" }, "Обращения"),
      el("div", { class: "client-filter" },
        el("div", { class: "client-filter-select" },
          el("select", { id: "client-bike-filter", "aria-label": "Велосипед",
            onchange: (e) => showOrders(e.target.value) },
            el("option", { value: "", selected: !bikes.some((b) => b.number === initialBike) }, "Все велосипеды"),
            bikes.map((bike) => el("option", { value: bike.number, selected: bike.number === initialBike }, bikeLabel(bike) || "Велосипед (без названия)"))))),
      orderList)];
}

// Форма правки клиента — телефон тоже редактируемый (используется как ключ
// в bikes.ownerPhone/orders.clientPhone), поэтому при сохранении с новым
// номером переносим ссылки во всех велосипедах и обращениях этого клиента,
// а не заводим тихо второго клиента под старым номером.
function openClientEditor(c, onChange) {
  const state = {
    name: c.name || "",
    phone: c.phone,
    bikes: loadDB().bikes.filter((b) => b.ownerPhone === c.phone).map((b) => ({ ...b })),
  };
  const removedBikeNumbers = [];
  let sheet;

  const nameInput = el("input", { type: "text", value: state.name, oninput: (e) => (state.name = e.target.value) });
  const phoneInput = el("input", { type: "tel", value: applyPhoneMask(state.phone) });
  attachPhoneMask(phoneInput, (v) => { state.phone = v; });

  const errorEl = el("p", { class: "small", style: "color:var(--warn);display:none" });
  const showError = (msg) => { errorEl.textContent = msg; errorEl.style.display = ""; };

  const bikesBox = el("div", {});
  const drawBikes = () => {
    bikesBox.replaceChildren(
      ...state.bikes.map((b, i) => el("div", { style: "display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap" },
        el("input", { value: b.name || "", placeholder: "Велосипед", style: "flex:1;min-width:100px", oninput: (e) => (b.name = e.target.value) }),
        el("button", { onclick: () => { if (b.number) removedBikeNumbers.push(b.number); state.bikes.splice(i, 1); drawBikes(); } }, "✕"))),
      el("button", { style: "margin-top:8px", onclick: () => { state.bikes.push({ number: null, name: "", ownerPhone: state.phone }); drawBikes(); } }, "+ велосипед"));
  };
  drawBikes();

  const save = async () => {
    const name = state.name.trim();
    if (!isValidPhone(state.phone)) return showError("Проверьте номер телефона");
    const oldPhone = c.phone;
    const dup = loadDB().clients.find((x) => x.phone !== oldPhone && phoneDigits(x.phone) === phoneDigits(state.phone));
    if (dup) return showError(`Этот номер уже занят клиентом «${dup.name || dup.phone}»`);
    const newPhone = state.phone;
    const phoneChanged = phoneDigits(oldPhone) !== phoneDigits(newPhone);
    // Добавления/правки (новое имя, перенос владельца, новые велосипеды) —
    // обычным пушем, слияние на сервере их прекрасно подхватывает по ключу.
    const ok = await pushDbNow((d) => {
      const client = d.clients.find((x) => x.phone === oldPhone);
      if (client) { client.name = name; client.phone = newPhone; }
      if (phoneChanged) {
        for (const b of d.bikes) if (b.ownerPhone === oldPhone) b.ownerPhone = newPhone;
        for (const o of d.orders) if (o.clientPhone === oldPhone) o.clientPhone = newPhone;
      }
      for (const sb of state.bikes) {
        if (sb.number) {
          const existing = d.bikes.find((b) => b.number === sb.number);
          if (existing) { existing.name = sb.name.trim(); existing.ownerPhone = newPhone; }
        } else {
          const number = nextBikeKey(d, newPhone);
          d.bikes.push({ number, name: sb.name.trim(), ownerPhone: newPhone });
          sb.number = number;
        }
      }
    });
    if (!ok) return showError("Нет соединения — попробуйте ещё раз");
    // А вот то, что должно пропасть (убранные велосипеды, старая запись
    // клиента под прежним номером при смене телефона) — только явным DELETE:
    // слияние само по себе ничего не удаляет, пропавшее из пуша вернулось бы
    // на сервере обратно при следующей же синхронизации.
    for (const num of removedBikeNumbers) await deleteBikeApi(num);
    if (phoneChanged) await deleteClientApi(oldPhone);
    toast("Сохранено");
    sheet.close();
    onChange(newPhone);
  };

  const deleteClient = async () => {
    const own = loadDB().orders.filter((o) => o.clientPhone === c.phone);
    const paid = own.filter((o) => o.status === "выдан" || o.handedOverAt).length;
    const open = own.length - paid;
    const who = `«${state.name || c.phone}»`;
    const msg = [
      `Удалить клиента ${who} вместе с его велосипедами?`,
      open ? `Незакрытые обращения (${open}) тоже удалятся.` : "",
      paid ? `Выданные (${paid}) останутся в истории работ — по ним посчитан заработок мастеров.` : "",
    ].filter(Boolean).join(" ");
    if (!confirm(msg)) return;
    const ok = await deleteClientApi(c.phone, { withOrders: true });
    if (!ok) return alert("Не удалось удалить — нет соединения");
    toast("Клиент удалён");
    sheet.close();
    onChange(null);
  };

  sheet = openSheet(c.name || "Клиент", el("div", {},
    el("label", {}, "Имя"), nameInput,
    el("label", { style: "margin-top:10px" }, "Телефон"), phoneInput,
    el("h2", { style: "margin-top:16px" }, "Велосипеды"),
    bikesBox,
    errorEl,
    el("div", { class: "btn-row", style: "margin-top:16px" },
      el("button", { class: "btn-primary", onclick: save }, "Сохранить")),
    el("button", { class: "btn-warn", style: "width:100%;margin-top:10px", onclick: deleteClient }, "Удалить клиента")));
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
  return [bar("Запчасти", "/admin"), el("main", { class: "wrap" }, skeletonRows())];
}

async function saveStockItems(items) {
  const r = await fetch("/api/stock", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert(j.error || "ошибка"); return; }
  clearStockCache(); // список мог измениться — сбросить кэш для выбора деталей в ремонте
  render(stockScreen(j, ""));
}

// Группы остатков — те же узлы, что и в диагностике (WHL/BRK/...), плюс
// мойка; по ним потом фильтруется подбор запчасти к конкретной работе.
const STOCK_GROUPS = [...diagBlocks.map((b) => ({ id: b.id, title: b.title })), { id: "WSH", title: "Мойка и консервация" }];
// Простая эвристика «мало» — не настраивается по позиции (это не то же самое,
// что maxQty — тот вообще про другое, разовый потолок при списании, а не
// порог для дозаказа). Не идеально точно, зато сразу видно проблемные позиции
// без необходимости знать заранее, что именно искать.
const LOW_STOCK_THRESHOLD = 3;
const stockLevel = (qty) => (qty <= 0 ? "zero" : qty <= LOW_STOCK_THRESHOLD ? "low" : "ok");

function stockScreen(data, error) {
  const items = (data.items || []).map((it) => ({ ...it }));
  const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleString("ru-RU") : null;
  const sourceLabel = data.source === "1c" ? " · из 1С" : data.source === "manual" ? " · вручную" : "";
  let q = "";
  let groupFilter = ""; // "" — все узлы
  let onlyProblem = false; // только «нет»/«мало»
  let newItemIndex = -1;

  const zeroCount = items.filter((it) => stockLevel(it.qty) === "zero").length;
  const lowCount = items.filter((it) => stockLevel(it.qty) === "low").length;

  // Остатков может быть тысячи (реальная выгрузка из 1С) — рендерить сразу
  // все строки-с-полями браузер не потянет. Раньше единственным способом
  // сузить список был точный поиск по названию/артикулу — теперь то же самое
  // можно сделать без набора текста: выбрать узел чипом или включить
  // «Только проблемные», список сам по себе достаточно небольшой.
  const searchInput = el("input", { type: "text", placeholder: "Поиск по названию или артикулу" });
  const clearBtn = el("button", {
    type: "button", class: "search-clear", html: ICON_CLOSE, style: "display:none",
    onclick: () => { searchInput.value = ""; q = ""; newItemIndex = -1; clearBtn.style.display = "none"; drawRows(); searchInput.focus(); },
  });

  const chipStyle = (active) => `padding:7px 13px;border-radius:999px;border:.5px solid ${active ? "var(--accent)" : "var(--line)"};` +
    `background:${active ? "var(--accent)" : "var(--card)"};color:${active ? "var(--accent-ink)" : "var(--ink)"};` +
    "font-size:13px;white-space:nowrap;cursor:pointer;flex:0 0 auto";
  const chipsBox = el("div", { style: "display:flex;gap:6px;overflow-x:auto;padding:2px 0 4px;margin-top:10px" });
  const drawChips = () => {
    const groupCounts = new Map();
    for (const it of items) groupCounts.set(it.group || "", (groupCounts.get(it.group || "") || 0) + 1);
    // chipsBox — обычный DOM-узел, а не обёртка el(): его родной replaceChildren
    // не разворачивает вложенные массивы сам (в отличие от el()), поэтому
    // собираем плоский список и раскрываем его спредом при вызове.
    const chips = [
      el("div", {
        style: chipStyle(!onlyProblem && !groupFilter), onclick: () => { newItemIndex = -1; onlyProblem = false; groupFilter = ""; drawChips(); drawRows(); },
      }, `Все · ${items.length}`),
      (zeroCount + lowCount) > 0 ? el("div", {
        style: chipStyle(onlyProblem), onclick: () => { newItemIndex = -1; onlyProblem = !onlyProblem; drawChips(); drawRows(); },
      }, `⚠ Проблемные · ${zeroCount + lowCount}`) : null,
      ...STOCK_GROUPS.filter((g) => groupCounts.get(g.id)).map((g) => el("div", {
        style: chipStyle(groupFilter === g.id), onclick: () => { newItemIndex = -1; groupFilter = groupFilter === g.id ? "" : g.id; drawChips(); drawRows(); },
      }, `${g.title} · ${groupCounts.get(g.id)}`)),
    ].filter(Boolean);
    chipsBox.replaceChildren(...chips);
  };
  drawChips();

  const qtyStyle = (qty) => {
    const lvl = stockLevel(qty);
    if (lvl === "zero") return "text-align:right;border-color:var(--warn);background:var(--warn-weak);color:var(--warn)";
    if (lvl === "low") return "text-align:right;border-color:var(--orange);background:var(--orange-weak);color:var(--orange)";
    return "text-align:right";
  };
  // Мелкая подпись над полем — в один ряд на узком экране 6-7 полей не
  // умещались, подписи-плейсхолдеры пропадали после ввода и значение
  // переставало быть понятно, что это вообще такое.
  const labeled = (label, node, flexStyle) => el("div", { style: flexStyle || "flex:1;min-width:70px" },
    el("div", { class: "small muted", style: "margin-bottom:3px" }, label), node);

  const rowsBox = el("div", { class: "list" });
  const RESULTS_CAP = 150;
  const drawRows = () => {
    const ql = q.trim().toLowerCase();
    const active = !!(ql || groupFilter || onlyProblem || newItemIndex >= 0 || items.length <= 30);
    if (!active) {
      rowsBox.replaceChildren(el("p", { class: "muted small" },
        `Всего позиций: ${items.length}` + (zeroCount ? ` · нет в наличии: ${zeroCount}` : "") + (lowCount ? ` · мало: ${lowCount}` : "") +
        ". Наберите поиск, выберите узел или «Проблемные» выше, чтобы увидеть и отредактировать позиции."));
      return;
    }
    let matchedIdx = items.map((it, i) => ({ it, i }));
    if (newItemIndex >= 0) matchedIdx = matchedIdx.filter(({ i }) => i === newItemIndex);
    if (groupFilter) matchedIdx = matchedIdx.filter(({ it }) => (it.group || "") === groupFilter);
    if (onlyProblem) matchedIdx = matchedIdx.filter(({ it }) => stockLevel(it.qty) !== "ok");
    if (ql) matchedIdx = matchedIdx.filter(({ it }) => matchesQuery(ql, it.name, it.sku));
    // Проблемные — худшее сверху (нулевые раньше «мало»); иначе просто по алфавиту.
    matchedIdx.sort(onlyProblem ? (a, b) => (a.it.qty || 0) - (b.it.qty || 0) : (a, b) => a.it.name.localeCompare(b.it.name, "ru"));
    const total = matchedIdx.length;
    matchedIdx = matchedIdx.slice(0, RESULTS_CAP);
    if (!matchedIdx.length) { rowsBox.replaceChildren(emptyState("Ничего не найдено.", EMPTY_ICON_SEARCH)); return; }
    rowsBox.replaceChildren(...matchedIdx.map(({ it, i }) => el("div", { class: "admin-stock-card" },
      // Название — во всю ширину, крупнее и не обрезается: раньше зажатое
      // в общей строке с ещё 6 полями, оно резалось многоточием, а вместе
      // со спиннерами у числовых полей строка вообще переставала читаться.
      el("div", { style: "display:flex;gap:8px;align-items:flex-start" },
        el("input", { value: it.name, style: "flex:1;min-width:0;font-weight:600", placeholder: "название", onchange: (ev) => { items[i].name = ev.target.value; } }),
        el("button", { style: iconBtnStyle, onclick: () => { items.splice(i, 1); newItemIndex = -1; drawChips(); drawRows(); } }, "✕")),
      el("div", { style: "display:flex;gap:8px;margin-top:8px;flex-wrap:wrap" },
        labeled("Артикул", el("input", { value: it.sku, placeholder: "—", onchange: (ev) => { items[i].sku = ev.target.value; } }), "flex:1;min-width:90px"),
        labeled("Узел", el("select", { onchange: (ev) => { items[i].group = ev.target.value; } },
          el("option", { value: "", selected: !it.group }, "без узла"),
          STOCK_GROUPS.map((g) => el("option", { value: g.id, selected: it.group === g.id }, g.title))), "flex:1;min-width:110px")),
      el("div", { style: "display:flex;gap:8px;margin-top:8px;flex-wrap:wrap" },
        // Красим строго то самое поле напрямую, а не через полный drawRows():
        // замена всего списка изнутри onchange/blur этого же инпута иногда
        // сталкивается с обработкой blur самим браузером (DOMException
        // «node to be removed is no longer a child»).
        labeled(`Остаток, ${it.unit || "штук"}`, el("input", {
          type: "number", value: it.qty, style: qtyStyle(it.qty),
          onchange: (ev) => { items[i].qty = +ev.target.value || 0; ev.target.setAttribute("style", qtyStyle(items[i].qty)); },
        }), "flex:1;min-width:90px"),
        labeled("Цена, ₽", el("input", { type: "number", value: it.price || 0, style: "text-align:right", onchange: (ev) => { items[i].price = +ev.target.value || 0; } }), "flex:1;min-width:80px"),
        labeled("Макс. за раз", el("input", {
          type: "number", value: it.maxQty || "", placeholder: "—", style: "text-align:right",
          title: "Потолок количества за раз (спицы — 64, цепь — 1 и т.п.), необязательно", onchange: (ev) => { items[i].maxQty = +ev.target.value || 0; },
        }), "flex:1;min-width:80px")))),
      total > matchedIdx.length ? el("p", { class: "small muted", style: "margin-top:6px" }, `Показаны первые ${matchedIdx.length} из ${total} — уточните поиск.`) : null);
  };
  drawRows();
  searchInput.addEventListener("input", (e) => { q = e.target.value; newItemIndex = -1; clearBtn.style.display = q ? "" : "none"; drawRows(); });

  const importArea = el("textarea", { rows: 4 });
  return [
    bar("Запчасти", "/admin"),
    el("main", { class: "wrap" },
      error ? el("p", { class: "small", style: "color:var(--warn)" }, error) : null,
      updated ? el("p", { class: "small muted" }, "Обновлено: " + updated + sourceLabel) : null,
      el("div", { class: "admin-search" },
        el("div", { class: "search-wrap" }, searchInput, clearBtn),
        chipsBox),
      el("div", { class: "admin-stock-list" }, rowsBox),
      el("div", { class: "admin-stock-actions" },
        el("button", { style: "margin-top:10px", onclick: () => {
          items.push({ sku: "", name: "", qty: 0, unit: "", price: 0, group: groupFilter, maxQty: 0 });
          newItemIndex = items.length - 1;
          q = ""; searchInput.value = ""; clearBtn.style.display = "none";
          onlyProblem = false; groupFilter = "";
          drawChips(); drawRows(); rowsBox.querySelector("input")?.focus();
        } }, "+ запчасть"),
        el("div", { class: "btn-row", style: "margin-top:12px" },
          el("button", { class: "btn-primary", onclick: () => saveStockItems(items) }, "Сохранить"))),
      el("div", { class: "card" },
        el("h2", {}, "Импорт списком"),
        el("p", { class: "small muted" }, "Пока без прямой связи с 1С — вставьте выгрузку сюда, каждая позиция с новой строки: артикул;название;остаток;единица;цена;узел;макс (узел — WHL/BRK/BB/STR/FRM/DRV/TCH/WSH, макс — потолок количества за раз, оба поля можно оставить пустыми). Полностью заменит список выше."),
        importArea,
        el("div", { class: "btn-row", style: "margin-top:10px" },
          el("button", {
            onclick: () => {
              const parsed = importArea.value.split("\n").map((line) => line.split(";").map((s) => s.trim()))
                .filter((p) => p[0] || p[1])
                .map(([sku, name, qty, unit, price, group, maxQty]) => ({ sku: sku || "", name: name || "", qty: Number(qty) || 0, unit: unit || "", price: Number(price) || 0, group: group || "", maxQty: Number(maxQty) || 0 }));
              if (parsed.length) saveStockItems(parsed);
            },
          }, "Импортировать (заменит список)")))),
  ];
}

// ---------------------------- синхронизация с 1С -----------------------------

async function load1cSync() {
  try {
    const r = await fetch("/api/1c-sync", { cache: "no-store" });
    const j = await r.json();
    if (location.hash !== "#/admin/1c") return;
    render(sync1cScreen(r.ok ? j.orders : [], r.ok ? "" : j.error || "ошибка"));
  } catch {
    if (location.hash === "#/admin/1c") render(sync1cScreen([], "нет соединения"));
  }
}
function view1cSync() {
  load1cSync();
  return [bar("Синхронизация с 1С", "/admin"), el("main", { class: "wrap" }, skeletonRows())];
}

async function markAll1cExported() {
  const r = await fetch("/api/1c-sync", { method: "POST" });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { alert(j.error || "ошибка"); return; }
  toast(j.marked ? `Помечено выгруженными: ${j.marked}` : "Список уже был пуст");
  load1cSync();
}

function sync1cScreen(orders, error) {
  const total = orders.reduce((s, o) => s + o.laborSum, 0);
  const orderRow = (o) => el("div", { class: "row", style: "justify-content:space-between" },
    el("span", {},
      el("b", {}, o.number), " · ", new Date(o.handedOverAt).toLocaleDateString("ru-RU"),
      o.clientName ? " · " + o.clientName : ""),
    el("span", { class: "muted" }, money(o.laborSum)));
  const confirmMsg = (n) => `Пометить все ${n} обращений как уже выгруженные в 1С? Это стоит делать, ` +
    "только если они уже занесены в 1С другим способом — иначе автоматическая выгрузка их больше не увидит.";
  const content = !orders.length
    ? emptyState("Нечего выгружать — все выданные обращения уже помечены.", EMPTY_ICON_BOX)
    : el("div", { class: "card" },
        el("p", {}, el("b", {}, orders.length), " обращений на сумму ", el("b", {}, money(total))),
        el("div", { class: "list", style: "margin-top:10px" }, orders.map(orderRow)),
        el("button", {
          class: "btn-primary", style: "width:100%;margin-top:14px",
          onclick: () => { if (confirm(confirmMsg(orders.length))) markAll1cExported(); },
        }, "Пометить все как уже выгруженные"));
  return [
    bar("Синхронизация с 1С", "/admin"),
    el("main", { class: "wrap" },
      error ? el("p", { class: "small", style: "color:var(--warn)" }, error) : null,
      el("p", { class: "small muted" },
        "Здесь — обращения, выданные клиенту, но ещё не помеченные выгруженными в 1С " +
        "(отдаются автоматике на той же ручке /api/1c-export по секретному ключу)."),
      content),
  ];
}
