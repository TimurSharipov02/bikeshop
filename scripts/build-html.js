// Собирает veloterra.html (и public/index.html для Vercel) из исходников.
// Обычный Node, без зависимостей и без TypeScript.  Запуск:  npm run build

import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProc } from "../web/parse.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const p = (rel) => root + rel;

// 1. Разобрать все процедуры
const procDir = p("catalog");
const procFiles = readdirSync(procDir).filter((f) => f.endsWith(".proc")).sort();
const procedures = procFiles.flatMap((f) => parseProc(readFileSync(procDir + "/" + f, "utf8"), f));

// 2. Неисправности, блоки диагностики, учебный слой, цены
const faults = JSON.parse(readFileSync(p("catalog/faults.json"), "utf8"));
const diagnostics = JSON.parse(readFileSync(p("catalog/diagnostics.json"), "utf8"));
const training = JSON.parse(readFileSync(p("catalog/training.json"), "utf8"));
const priceFile = JSON.parse(readFileSync(p("catalog/prices.json"), "utf8"));

// Блок диагностики = один экран осмотра; неисправности берём из групп faults.json.
const faultGroupById = new Map((faults.groups || []).map((g) => [g.id, g]));
const diagnosticBlocks = (diagnostics.blocks || []).map((b) => ({
  id: b.id,
  title: b.title,
  perSide: !!b.perSide,
  showIf: b.showIf || null,
  codes: b.codes || [],
  prompt: b.prompt || "",
  sections: (b.groups || []).map((gid) => {
    const g = faultGroupById.get(gid);
    if (!g) throw new Error(`diagnostics.json: блок ${b.id} → нет группы неисправностей «${gid}» в faults.json`);
    return { id: g.id, title: g.title, faults: g.faults };
  }),
}));

const catalog = {
  generatedAt: new Date().toISOString(),
  procedures,
  diagnosticBlocks,
  training: training.items || {},
  currency: priceFile.currency || "RUB",
  prices: priceFile.operations || {},
};

// 3. Склеить бандл: runner.js + parse.js + app.js (без import/export между ними)
const strip = (src) =>
  src
    .replace(/^export\s+/gm, "")
    .replace(/^\s*import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?\s*$/gm, "");

// parse.js — только для сборки, в браузер не идёт
const bundle = [
  strip(readFileSync(p("web/runner.js"), "utf8")),
  strip(readFileSync(p("web/app.js"), "utf8")),
].join("\n\n");

const css = readFileSync(p("web/app.css"), "utf8");

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

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`✔ ${procedures.length} процедур · veloterra.html + public/index.html — ${kb} КБ`);
