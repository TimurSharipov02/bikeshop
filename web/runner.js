// Раннер процедуры для браузера — прямой порт src/runner.ts на обычный JS.
// Ведёт исполнителя по шагам; весь ввод-вывод — через объект io.

class StopSignal extends Error {}
const DETAIL = { master: 0, standard: 1, training: 2 };

export function buildCatalog(procedures) {
  const byCode = new Map();
  for (const p of procedures) if (p.code) byCode.set(p.code, p);
  return { procedures, byCode };
}

export async function runProcedure(cat, proc, io, opts) {
  const threshold = DETAIL[opts.mode] ?? 1;
  const params = { ...(opts.params || {}) };
  const paramOptions = {};
  const callStack = [];
  const bindings = {};

  const subst = (s) => {
    let out = s;
    for (const [k, v] of Object.entries(bindings)) {
      out = out.split(`<${k}>`).join(v).split(`{${k}}`).join(v);
    }
    return out;
  };

  async function resolveParam(name, options) {
    paramOptions[name] = options;
    if (params[name] !== undefined) return params[name];
    const value = opts.onParamNeeded
      ? await opts.onParamNeeded(name, options)
      : await io.branch(name, options);
    params[name] = value;
    return value;
  }

  function autoResolve(when) {
    for (const [name, value] of Object.entries(params)) {
      if (when === `${name} ${value}` || when === `${name}=${value}`) return true;
      if (when.startsWith(`${name} `)) {
        const claim = when.slice(name.length + 1).trim();
        if (claim === value) return true;
        const o = paramOptions[name];
        if (o && o.includes(claim) && claim !== value) return false;
      }
    }
    return null;
  }

  const chapterStack = [];

  async function runNodes(nodes) {
    for (const n of nodes) await runNode(n);
  }

  async function runNode(node) {
    switch (node.kind) {
      case "step":
        if (node.level <= threshold) {
          await io.step(
            { ...node, text: subst(node.text), notes: (node.notes || []).map(subst) },
            opts.mode === "training",
          );
        }
        return;
      case "check":
        await io.check(subst(node.text), node.onFail ? subst(node.onFail) : undefined, node.group);
        return;
      case "approve":
        await io.approve(subst(node.text));
        return;
      case "stop":
        await io.stop(subst(node.reason));
        throw new StopSignal(node.reason);
      case "if": {
        for (const b of node.branches) {
          if (b.when === "") {
            await runNodes(b.nodes);
            return;
          }
          const auto = autoResolve(b.when);
          const take =
            auto !== null ? auto : (await io.branch(`Условие: ${b.when}?`, ["да", "нет"])) === "да";
          if (take) {
            await runNodes(b.nodes);
            return;
          }
        }
        return;
      }
      case "while": {
        let first = true;
        while (await io.loopAgain(first ? node.condition : `ещё раз: ${node.condition}`)) {
          await runNodes(node.nodes);
          first = false;
        }
        return;
      }
      case "foreach": {
        if ((node.items || []).length > 0) {
          for (let i = 0; i < node.items.length; i++) {
            bindings[node.varName] = node.items[i];
            await io.foreachItem(node.varName, node.items[i], i + 1, node.items.length);
            await runNodes(node.nodes);
          }
          delete bindings[node.varName];
        } else {
          let first = true;
          while (await io.foreachNext(node.varName, node.collection, first)) {
            await runNodes(node.nodes);
            first = false;
          }
        }
        return;
      }
      case "call": {
        const target = cat.byCode.get(node.code);
        if (!target) {
          await io.missingCall(node.code);
          return;
        }
        if (callStack.includes(node.code)) {
          await io.skipRecursion(node.code);
          return;
        }
        callStack.push(node.code);
        await io.enterCall(target, node.note, callStack.length);
        try {
          await runOne(target);
        } catch (e) {
          if (!(e instanceof StopSignal)) throw e;
        } finally {
          await io.exitCall(target, callStack.length);
          callStack.pop();
        }
        return;
      }
    }
  }

  async function runOne(p) {
    for (const param of p.params) await resolveParam(param.name, param.options);
    for (const ch of p.chapters) {
      if (ch.showIf) {
        const v = params[ch.showIf.param];
        if (v !== undefined && v !== ch.showIf.value) continue;
        if (v === undefined) {
          const resolved = await resolveParam(ch.showIf.param, [ch.showIf.value, "иначе"]);
          if (resolved !== ch.showIf.value) continue;
        }
      }
      await io.chapter(ch, [...chapterStack]);
      chapterStack.push(ch.title);
      await runNodes(ch.nodes);
      chapterStack.pop();
    }
  }

  if (proc.code) callStack.push(proc.code);
  try {
    await runOne(proc);
  } catch (e) {
    if (!(e instanceof StopSignal)) throw e;
  }
}

// Плоский список ПРОВЕРОК процедуры-опросника (для листаемого чек-листа).
export function flattenChecks(cat, proc, params) {
  const out = [];
  const seen = new Set();

  const collectHints = (nodes, into) => {
    for (const n of nodes) {
      if (n.kind === "step") into.push(n.text);
      else if (n.kind === "if") for (const b of n.branches) collectHints(b.nodes, into);
      else if (n.kind === "while" || n.kind === "foreach") collectHints(n.nodes, into);
    }
  };

  function walk(nodes, chapter, scope, key) {
    let hints = [];
    let i = 0;
    for (const n of nodes) {
      i++;
      if (n.kind === "step") hints.push(n.text);
      else if (n.kind === "check") {
        out.push({
          id: `${key}.${i}${scope ? "." + scope : ""}`,
          chapter,
          scope,
          text: n.text,
          group: n.group,
          hints: hints.slice(),
        });
        hints = [];
      } else if (n.kind === "foreach" && (n.items || []).length) {
        for (const it of n.items) walk(n.nodes, chapter, `${it} ${n.varName}`, `${key}.${i}.${it}`);
      } else if (n.kind === "foreach") {
        walk(n.nodes, chapter, scope, `${key}.${i}`);
      } else if (n.kind === "if") {
        for (const b of n.branches) collectHints(b.nodes, hints);
      } else if (n.kind === "call") {
        const t = cat.byCode.get(n.code);
        if (t && !seen.has(n.code)) {
          seen.add(n.code);
          runProc(t, `${key}.call`);
        }
      }
    }
  }
  function runProc(p, key) {
    for (const ch of p.chapters) {
      if (ch.showIf && params[ch.showIf.param] !== undefined && params[ch.showIf.param] !== ch.showIf.value) continue;
      walk(ch.nodes, ch.title, undefined, `${key}.${ch.id}`);
    }
  }
  runProc(proc, proc.code || "p");
  return out;
}
