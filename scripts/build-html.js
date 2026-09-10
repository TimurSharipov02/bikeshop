// Собирает vella.html (и public/index.html для Vercel) из исходников.
// Обычный Node, без зависимостей и без TypeScript.  Запуск:  npm run build

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseProc } from "../web/parse.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const p = (rel) => root + rel;

// 1. Разобрать все процедуры
const procDir = p("catalog");
const procFiles = readdirSync(procDir).filter((f) => f.endsWith(".proc")).sort();
const procedures = procFiles.flatMap((f) => parseProc(readFileSync(procDir + "/" + f, "utf8"), f));

// 2. Неисправности и цены
const faults = JSON.parse(readFileSync(p("catalog/faults.json"), "utf8"));
const priceFile = JSON.parse(readFileSync(p("catalog/prices.json"), "utf8"));

const catalog = {
  generatedAt: new Date().toISOString(),
  procedures,
  faultGroups: faults.groups || [],
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

writeFileSync(p("vella.html"), html, "utf8");
mkdirSync(p("public"), { recursive: true });
writeFileSync(p("public/index.html"), html, "utf8");

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`✔ ${procedures.length} процедур · vella.html + public/index.html — ${kb} КБ`);
