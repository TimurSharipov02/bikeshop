// Головной прогон: раннер проходит каждую процедуру по всем комбинациям
// параметров, в двух режимах ответов («всё да» и «всё нет»), ловит исключения
// и зависания. Это автоматический эквивалент ручного прогона каждой процедуры.
//
// Запуск: node src/dryrun.ts

import type { Catalog, Chapter, Param, Procedure, StepNode } from "./model.ts";
import { loadCatalog } from "./catalog.ts";
import { runProcedure, type RunnerIO } from "./runner.ts";

function* combos(params: Param[]): Generator<Record<string, string>> {
  if (params.length === 0) {
    yield {};
    return;
  }
  const [head, ...tail] = params;
  for (const opt of head!.options) {
    for (const rest of combos(tail)) {
      yield { [head!.name]: opt, ...rest };
    }
  }
}

interface Trace {
  chapters: number;
  steps: number;
  checks: number;
  calls: string[];
  approvals: number;
  stops: number;
  missing: string[];
}

function makeAutoIO(answer: "да" | "нет", trace: Trace): RunnerIO {
  const yes = answer === "да";
  return {
    chapter(_ch: Chapter) {
      trace.chapters++;
    },
    step(_n: StepNode) {
      trace.steps++;
    },
    async check(_t: string, _f: string | undefined, _g: string | undefined) {
      trace.checks++;
      return true;
    },
    async branch(_q: string, options: string[]) {
      // да/нет -> по режиму; произвольный выбор -> первый вариант
      if (options.length === 2 && options[0] === "да") return yes ? "да" : "нет";
      return options[0]!;
    },
    async loopAgain() {
      return false; // тело цикла 0 раз — прогон структуры достаточно
    },
    async foreachNext(_v: string, _c: string, first: boolean) {
      return first; // один проход тела
    },
    foreachItem() {},
    approve() {
      trace.approvals++;
    },
    stop() {
      trace.stops++;
    },
    enterCall(target: Procedure) {
      trace.calls.push(target.code ?? target.name);
    },
    exitCall() {},
    missingCall(code: string) {
      trace.missing.push(code);
    },
    skipRecursion() {},
  };
}

async function runWithTimeout(fn: () => Promise<void>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`таймаут ${ms} мс — возможно зацикливание`)), ms);
  });
  try {
    await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

interface Problem {
  proc: string;
  combo: string;
  answer: string;
  error: string;
}

export async function dryRun(cat: Catalog): Promise<{ problems: Problem[]; runs: number }> {
  const problems: Problem[] = [];
  let runs = 0;

  for (const p of cat.procedures) {
    for (const combo of combos(p.params)) {
      for (const answer of ["да", "нет"] as const) {
        runs++;
        const trace: Trace = {
          chapters: 0, steps: 0, checks: 0, calls: [], approvals: 0, stops: 0, missing: [],
        };
        const comboStr = Object.entries(combo).map(([k, v]) => `${k}=${v}`).join(", ") || "—";
        try {
          await runWithTimeout(
            () =>
              runProcedure(cat, p, makeAutoIO(answer, trace), {
                mode: "training",
                params: combo,
              }),
            2000,
          );
        } catch (e) {
          problems.push({
            proc: p.code ?? p.name,
            combo: comboStr,
            answer,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  }
  return { problems, runs };
}

async function main() {
  const cat = loadCatalog();
  const { problems, runs } = await dryRun(cat);
  console.log(`Прогонов: ${runs} (${cat.procedures.length} процедур × комбинации параметров × 2 режима ответов)\n`);
  if (problems.length === 0) {
    console.log("  Все прогоны завершились без ошибок и зависаний.");
  } else {
    for (const pr of problems) {
      console.log(`  [${pr.proc}] параметры: ${pr.combo}, ответы: ${pr.answer}`);
      console.log(`     ${pr.error}`);
    }
  }
  console.log(`\nИтого проблем: ${problems.length}`);
  process.exit(problems.length > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
