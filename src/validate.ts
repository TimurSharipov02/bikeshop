// Валидатор каталога процедур.
// Запуск: npm run validate

import {
  walkNodes,
  walkProcedureNodes,
  type Catalog,
  type Node,
  type Procedure,
} from "./model.ts";
import { loadCatalog } from "./catalog.ts";
import { loadFaults } from "./faults.ts";

export interface Issue {
  severity: "error" | "warn";
  proc: string;
  message: string;
}

export function validate(cat: Catalog): Issue[] {
  const issues: Issue[] = [];
  const add = (severity: Issue["severity"], proc: string, message: string) =>
    issues.push({ severity, proc, message });

  const label = (p: Procedure) => p.code ?? `(${p.name})`;

  // дубли кодов
  const seen = new Set<string>();
  for (const p of cat.procedures) {
    if (!p.code) continue;
    if (seen.has(p.code)) add("error", p.code, "дублирующийся код процедуры");
    seen.add(p.code);
  }

  for (const p of cat.procedures) {
    const name = label(p);

    if (p.chapters.length === 0 && p.status === "ready") {
      add("warn", name, "нет ни одной главы, но статус ready");
    }

    // пустые главы / ветки / циклы
    for (const ch of p.chapters) {
      if (ch.nodes.length === 0) {
        add("error", name, `глава "${ch.id} ${ch.title}" без шагов`);
      }
      if (ch.showIf) {
        const param = p.params.find((pp) => pp.name === ch.showIf!.param);
        if (!param) {
          add("error", name, `SHOWIF ссылается на несуществующий параметр "${ch.showIf.param}"`);
        } else if (!param.options.includes(ch.showIf.value)) {
          add("error", name, `SHOWIF значение "${ch.showIf.value}" не входит в параметр "${ch.showIf.param}"`);
        }
      }
    }

    for (const node of walkProcedureNodes(p)) {
      checkNode(node, p, cat, add, name);
    }

    // ветвление по параметру: покрыты ли все значения хотя бы упоминанием?
    // (мягкая проверка — только предупреждение)
  }

  // справочник неисправностей
  try {
    const faults = loadFaults();
    const groupIds = new Set(faults.groups.map((g) => g.id));
    for (const g of faults.groups) {
      for (const f of g.faults) {
        if (f.code && !cat.byCode.has(f.code)) {
          add("error", `faults/${g.id}`, `неисправность «${f.label}» ссылается на несуществующую операцию [${f.code}]`);
        }
      }
    }
    // CHECK [XXX] в каталоге — группа должна существовать
    for (const p of cat.procedures) {
      for (const node of walkProcedureNodes(p)) {
        if (node.kind === "check" && node.group && !groupIds.has(node.group)) {
          add("error", p.code ?? p.name, `CHECK [${node.group}] — нет такой группы неисправностей в faults.json`);
        }
      }
    }
  } catch (e) {
    add("warn", "faults.json", `не удалось загрузить: ${e instanceof Error ? e.message : e}`);
  }

  return issues;
}

function checkNode(
  node: Node,
  p: Procedure,
  cat: Catalog,
  add: (s: Issue["severity"], proc: string, m: string) => void,
  name: string,
): void {
  switch (node.kind) {
    case "call": {
      const target = cat.byCode.get(node.code);
      if (!target) {
        add("error", name, `ВЫЗОВ [${node.code}] — процедура не найдена`);
      } else if (target.status === "stub") {
        add("warn", name, `ВЫЗОВ [${node.code}] ведёт в заглушку`);
      }
      break;
    }
    case "if": {
      if (node.branches.length === 0) add("error", name, "IF без веток");
      for (const b of node.branches) {
        if (b.nodes.length === 0) {
          add("error", name, `ветка IF "${b.when || "ИНАЧЕ"}" без шагов`);
        }
      }
      break;
    }
    case "while":
      if (node.nodes.length === 0) add("error", name, `WHILE "${node.condition}" без шагов`);
      break;
    case "foreach":
      if (node.nodes.length === 0) add("error", name, `FOREACH "${node.collection}" без шагов`);
      break;
    case "step":
      if (node.text.trim() === "") add("error", name, "пустой STEP");
      break;
    case "check":
      if (node.text.trim() === "") add("error", name, "пустой CHECK");
      break;
  }
}

// stub-детекция для непокрытых заглушек (STOP «другая система» и т.п.) — оставлено на будущее
export function coverageReport(cat: Catalog): string[] {
  const lines: string[] = [];
  for (const p of cat.procedures) {
    let steps = 0;
    let checks = 0;
    let calls = 0;
    for (const n of walkProcedureNodes(p)) {
      if (n.kind === "step") steps++;
      else if (n.kind === "check") checks++;
      else if (n.kind === "call") calls++;
    }
    lines.push(
      `${(p.code ?? p.name).padEnd(16)} глав:${String(p.chapters.length).padStart(2)}  шагов:${String(steps).padStart(3)}  проверок:${String(checks).padStart(2)}  вызовов:${String(calls).padStart(2)}  [${p.status}]`,
    );
  }
  return lines;
}

function main() {
  let cat: Catalog;
  try {
    cat = loadCatalog();
  } catch (e) {
    console.error("Ошибка загрузки каталога:");
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  }

  const issues = validate(cat);
  const errors = issues.filter((i) => i.severity === "error");
  const warns = issues.filter((i) => i.severity === "warn");

  console.log(`Каталог: ${cat.procedures.length} процедур, ${cat.byCode.size} с кодами\n`);
  console.log(coverageReport(cat).join("\n"));
  console.log("");

  for (const i of issues) {
    const tag = i.severity === "error" ? "ОШИБКА" : "предупр";
    console.log(`  [${tag}] ${i.proc}: ${i.message}`);
  }
  console.log(`\nИтого: ${errors.length} ошибок, ${warns.length} предупреждений`);
  process.exit(errors.length > 0 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
