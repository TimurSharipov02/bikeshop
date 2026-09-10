// Runtime model for repair procedures ("функции" из docs/procedures/*.md).
// Авторский формат — .proc-файлы в catalog/, парсер в dsl.ts.

export type DetailLevel = 0 | 1 | 2; // 0 — глава, 1 — шаг, 2 — детализация
export type RunMode = "master" | "standard" | "training";

export interface Param {
  name: string;
  options: string[];
}

export interface Source {
  title: string;
  url?: string;
}

export type Node =
  | StepNode
  | IfNode
  | WhileNode
  | ForEachNode
  | CallNode
  | CheckNode
  | ApproveNode
  | StopNode;

export interface StepNode {
  kind: "step";
  text: string;
  level: DetailLevel; // 1 — STEP, 2 — SUB
  notes: string[]; // NOTE — пояснения уровня 2
}

export interface IfBranch {
  when: string; // условие ветки; "" — ИНАЧЕ
  nodes: Node[];
}

export interface IfNode {
  kind: "if";
  branches: IfBranch[];
}

export interface WhileNode {
  kind: "while";
  condition: string;
  nodes: Node[];
}

export interface ForEachNode {
  kind: "foreach";
  varName: string;
  collection: string; // исходная подпись
  items: string[]; // явный список (напр. ["переднее", "заднее"]); пусто — открытый цикл
  nodes: Node[];
}

export interface CallNode {
  kind: "call";
  code: string; // код вызываемой процедуры, напр. "DRV-07"
  note?: string;
}

export interface CheckNode {
  kind: "check";
  text: string;
  onFail?: string;
  group?: string; // id группы неисправностей (catalog/faults.json), из синтаксиса `CHECK [BRK] ...`
}

export interface ApproveNode {
  kind: "approve";
  text: string; // СОГЛАСОВАТЬ С КЛИЕНТОМ
}

export interface StopNode {
  kind: "stop";
  reason: string;
}

export interface Chapter {
  id: string;
  title: string;
  showIf?: { param: string; value: string };
  nodes: Node[];
}

export type ProcStatus = "ready" | "draft" | "stub";

export interface Procedure {
  code: string | null; // "DRV-01"; null — вспомогательная функция
  name: string;
  kind: "operation" | "helper";
  status: ProcStatus;
  params: Param[];
  entry?: string;
  tools?: string;
  consumables?: string;
  chapters: Chapter[];
  quality: string[]; // ПРОВЕРКА КАЧЕСТВА
  record: string[]; // ФИКСИРОВАТЬ В НАРЯДЕ
  sources: Source[];
  sourceFile: string;
}

export interface Catalog {
  procedures: Procedure[];
  byCode: Map<string, Procedure>;
}

export function buildCatalog(procedures: Procedure[]): Catalog {
  const byCode = new Map<string, Procedure>();
  for (const p of procedures) {
    if (p.code) byCode.set(p.code, p);
  }
  return { procedures, byCode };
}

// Обойти все узлы процедуры (для валидатора и статистики).
export function* walkNodes(nodes: Node[]): Generator<Node> {
  for (const n of nodes) {
    yield n;
    switch (n.kind) {
      case "if":
        for (const b of n.branches) yield* walkNodes(b.nodes);
        break;
      case "while":
      case "foreach":
        yield* walkNodes(n.nodes);
        break;
    }
  }
}

export function* walkProcedureNodes(p: Procedure): Generator<Node> {
  for (const ch of p.chapters) yield* walkNodes(ch.nodes);
}
