// Аудит каталога: эвристики, которые ловят то, что всплыло бы при живом
// прогоне каждой процедуры. Запуск: node src/audit.ts

import {
  walkNodes,
  walkProcedureNodes,
  type Catalog,
  type Node,
  type Procedure,
} from "./model.ts";
import { loadCatalog } from "./catalog.ts";

interface Finding {
  level: "!" | "?" | "i";
  proc: string;
  msg: string;
}

const CODE_RE = /\b([A-ZА-Я]{2,4}-\d{1,2}[A-Za-z]?)\b/g;

function collectText(p: Procedure): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  for (const ch of p.chapters) {
    for (const n of walkNodes(ch.nodes)) {
      switch (n.kind) {
        case "step":
          out.push({ where: `${ch.id} STEP`, text: n.text });
          for (const note of n.notes) out.push({ where: `${ch.id} NOTE`, text: note });
          break;
        case "check":
          out.push({ where: `${ch.id} CHECK`, text: n.text });
          break;
        case "approve":
          out.push({ where: `${ch.id} APPROVE`, text: n.text });
          break;
        case "stop":
          out.push({ where: `${ch.id} STOP`, text: n.reason });
          break;
        case "if":
          for (const b of n.branches) if (b.when) out.push({ where: `${ch.id} IF`, text: b.when });
          break;
        case "while":
          out.push({ where: `${ch.id} WHILE`, text: n.condition });
          break;
        case "foreach":
          out.push({ where: `${ch.id} FOREACH`, text: n.collection });
          break;
      }
    }
  }
  return out;
}

function callTargets(p: Procedure): string[] {
  const out: string[] = [];
  for (const n of walkProcedureNodes(p)) if (n.kind === "call") out.push(n.code);
  return out;
}

function paramMentioned(p: Procedure, name: string): boolean {
  const key = name.split(/\s/)[0]!;
  for (const ch of p.chapters) {
    if (ch.showIf?.param === name) return true;
    if (ch.title.includes(key)) return true;
    for (const t of collectText(p)) if (t.text.includes(key)) return true;
  }
  return false;
}

// условие IF, которое раннер вычисляет сам из параметра (напр. «система Shimano Di2»)
function isAutoResolvable(p: Procedure, when: string): boolean {
  for (const param of p.params) {
    if (when === `${param.name}=${when.split("=")[1]}`) return true;
    if (when.startsWith(`${param.name} `)) {
      const claim = when.slice(param.name.length + 1).trim();
      if (param.options.includes(claim)) return true;
    }
  }
  return false;
}

function pathCount(nodes: Node[]): number {
  let mult = 1;
  for (const n of nodes) {
    if (n.kind === "if") {
      let branchSum = 0;
      for (const b of n.branches) branchSum += pathCount(b.nodes);
      // + путь, где ни одна ветка не выбрана (нет ELSE)
      const hasElse = n.branches.some((b) => b.when === "");
      mult *= branchSum + (hasElse ? 0 : 1);
    } else if (n.kind === "while" || n.kind === "foreach") {
      mult *= pathCount(n.nodes) + 1; // тело 0 или 1 раз
    }
  }
  return mult;
}

function maxCallDepth(cat: Catalog, code: string, seen: string[] = []): number {
  if (seen.includes(code)) return seen.length; // цикл — обрываем
  const p = cat.byCode.get(code);
  if (!p) return seen.length;
  let max = seen.length;
  for (const t of new Set(callTargets(p))) {
    max = Math.max(max, maxCallDepth(cat, t, [...seen, code]));
  }
  return max;
}

function hasCycle(cat: Catalog, code: string, seen: string[] = []): string[] | null {
  if (seen.includes(code)) return [...seen, code];
  const p = cat.byCode.get(code);
  if (!p) return null;
  for (const t of new Set(callTargets(p))) {
    const c = hasCycle(cat, t, [...seen, code]);
    if (c) return c;
  }
  return null;
}

export function audit(cat: Catalog): Finding[] {
  const f: Finding[] = [];
  const add = (level: Finding["level"], proc: string, msg: string) => f.push({ level, proc, msg });

  for (const p of cat.procedures) {
    const name = p.code ?? p.name;

    // нет критериев приёмки
    const checks = [...walkProcedureNodes(p)].filter((n) => n.kind === "check").length;
    if (p.status === "ready" && p.kind === "operation" && checks === 0 && p.quality.length === 0) {
      add("?", name, "нет ни CHECK, ни QUALITY — по чему принимать работу?");
    }

    // объявленный параметр не влияет на ход (и не только для записи)
    for (const param of p.params) {
      if (!paramMentioned(p, param.name)) {
        add("i", name, `параметр «${param.name}» объявлен, но не разветвляет ход (только для записи?)`);
      }
    }

    // текстовые эвристики
    for (const t of collectText(p)) {
      if (t.text.length > 210) add("?", name, `${t.where}: шаг длинный (${t.text.length} симв.) — разбить на под-шаги`);
      // ссылка на код операции в обычном шаге (не APPROVE — там отсылка намеренная)
      if (!t.where.endsWith("APPROVE")) {
        const codes = [...t.text.matchAll(CODE_RE)].map((m) => m[1]!);
        for (const c of codes) {
          if (cat.byCode.has(c) && !callTargets(p).includes(c) && !t.text.includes("отдельн") && !t.text.includes("см.")) {
            add("i", name, `${t.where}: упоминает [${c}] в тексте — не должен ли это быть ВЫЗОВ?`);
          }
        }
      }
    }

    // ветвление, которое стоило бы вынести в параметр (только если параметра ещё нет)
    for (const ch of p.chapters) {
      const ifConds = [...walkNodes(ch.nodes)].flatMap((n) =>
        n.kind === "if" ? n.branches.filter((b) => b.when).map((b) => b.when) : [],
      );
      for (const c of ifConds) {
        if (/^(система|тип|вилка|тормоз|объём|действие|контур)\s/i.test(c) && !isAutoResolvable(p, c)) {
          add("i", name, `${ch.id} IF «${c}» — похоже на параметр, но параметра нет`);
        }
      }
    }

    // взрыв путей
    let paths = 1;
    for (const ch of p.chapters) paths *= pathCount(ch.nodes) || 1;
    const paramCombos = p.params.reduce((a, pr) => a * Math.max(1, pr.options.length), 1);
    if (paths * paramCombos > 400) {
      add("i", name, `${paths}×${paramCombos} = ${paths * paramCombos} комбинаций путей — прогон вручную не покроет всё`);
    }

    // цикл вызовов
    if (p.code) {
      const cyc = hasCycle(cat, p.code);
      if (cyc && cyc[0] === p.code) {
        add("?", name, `цикл ВЫЗОВ: ${cyc.join(" → ")} (раннер обрывает рекурсию, но логически стоит проверить)`);
      }
      const depth = maxCallDepth(cat, p.code);
      if (depth >= 5) add("i", name, `глубина вложенных ВЫЗОВ до ${depth} — длинная цепочка`);
    }
  }

  return f;
}

function main() {
  const cat = loadCatalog();
  const findings = audit(cat);
  const byLevel = { "!": 0, "?": 0, i: 0 };
  const order = { "!": 0, "?": 1, i: 2 } as const;
  findings.sort((a, b) => order[a.level] - order[b.level] || a.proc.localeCompare(b.proc));
  for (const x of findings) {
    byLevel[x.level]++;
    console.log(`  ${x.level} ${x.proc.padEnd(16)} ${x.msg}`);
  }
  console.log(`\nИтого: ${byLevel["!"]} критичных, ${byLevel["?"]} к разбору, ${byLevel.i} инфо`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
