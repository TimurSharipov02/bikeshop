// Мелкие переиспользуемые строительные блоки интерфейса: узел DOM, заголовок
// экрана, тост-подтверждение, модальная панель снизу экрана (bottom sheet) и
// форматирование денег. Никакой бизнес-логики — только представление.

export const app = document.getElementById("app");
export const money = (n) => `${Number(n || 0).toLocaleString("ru-RU")} ₽`;
// min-width/height 44px — минимальная зона тапа по HIG/WCAG, даже когда сама
// иконка визуально мельче: без этого ✕/+/− ловятся неточно, особенно на ходу.
export const iconBtnStyle = "border:0;background:none;color:var(--muted);cursor:pointer;padding:0;min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;font:inherit";

// Тост — короткое подтверждение действия (добавил/убрал/сохранил), которое
// не привязано к дереву app и переживает полную перерисовку экрана: сама app
// вычищается на каждый render(), а тост живёт своим элементом на body.
let toastTimer = null;
export function toast(text) {
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
const openSheetClosers = new Set();
export function closeAllSheets() {
  for (const close of [...openSheetClosers]) close(true);
}
export function openSheet(title, bodyNode) {
  // iOS оставляет системную панель перехода между полями (стрелки и
  // галочка), если открыть шторку, пока textarea/input позади неё в фокусе.
  // Снимаем фокус до показа и ещё раз перед закрытием самой шторки.
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const backdrop = el("div", { class: "sheet-backdrop", onclick: () => close() });
  const sheet = el("div", { class: "sheet" },
    el("div", { class: "sheet-handle" }),
    el("div", { class: "sheet-header" }, el("h2", {}, title),
      el("button", { style: iconBtnStyle, onclick: () => close() }, "✕")),
    el("div", { class: "sheet-body" }, bodyNode));
  let closed = false;
  function close(immediate = false) {
    if (closed) return;
    closed = true;
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    openSheetClosers.delete(close);
    backdrop.classList.remove("show");
    sheet.classList.remove("show");
    if (immediate) { backdrop.remove(); sheet.remove(); }
    else setTimeout(() => { backdrop.remove(); sheet.remove(); }, 220);
  }
  openSheetClosers.add(close);
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
export function el(tag, attrs, ...kids) {
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
export const bar = (title, backHash, rightNode) =>
  el("header", { class: "bar" },
    backHash != null ? el("a", { class: "back", href: "#" + backHash }, "‹") : null,
    el("h1", {}, title),
    rightNode || null);
