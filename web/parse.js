// Парсер формата .proc → массив процедур. Обычный JS (порт src/dsl.ts).
// Формат описан в src/dsl.ts и README.

export class DslError extends Error {
  constructor(message, file, line) {
    super(`${file}:${line}: ${message}`);
    this.name = "DslError";
    this.file = file;
    this.line = line;
  }
}

const quoted = (s) => {
  const m = s.match(/"([^"]*)"/);
  return m ? m[1] ?? "" : null;
};

export function parseProc(text, file) {
  const lines = text.split(/\r?\n/);
  const procedures = [];

  let cur = null;
  let section = "header";
  let stack = [];
  let lastStep = null;
  let lastCheck = null;

  const finish = () => {
    if (cur) procedures.push(cur);
    cur = null;
    stack = [];
    section = "header";
    lastStep = null;
    lastCheck = null;
  };
  const top = (n) => {
    const f = stack[stack.length - 1];
    if (!f) throw new DslError("нет открытого блока для этого узла", file, n);
    return f;
  };
  const push = (node, n) => top(n).nodes.push(node);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = (lines[i] || "").trim();
    if (line === "" || line.startsWith("#")) continue;

    const parts = line.split(/\s+/);
    const kw = parts[0];
    const rest = line.slice(kw.length).trim();

    if (kw === "PROC") {
      finish();
      const name = quoted(rest);
      if (name == null) throw new DslError('PROC требует "имя" в кавычках', file, lineNo);
      const codeTok = rest.split(/\s+/)[0] || "-";
      cur = {
        code: codeTok === "-" ? null : codeTok,
        name,
        kind: codeTok === "-" ? "helper" : "operation",
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

    if (section === "header") {
      if (kw === "KIND") { cur.kind = rest === "helper" ? "helper" : "operation"; continue; }
      if (kw === "STATUS") { cur.status = rest; continue; }
      if (kw === "PARAM") {
        const m = rest.match(/^([^:]+):\s*(.+)$/);
        if (!m) throw new DslError("PARAM формат: <имя>: a | b", file, lineNo);
        cur.params.push({ name: m[1].trim(), options: m[2].split("|").map((o) => o.trim()).filter(Boolean) });
        continue;
      }
      if (kw === "ENTRY") { cur.entry = rest; continue; }
      if (kw === "TOOLS") { cur.tools = rest; continue; }
      if (kw === "CONSUM") { cur.consumables = rest; continue; }
      if (kw === "CH") section = "chapters";
      else if (kw === "QUALITY") { section = "quality"; continue; }
      else if (kw === "RECORD") { section = "record"; continue; }
      else if (kw === "SOURCE") section = "chapters";
      else throw new DslError(`неизвестная директива заголовка: ${kw}`, file, lineNo);
    }

    if (section === "quality" || section === "record") {
      if (kw === "QUALITY") { section = "quality"; continue; }
      if (kw === "RECORD") { section = "record"; continue; }
      if (kw === "SOURCE") { section = "chapters"; }
      else if (line.startsWith("-")) {
        const item = line.replace(/^-\s*/, "");
        (section === "quality" ? cur.quality : cur.record).push(item);
        continue;
      } else if (kw !== "PROC") {
        throw new DslError(`ожидалась строка "- ..." в ${section}`, file, lineNo);
      }
    }

    switch (kw) {
      case "QUALITY": section = "quality"; stack = []; continue;
      case "RECORD": section = "record"; stack = []; continue;
      case "SOURCE": {
        const title = quoted(rest);
        if (title == null) throw new DslError('SOURCE требует "заголовок"', file, lineNo);
        const after = rest.slice(rest.indexOf('"', rest.indexOf('"') + 1) + 1).trim();
        cur.sources.push(after ? { title, url: after } : { title });
        continue;
      }
      case "CH": {
        const title = quoted(rest);
        if (title == null) throw new DslError('CH требует "заголовок"', file, lineNo);
        const chapter = { id: rest.split(/\s+/)[0] || "", title, nodes: [] };
        cur.chapters.push(chapter);
        stack = [{ nodes: chapter.nodes, opener: "chapter" }];
        lastStep = lastCheck = null;
        continue;
      }
      case "SHOWIF": {
        const m = rest.match(/^(.+?)=(.+)$/);
        if (!m) throw new DslError("SHOWIF формат: <param>=<value>", file, lineNo);
        const ch = cur.chapters[cur.chapters.length - 1];
        if (!ch) throw new DslError("SHOWIF вне CH", file, lineNo);
        ch.showIf = { param: m[1].trim(), value: m[2].trim() };
        continue;
      }
      case "STEP": {
        const node = { kind: "step", text: rest, level: 1, notes: [] };
        push(node, lineNo); lastStep = node; lastCheck = null; continue;
      }
      case "SUB": {
        const node = { kind: "step", text: rest, level: 2, notes: [] };
        push(node, lineNo); lastStep = node; lastCheck = null; continue;
      }
      case "NOTE": {
        if (lastStep) lastStep.notes.push(rest);
        else push({ kind: "step", text: rest, level: 2, notes: [] }, lineNo);
        continue;
      }
      case "IF": {
        const ifNode = { kind: "if", branches: [{ when: rest, nodes: [] }] };
        push(ifNode, lineNo);
        stack.push({ nodes: ifNode.branches[0].nodes, ifNode, opener: "if" });
        lastStep = lastCheck = null;
        continue;
      }
      case "ELIF": {
        const f = top(lineNo);
        if (f.opener !== "if" || !f.ifNode) throw new DslError("ELIF без IF", file, lineNo);
        const b = { when: rest, nodes: [] };
        f.ifNode.branches.push(b); f.nodes = b.nodes; lastStep = null;
        continue;
      }
      case "ELSE": {
        const f = top(lineNo);
        if (f.opener !== "if" || !f.ifNode) throw new DslError("ELSE без IF", file, lineNo);
        const b = { when: "", nodes: [] };
        f.ifNode.branches.push(b); f.nodes = b.nodes; lastStep = null;
        continue;
      }
      case "WHILE": {
        const node = { kind: "while", condition: rest, nodes: [] };
        push(node, lineNo); stack.push({ nodes: node.nodes, opener: "while" }); lastStep = null;
        continue;
      }
      case "FOREACH": {
        const m = rest.match(/^(.+?)\s*:\s*(.+)$/);
        if (!m) throw new DslError("FOREACH формат: <var> : <a, b, ...> | <подпись>", file, lineNo);
        const collection = m[2].trim();
        const parts2 = collection.includes(",")
          ? collection.split(",").map((s) => s.trim()).filter(Boolean)
          : [];
        const node = { kind: "foreach", varName: m[1].trim(), collection, items: parts2.length >= 2 ? parts2 : [], nodes: [] };
        push(node, lineNo); stack.push({ nodes: node.nodes, opener: "foreach" }); lastStep = null;
        continue;
      }
      case "END": {
        if (stack.length <= 1) throw new DslError("лишний END", file, lineNo);
        stack.pop(); lastStep = lastCheck = null;
        continue;
      }
      case "CALL": {
        const codeTok = parts[1] || rest.split(/\s+/)[0] || "";
        if (!codeTok) throw new DslError("CALL требует код процедуры", file, lineNo);
        const note = quoted(rest) || undefined;
        push({ kind: "call", code: codeTok, note }, lineNo); lastStep = null;
        continue;
      }
      case "CHECK": {
        const gm = rest.match(/^\[([A-Za-z]+)\]\s*(.+)$/);
        const node = gm
          ? { kind: "check", text: gm[2].trim(), group: gm[1] }
          : { kind: "check", text: rest };
        push(node, lineNo); lastCheck = node; lastStep = null;
        continue;
      }
      case "ONFAIL": {
        if (!lastCheck) throw new DslError("ONFAIL без CHECK", file, lineNo);
        lastCheck.onFail = rest;
        continue;
      }
      case "APPROVE": push({ kind: "approve", text: rest }, lineNo); lastStep = null; continue;
      case "STOP": push({ kind: "stop", reason: rest }, lineNo); lastStep = null; continue;
      default:
        throw new DslError(`неизвестное ключевое слово: ${kw}`, file, lineNo);
    }
  }

  finish();
  return procedures;
}
