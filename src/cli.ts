// Консоль веломастерской Vella — прототип.
// Запуск: npm run cli
//
// На этом этапе: прогон техпроцедур (валидация алгоритмов) + проверка каталога.
// Рабочий процесс приёмки (9 этапов из docs/console-app.md) — следующим шагом.

import * as readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import type { RunMode } from "./model.ts";
import { loadCatalog } from "./catalog.ts";
import { validate, coverageReport } from "./validate.ts";
import { runProcedure, type RunnerIO } from "./runner.ts";
import { runWorkflow } from "./workflow.ts";
import type { Term } from "./term.ts";

// Собственный буферизующий читатель строк: rl.question по-разному ведёт себя
// на интерактивном терминале и на пайпе (события 'line' приходят пачкой).
const rl = readline.createInterface({ input, output, terminal: false });
class QuitSignal extends Error {}
const lineQueue: string[] = [];
const waiters: { res: (s: string) => void; rej: (e: unknown) => void }[] = [];
let closed = false;
rl.on("line", (l) => {
  const w = waiters.shift();
  if (w) w.res(l);
  else lineQueue.push(l);
});
rl.on("close", () => {
  closed = true;
  while (waiters.length) waiters.shift()!.rej(new QuitSignal());
});
function nextLine(): Promise<string> {
  if (lineQueue.length) return Promise.resolve(lineQueue.shift()!);
  if (closed) return Promise.reject(new QuitSignal());
  return new Promise((res, rej) => waiters.push({ res, rej }));
}
async function ask(q: string): Promise<string> {
  output.write(q);
  return nextLine();
}

const line = "─".repeat(52);
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

async function pick(prompt: string, options: string[]): Promise<string> {
  console.log(prompt);
  options.forEach((o, i) => console.log(`  ${i + 1}) ${o}`));
  while (true) {
    const a = (await ask("> ")).trim().toLowerCase();
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1]!;
    const exact = options.find((o) => o.toLowerCase() === a);
    if (exact) return exact;
    if (a) {
      const pref = options.filter((o) => o.toLowerCase().startsWith(a));
      if (pref.length === 1) return pref[0]!;
    }
    console.log(dim("  введите номер или вариант"));
  }
}

async function yesNo(prompt: string): Promise<boolean> {
  while (true) {
    const a = (await ask(`${prompt} [д/н] `)).trim().toLowerCase();
    if (["", "д", "да", "y", "yes", "+"].includes(a)) return true;
    if (["н", "нет", "n", "no", "-"].includes(a)) return false;
    console.log(dim("  введите «д» или «н»"));
  }
}

function welcome() {
  console.log("");
  console.log(line);
  console.log(`  ${bold("ВЕЛОМАСТЕРСКАЯ VELLA")} · рабочий процесс`);
  console.log(`  прототип · v0.1`);
  console.log(line);
  console.log("");
  console.log(dim("  Приёмка, наряд и ремонт по технологическим картам."));
  console.log("");
}

const MODE_LABEL: Record<RunMode, string> = {
  master: "Мастер (только главы и проверки)",
  standard: "Стандарт (главы и шаги)",
  training: "Обучение (всё, с пояснениями)",
};

const term: Term = {
  print: (s = "") => console.log(s),
  ask,
  pick,
  yesNo,
};

