// Раннер процедуры: ведёт исполнителя по шагам, обрабатывает ветвления,
// циклы и ВЫЗОВ других процедур. Ввод-вывод абстрагирован через RunnerIO,
// чтобы одно ядро работало и в консоли, и в вебе.

import type {
  Catalog,
  Chapter,
  Node,
  Procedure,
  RunMode,
  StepNode,
} from "./model.ts";

export interface RunnerIO {
  chapter(ch: Chapter, path: string[]): Promise<void> | void;
  step(node: StepNode, showNotes: boolean): Promise<void> | void;
  check(text: string, onFail: string | undefined, group: string | undefined): Promise<boolean>;
  branch(question: string, options: string[]): Promise<string>;
  loopAgain(condition: string): Promise<boolean>;
  foreachNext(varName: string, collection: string, first: boolean): Promise<boolean>;
  foreachItem(varName: string, item: string, index: number, total: number): Promise<void> | void;
  approve(text: string): Promise<void> | void;
  stop(reason: string): Promise<void> | void;
  enterCall(target: Procedure, note: string | undefined, depth: number): Promise<void> | void;
  exitCall(target: Procedure, depth: number): Promise<void> | void;
  missingCall(code: string): Promise<void> | void;
  skipRecursion(code: string): Promise<void> | void;
}

export interface RunOptions {
  mode: RunMode;
  params?: Record<string, string>; // заранее известные значения параметров
  onParamNeeded?(name: string, options: string[]): Promise<string>;
}

class StopSignal extends Error {}

const detailThreshold: Record<RunMode, 0 | 1 | 2> = {
  master: 0,
  standard: 1,
  training: 2,
};

export async function runProcedure(
  cat: Catalog,
  proc: Procedure,
  io: RunnerIO,
  opts: RunOptions,
): Promise<void> {
  const threshold = detailThreshold[opts.mode];
  const params: Record<string, string> = { ...(opts.params ?? {}) };
  const paramOptions: Record<string, string[]> = {};
  const callStack: string[] = [];
  const bindings: Record<string, string> = {}; // текущие значения переменных FOREACH

  function subst(s: string): string {
    let out = s;
    for (const [k, v] of Object.entries(bindings)) {
      out = out.split(`<${k}>`).join(v).split(`{${k}}`).join(v);
    }
    return out;
  }

  async function resolveParam(name: string, options: string[]): Promise<string> {
    paramOptions[name] = options;
    if (params[name] !== undefined) return params[name]!;
    let value: string;
    if (opts.onParamNeeded) value = await opts.onParamNeeded(name, options);
    else value = await io.branch(name, options);
    params[name] = value;
    return value;
  }

  // Попытка вычислить условие IF из уже известных параметров:
  // "система Shimano Di2" при параметре система="Shimano Di2" → true;
  // "система SRAM AXS/eTap" при том же параметре → false (другое значение из набора).
  function autoResolveCondition(when: string): boolean | null {
    for (const [name, value] of Object.entries(params)) {
      if (when === `${name} ${value}` || when === `${name}=${value}`) return true;
      if (when.startsWith(`${name} `)) {
        const claim = when.slice(name.length + 1).trim();
        if (claim === value) return true;
        const opts2 = paramOptions[name];
        if (opts2 && opts2.includes(claim) && claim !== value) return false;
      }
    }
    return null;
  }

  async function runNodes(nodes: Node[], chapterPath: string[]): Promise<void> {
    for (const node of nodes) {
      await runNode(node, chapterPath);
    }
  }

  async function runNode(node: Node, chapterPath: string[]): Promise<void> {
    switch (node.kind) {
      case "step": {
        if (node.level <= threshold) {
          const shown = {
            ...node,
            text: subst(node.text),
            notes: node.notes.map(subst),
          };
          await io.step(shown, opts.mode === "training");
        }
        return;
      }
      case "check": {
        const ok = await io.check(
          subst(node.text),
          node.onFail ? subst(node.onFail) : undefined,
          node.group,
        );
        // раннер не прерывается на провале — решение за исполнителем
        void ok;
        return;
      }
      case "approve": {
        await io.approve(subst(node.text));
        return;
      }
      case "stop": {
        await io.stop(subst(node.reason));
        throw new StopSignal(node.reason);
      }
      case "if": {
        for (const b of node.branches) {
          if (b.when === "") {
            await runNodes(b.nodes, chapterPath);
            return;
          }
          const auto = autoResolveCondition(b.when);
          const take =
            auto !== null ? auto : (await io.branch(`Условие: ${b.when}?`, ["да", "нет"])) === "да";
          if (take) {
            await runNodes(b.nodes, chapterPath);
            return;
          }
        }
        return;
      }
      case "while": {
        let first = true;
        while (await io.loopAgain(first ? node.condition : `ещё раз: ${node.condition}`)) {
          await runNodes(node.nodes, chapterPath);
          first = false;
        }
        return;
      }
      case "foreach": {
        if (node.items.length > 0) {
          for (let i = 0; i < node.items.length; i++) {
            bindings[node.varName] = node.items[i]!;
            await io.foreachItem(node.varName, node.items[i]!, i + 1, node.items.length);
            await runNodes(node.nodes, chapterPath);
          }
          delete bindings[node.varName];
        } else {
          let first = true;
          while (await io.foreachNext(node.varName, node.collection, first)) {
            await runNodes(node.nodes, chapterPath);
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
          // STOP внутри подпроцедуры завершает только её
        } finally {
          await io.exitCall(target, callStack.length);
          callStack.pop();
        }
        return;
      }
    }
  }

  async function runOne(p: Procedure): Promise<void> {
    for (const param of p.params) {
      await resolveParam(param.name, param.options);
    }
    for (const ch of p.chapters) {
      if (ch.showIf) {
        const v = params[ch.showIf.param];
        if (v !== undefined && v !== ch.showIf.value) continue;
        if (v === undefined) {
          const resolved = await resolveParam(ch.showIf.param, [ch.showIf.value, "иначе"]);
          if (resolved !== ch.showIf.value) continue;
        }
      }
      await io.chapter(ch, [...(chapterStack)]);
      chapterStack.push(ch.title);
      await runNodes(ch.nodes, [...chapterStack]);
      chapterStack.pop();
    }
  }

  const chapterStack: string[] = [];

  if (proc.code) callStack.push(proc.code);
  try {
    await runOne(proc);
  } catch (e) {
    if (!(e instanceof StopSignal)) throw e;
  }
}
