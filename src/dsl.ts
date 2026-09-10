// Парсер авторского формата .proc → model.Procedure[]
//
// Формат (по строкам, отступы косметические, блоки закрываются END):
//
//   # комментарий
//   PROC DRV-01 "Настроить задний переключатель"
//     STATUS ready
//     PARAM тип: механика
//     ENTRY велосипед на стойке
//     TOOLS отвёртка PH2, шестигранники, ...
//     CONSUM наконечник троса, смазка
//
//   CH 1 "ВХОДНОЙ КОНТРОЛЬ"
//     SHOWIF тип=механика
//     STEP Проверить ровность петуха.
//       NOTE петух гнётся первым при ударе.
//     IF петух погнут
//       CALL DRV-07 "юстировка петуха"
//     END
//     CHECK ролик под малой звездой; цепь не задевает рамку
//       ONFAIL вернуться к H-лимиту
//
//   CH 2 "H-ЛИМИТ"
//     WHILE слышен шум
//       STEP отпускать H на 1/4 оборота
//     END
//     FOREACH звезда : все звёзды кассеты
//       STEP убрать шум барабанчиком
//     END
//     APPROVE замену кассеты, если изношена
//     STOP нужен старший механик
//
//   QUALITY
//     - чёткое переключение по всей кассете
//   RECORD
//     - фактическое время
//   SOURCE "Park Tool, Rear Derailleur Adjustment" https://www.parktool.com/...

import type {
  Chapter,
  IfBranch,
  IfNode,
  Node,
  Param,
  Procedure,
  ProcStatus,
  Source,
  StepNode,
} from "./model.ts";

export class DslError extends Error {
  file: string;
  line: number;
  constructor(message: string, file: string, line: number) {
    super(`${file}:${line}: ${message}`);
    this.name = "DslError";
    this.file = file;
    this.line = line;
  }
}

type Section = "header" | "chapters" | "quality" | "record";

interface Frame {
  nodes: Node[];
  // для IF: активная ветка, чтобы ELIF/ELSE дописывали в тот же узел
  ifNode?: IfNode;
  opener: "chapter" | "if" | "while" | "foreach";
}

const quoted = (s: string): string | null => {
  const m = s.match(/"([^"]*)"/);
  return m ? (m[1] ?? "") : null;
};