function makeIO(_mode?: RunMode): RunnerIO {
  return {
    async chapter(ch, path) {
      const prefix = path.length ? dim(path.join(" › ") + " › ") : "";
      console.log("");
      console.log(`${prefix}${bold(`■ ${ch.id}. ${ch.title}`)}`);
    },
    async step(node, showNotes) {
      const indent = node.level === 2 ? "     · " : "   ";
      console.log(`${indent}${node.text}`);
      if (showNotes) {
        for (const n of node.notes) console.log(dim(`       ↳ ${n}`));
      }
      await ask(dim("   [enter — дальше] "));
    },
    async check(text, onFail, _group) {
      console.log(`   ${bold("ПРОВЕРКА:")} ${text}`);
      const ok = await yesNo(text.trimEnd().endsWith("?") ? "  " : "   выполнено?");
      if (!ok && onFail) console.log(`   ${dim("→ " + onFail)}`);
      return ok;
    },
    async branch(question, options) {
      return pick(`   ${question}`, options);
    },
    async loopAgain(condition) {
      return yesNo(`   ${condition}`);
    },
    async foreachNext(varName, collection, first) {
      return yesNo(`   ${first ? "начать обход" : "ещё раз"}: ${varName} (${collection})?`);
    },
    async foreachItem(varName, item, index, total) {
      console.log(`   ${bold(`▸ ${item} ${varName}`)}  ${dim(`(${index}/${total})`)}`);
    },
    async approve(text) {
      console.log(`   ${bold("СОГЛАСОВАТЬ С КЛИЕНТОМ:")} ${text}`);
      await ask(dim("   [enter — согласовано / зафиксировано] "));
    },
    async stop(reason) {
      console.log(`   ${bold("СТОП:")} ${reason}`);
    },
    async enterCall(target, note, depth) {
      console.log("");
      console.log(dim(`   ↘ ВЫЗОВ [${target.code}] ${target.name}${note ? " — " + note : ""}`));
    },
    async exitCall(target, depth) {
      console.log(dim(`   ↖ возврат из [${target.code}]`));
      console.log("");
    },
    async missingCall(code) {
      console.log(`   ${bold("!")} ВЫЗОВ [${code}] — процедура ещё не написана, пропуск`);
    },
    async skipRecursion(code) {
      console.log(dim(`   (повторный вызов [${code}] — пропуск)`));
    },
  };
}

async function runOne() {
  const cat = loadCatalog();
  const codes = cat.procedures
    .filter((p) => p.code)
    .map((p) => `${p.code}  ${p.name}`);
  const choice = await pick("\nКакую процедуру прогнать?", [...codes, "← назад"]);
  if (choice === "← назад") return;
  const code = choice.split(/\s+/)[0]!;
  const proc = cat.byCode.get(code)!;

  const mode = (await pick(
    "\nРежим детализации:",
    [MODE_LABEL.master, MODE_LABEL.standard, MODE_LABEL.training],
  )) as string;
  const runMode: RunMode =
    mode === MODE_LABEL.master ? "master" : mode === MODE_LABEL.training ? "training" : "standard";

  console.log("");
  console.log(line);
  console.log(`  ${bold(proc.code + " · " + proc.name)}`);
  if (proc.entry) console.log(dim(`  Вход: ${proc.entry}`));
  if (proc.tools) console.log(dim(`  Инструмент: ${proc.tools}`));
  if (proc.consumables) console.log(dim(`  Расходники: ${proc.consumables}`));
  console.log(line);

  await runProcedure(cat, proc, makeIO(runMode), { mode: runMode });

  if (proc.quality.length) {
    console.log("");
    console.log(bold("  ПРОВЕРКА КАЧЕСТВА:"));
    for (const q of proc.quality) console.log(`   • ${q}`);
  }
  if (proc.record.length) {
    console.log("");
    console.log(bold("  ФИКСИРОВАТЬ В НАРЯДЕ:"));
    for (const r of proc.record) console.log(`   • ${r}`);
  }
  if (proc.sources.length) {
    console.log("");
    console.log(dim("  Источники:"));
    for (const s of proc.sources) console.log(dim(`   ${s.title}${s.url ? " — " + s.url : ""}`));
  }
  console.log("");
  await ask(dim("[enter — в меню] "));
}

async function showValidation() {
  const cat = loadCatalog();
  console.log("");
  console.log(coverageReport(cat).join("\n"));
  const issues = validate(cat);
  console.log("");
  if (issues.length === 0) console.log("  Проблем не найдено.");
  for (const i of issues) {
    const tag = i.severity === "error" ? "ОШИБКА" : "предупр";
    console.log(`  [${tag}] ${i.proc}: ${i.message}`);
  }
  console.log("");
  await ask(dim("[enter — в меню] "));
}

async function main() {
  welcome();
  const cat = loadCatalog();
  while (true) {
    const choice = await pick("\nЧто делаем?", [
      "Начать работу (обращение)",
      "Прогнать процедуру",
      "Проверить каталог",
      "Выход",
    ]);
    if (choice === "Выход") break;
    if (choice === "Начать работу (обращение)") await runWorkflow(cat, term, makeIO);
    else if (choice === "Прогнать процедуру") await runOne();
    else await showValidation();
  }
  rl.close();
}

main()
  .then(() => rl.close())
  .catch((e) => {
    if (e instanceof QuitSignal) {
      console.log("\n(ввод завершён)");
      process.exit(0);
    }
    console.error(e);
    process.exit(1);
  });
