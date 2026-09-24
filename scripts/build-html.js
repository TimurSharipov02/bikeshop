// Собирает veloterra.html (и public/index.html для Vercel) из исходников.
// Обычный Node, без зависимостей и без TypeScript.  Запуск:  npm run build

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const p = (rel) => root + rel;

// Узлы велосипеда (Колёса, Тормоз, Каретка…) — структура каталога работ,
// которые заводит администратор вручную через приложение (catalog/repairs).
// Старый встроенный каталог процедур (catalog/*.proc, faults.json) удалён —
// отсюда берётся только сам список узлов для группировки.
const diagnostics = JSON.parse(readFileSync(p("catalog/diagnostics.json"), "utf8"));
const diagnosticBlocks = (diagnostics.blocks || []).map((b) => ({
  id: b.id,
  title: b.title,
  perSide: !!b.perSide,
  prompt: b.prompt || "",
  // Префиксы старых кодов операций (WHL-05 и т.п.) — нужны только чтобы у
  // позиций наряда, заведённых до появления поля group на самом пункте
  // (см. partBlockIdOf в app.js), всё равно определялся правильный узел для
  // группировки, а не «Прочее».
  codes: b.codes || [],
}));

const catalog = {
  generatedAt: new Date().toISOString(),
  diagnosticBlocks,
};

// Склеить бандл: pricing.js + report-entries.js + order-calc.js + search.js + dom.js +
// store.js + app.js (без import/export между ними — всё сложено в общую
// область видимости).
const strip = (src) =>
  src
    .replace(/^export\s+/gm, "")
    .replace(/^\s*import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?\s*$/gm, "");

const bundle = [
  strip(readFileSync(p("web/pricing.js"), "utf8")),
  strip(readFileSync(p("web/report-entries.js"), "utf8")),
  strip(readFileSync(p("web/order-calc.js"), "utf8")),
  strip(readFileSync(p("web/search.js"), "utf8")),
  strip(readFileSync(p("web/undo.js"), "utf8")),
  strip(readFileSync(p("web/dom.js"), "utf8")),
  strip(readFileSync(p("web/store.js"), "utf8")),
  strip(readFileSync(p("web/app.js"), "utf8")),
].join("\n\n");

// Стили оформления (web/themes.css) — после основных: перекрывают их.
const css = readFileSync(p("web/app.css"), "utf8") + "\n" + readFileSync(p("web/themes.css"), "utf8");

const html = readFileSync(p("web/template.html"), "utf8")
  .replace("/*__CSS__*/", () => css)
  .replace("/*__CATALOG__*/", () => JSON.stringify(catalog))
  .replace("/*__BUNDLE__*/", () => bundle);

writeFileSync(p("veloterra.html"), html, "utf8");
mkdirSync(p("public"), { recursive: true });
writeFileSync(p("public/index.html"), html, "utf8");
// public/ пересобирается каждый раз и не хранится в git — статику (иконка
// сайта, манифест для «Добавить на экран Домой») копируем сюда же из
// web/assets при каждой сборке, а не держим отдельно в public/.
copyFileSync(p("web/assets/favicon.jpg"), p("public/favicon.jpg"));
copyFileSync(p("web/assets/manifest.json"), p("public/manifest.json"));
// Шрифт (Ubuntu, лицензия UFL) — отдельными файлами рядом со страницей,
// а не внутри HTML: браузер кеширует их и качает только нужные наборы
// символов (латиница/кириллица) и начертания.
mkdirSync(p("public/fonts"), { recursive: true });
for (const f of readdirSync(p("web/assets/fonts"))) copyFileSync(p(`web/assets/fonts/${f}`), p(`public/fonts/${f}`));

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`✔ ${diagnosticBlocks.length} узлов · veloterra.html + public/index.html — ${kb} КБ`);