export function parseProc(text: string, file: string): Procedure[] {
  const rawLines = text.split(/\r?\n/);
  const procedures: Procedure[] = [];

  let cur: Procedure | null = null;
  let section: Section = "header";
  let stack: Frame[] = [];
  let lastStep: StepNode | null = null;
  let lastCheck: { onFail?: string } | null = null;

  const finish = () => {
    if (cur) procedures.push(cur);
    cur = null;
    stack = [];
    section = "header";
    lastStep = null;
    lastCheck = null;
  };

  const top = (lineNo: number): Frame => {
    const f = stack[stack.length - 1];
    if (!f) throw new DslError("нет открытого блока для этого узла", file, lineNo);
    return f;
  };

  const push = (node: Node, lineNo: number) => {
    top(lineNo).nodes.push(node);
  };

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const raw = rawLines[i] ?? "";
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const [kw, ...restParts] = line.split(/\s+/);
    const rest = line.slice((kw ?? "").length).trim();

    if (kw === "PROC") {
      finish();
      const name = quoted(rest);
      if (name == null) throw new DslError('PROC требует "имя" в кавычках', file, lineNo);
      const codeToken = rest.split(/\s+/)[0] ?? "-";
      const code = codeToken === "-" ? null : codeToken;
      cur = {
        code,
        name,
        kind: code ? "operation" : "helper",
        status: "ready",
        params: [],
        chapters: [],
        quality: [],
        record: [],
        sources: [],
        sourceFile: file,
      };
      section = "header";
      continue;
    }

    if (!cur) throw new DslError("строка вне PROC", file, lineNo);

    // --- header ---
    if (section === "header") {
      switch (kw) {
        case "KIND":
          cur.kind = rest === "helper" ? "helper" : "operation";
          continue;
        case "STATUS":
          cur.status = rest as ProcStatus;
          continue;
        case "PARAM": {
          const m = rest.match(/^([^:]+):\s*(.+)$/);
          if (!m) throw new DslError("PARAM формат: <имя>: a | b", file, lineNo);
          const p: Param = {
            name: (m[1] ?? "").trim(),
            options: (m[2] ?? "").split("|").map((o) => o.trim()).filter(Boolean),
          };
          cur.params.push(p);
          continue;
        }
        case "ENTRY":
          cur.entry = rest;
          continue;
        case "TOOLS":
          cur.tools = rest;
          continue;
        case "CONSUM":
          cur.consumables = rest;
          continue;
        case "CH":
          section = "chapters";
          break; // проваливаемся в обработку CH ниже
        case "QUALITY":
        case "RECORD":
        case "SOURCE":
          section = kw === "SOURCE" ? "chapters" : (kw.toLowerCase() as Section);
          break;
        default:
          throw new DslError(`неизвестная директива заголовка: ${kw}`, file, lineNo);
      }
    }

    // --- QUALITY / RECORD ---
    if (section === "quality" || section === "record") {
      if (kw === "QUALITY") { section = "quality"; continue; }
      if (kw === "RECORD") { section = "record"; continue; }
      if (kw === "SOURCE") { section = "chapters"; /* обработается ниже */ }
      else if (line.startsWith("-")) {
        const item = line.replace(/^-\s*/, "");
        if (section === "quality") cur.quality.push(item);
        else cur.record.push(item);
        continue;
      } else if (kw === "PROC") {
        // уже обработан выше
      } else {
        throw new DslError(`ожидалась строка "- ..." в ${section}`, file, lineNo);
      }
    }

    // --- chapters / nodes ---
    switch (kw) {
      case "QUALITY":
        section = "quality";
        stack = [];
        continue;
      case "RECORD":
        section = "record";
        stack = [];
        continue;
      case "SOURCE": {
        const title = quoted(rest);
        if (title == null) throw new DslError('SOURCE требует "заголовок"', file, lineNo);
        const after = rest.slice(rest.indexOf('"', rest.indexOf('"') + 1) + 1).trim();
        const src: Source = { title };
        if (after) src.url = after;
        cur.sources.push(src);
        continue;
      }
      case "CH": {
        const title = quoted(rest);
        if (title == null) throw new DslError('CH требует "заголовок"', file, lineNo);
        const id = rest.split(/\s+/)[0] ?? "";
        const chapter: Chapter = { id, title, nodes: [] };
        cur.chapters.push(chapter);
        stack = [{ nodes: chapter.nodes, opener: "chapter" }];
        lastStep = null;
        lastCheck = null;
        continue;
      }
      case "SHOWIF": {
        const m = rest.match(/^(.+?)=(.+)$/);
        if (!m) throw new DslError("SHOWIF формат: <param>=<value>", file, lineNo);
        const ch = cur.chapters[cur.chapters.length - 1];
        if (!ch) throw new DslError("SHOWIF вне CH", file, lineNo);
        ch.showIf = { param: (m[1] ?? "").trim(), value: (m[2] ?? "").trim() };
        continue;
      }
      case "STEP": {
        const node: StepNode = { kind: "step", text: rest, level: 1, notes: [] };
        push(node, lineNo);
        lastStep = node;
        lastCheck = null;
        continue;
      }
      case "SUB": {
        const node: StepNode = { kind: "step", text: rest, level: 2, notes: [] };
        push(node, lineNo);
        lastStep = node;
        lastCheck = null;
        continue;
      }
      case "NOTE": {
        if (lastStep) lastStep.notes.push(rest);
        else push({ kind: "step", text: rest, level: 2, notes: [] }, lineNo);
        continue;
      }
      case "IF": {
        const ifNode: IfNode = { kind: "if", branches: [{ when: rest, nodes: [] }] };
        push(ifNode, lineNo);
        const branch = ifNode.branches[0] as IfBranch;
        stack.push({ nodes: branch.nodes, ifNode, opener: "if" });
        lastStep = null;
        lastCheck = null;
        continue;
      }
      case "ELIF": {
        const f = top(lineNo);
        if (f.opener !== "if" || !f.ifNode) throw new DslError("ELIF без IF", file, lineNo);
        const branch: IfBranch = { when: rest, nodes: [] };
        f.ifNode.branches.push(branch);
        f.nodes = branch.nodes;
        lastStep = null;
        continue;
      }
      case "ELSE": {
        const f = top(lineNo);
        if (f.opener !== "if" || !f.ifNode) throw new DslError("ELSE без IF", file, lineNo);
        const branch: IfBranch = { when: "", nodes: [] };
        f.ifNode.branches.push(branch);
        f.nodes = branch.nodes;
        lastStep = null;
        continue;
      }
      case "WHILE": {
        const node: Node = { kind: "while", condition: rest, nodes: [] };
        push(node, lineNo);
        stack.push({ nodes: node.nodes, opener: "while" });
        lastStep = null;
        continue;
      }
      case "FOREACH": {
        const m = rest.match(/^(.+?)\s*:\s*(.+)$/);
        if (!m) throw new DslError("FOREACH формат: <var> : <a, b, ...> | <открытая подпись>", file, lineNo);
        const collection = (m[2] ?? "").trim();
        // Явный список — только через запятую: "переднее, заднее".
        // Открытая коллекция ("все звёзды кассеты…") — цикл с вопросом «ещё раз?».
        const parts = collection.includes(",")
          ? collection.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
        const node: Node = {
          kind: "foreach",
          varName: (m[1] ?? "").trim(),
          collection,
          items: parts.length >= 2 ? parts : [],
          nodes: [],
        };
        push(node, lineNo);
        stack.push({ nodes: node.nodes, opener: "foreach" });
        lastStep = null;
        continue;
      }
      case "END": {
        if (stack.length <= 1) throw new DslError("лишний END", file, lineNo);
        stack.pop();
        lastStep = null;
        lastCheck = null;
        continue;
      }
      case "CALL": {
        const codeTok = restParts[0] ?? rest.split(/\s+/)[0] ?? "";
        const note = quoted(rest) ?? undefined;
        if (!codeTok) throw new DslError("CALL требует код процедуры", file, lineNo);
        push({ kind: "call", code: codeTok, note }, lineNo);
        lastStep = null;
        continue;
      }
      case "CHECK": {
        const gm = rest.match(/^\[([A-Za-z]+)\]\s*(.+)$/);
        const node: Node = gm
          ? { kind: "check", text: (gm[2] ?? "").trim(), group: gm[1] }
          : { kind: "check", text: rest };
        push(node, lineNo);
        lastCheck = node;
        lastStep = null;
        continue;
      }
      case "ONFAIL": {
        if (!lastCheck) throw new DslError("ONFAIL без CHECK", file, lineNo);
        lastCheck.onFail = rest;
        continue;
      }
      case "APPROVE": {
        push({ kind: "approve", text: rest }, lineNo);
        lastStep = null;
        continue;
      }
      case "STOP": {
        push({ kind: "stop", reason: rest }, lineNo);
        lastStep = null;
        continue;
      }
      default:
        throw new DslError(`неизвестное ключевое слово: ${kw}`, file, lineNo);
    }
  }

  finish();
  return procedures;
}
