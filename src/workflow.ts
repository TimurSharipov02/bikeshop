// Рабочий процесс мастерской: обращение → диагностика → согласование →
// наряд → ремонт → повторная диагностика → выдача.
// Опирается на раннер процедур (src/runner.ts) и хранилище (src/store.ts).

import type { Catalog, Procedure, RunMode } from "./model.ts";
import { runProcedure, type RunnerIO } from "./runner.ts";
import { loadDB, saveDB } from "./store.ts";
import {
  nextBikeNumber,
  nextOrderNumber,
  type Bike,
  type Client,
  type DB,
  type WorkItem,
  type WorkOrder,
} from "./domain.ts";
import type { Term } from "./term.ts";
import { loadFaults, type FaultCatalog } from "./faults.ts";

type MakeIO = (mode: RunMode) => RunnerIO;

export async function runWorkflow(cat: Catalog, term: Term, makeIO: MakeIO): Promise<void> {
  const db = loadDB();
  const action = await term.pick("Обращение:", [
    "Новое обращение",
    "Открытые обращения",
    "← назад",
  ]);
  if (action === "← назад") return;

  let order: WorkOrder;
  if (action === "Открытые обращения") {
    const open = db.orders.filter((o) => o.status !== "выдан");
    if (open.length === 0) {
      term.print("Открытых обращений нет.");
      return;
    }
    const chosen = await term.pick("Какое обращение?", [
      ...open.map((o) => `${o.number}  вел. ${o.bikeNumber}  [${o.status}]`),
      "← назад",
    ]);
    if (chosen === "← назад") return;
    order = open.find((o) => chosen.startsWith(o.number))!;
  } else {
    order = await intake(db, term, cat, makeIO);
  }

  await driveOrder(db, order, term, cat, makeIO);
}

// --- Этап 2–5: приёмка ---

async function intake(db: DB, term: Term, cat: Catalog, makeIO: MakeIO): Promise<WorkOrder> {
  term.print("\n— КЛИЕНТ —");
  const phone = (await term.ask("Телефон: ")).trim();
  let client = db.clients.find((c) => c.phone === phone);
  if (client) {
    term.print(`  Найден: ${client.name}`);
  } else {
    const name = (await term.ask("Имя: ")).trim();
    const consent = await term.yesNo("Согласие на обзвон?");
    client = { phone, name, consentToCall: consent };
    db.clients.push(client);
  }

  term.print("\n— ВЕЛОСИПЕД —");
  let bike: Bike | undefined;
  const known = await term.yesNo("Номер велосипеда известен (был у нас)?");
  if (known) {
    const num = (await term.ask("Номер велосипеда: ")).trim();
    bike = db.bikes.find((b) => b.number.toLowerCase() === num.toLowerCase());
    if (!bike) term.print("  Не найден — заведём новый.");
  }
  if (!bike) {
    const kind = await term.pick("Тип:", ["шоссе", "гревел", "МТБ"]);
    const brand = (await term.ask("Бренд: ")).trim();
    const model = (await term.ask("Модель: ")).trim();
    bike = { number: nextBikeNumber(db), kind, brand, model, ownerPhone: phone };
    db.bikes.push(bike);
    term.print(`  Присвоен номер: ${bike.number}`);
  }

  const request = (await term.ask("\nЗапрос клиента (коротко): ")).trim();

  const order: WorkOrder = {
    number: nextOrderNumber(db),
    clientPhone: phone,
    bikeNumber: bike.number,
    request,
    status: "приём",
    items: [],
    createdAt: new Date().toISOString(),
  };
  db.orders.push(order);
  saveDB(db);
  term.print(`\n✔ Обращение ${order.number} · велосипед ${bike.number}`);

  // Диагностика — неисправности отмечаются прямо по ходу
  if (await term.yesNo("\nПройти диагностику (DIA-01) сейчас?")) {
    await runDiagnostic(cat, order, term, makeIO);
  }

  // Дополнить список работ вручную
  term.print("\n— СПИСОК РАБОТ —");
  if (order.items.length) {
    for (const it of order.items) term.print(`  ${it.code} ${it.name}`);
    term.print("  (добавить ещё — введите коды; пусто — дальше)");
  }
  await addItems(order, term, cat);
  saveDB(db);

  return order;
}

// Прогон DIA-01 с перехватом провалившихся ПРОВЕРОК: раскрывается список
// неисправностей своей группы, мастер отмечает их и пишет комментарий.
async function runDiagnostic(
  cat: Catalog,
  order: WorkOrder,
  term: Term,
  makeIO: MakeIO,
): Promise<void> {
  const faults = loadFaults();
  const base = makeIO("standard");
  const io: RunnerIO = {
    ...base,
    async check(text, onFail, group) {
      const ok = await base.check(text, onFail, group);
      if (!ok) await recordFaults(cat, faults, group, order, term, text);
      return ok;
    },
  };
  const proc = cat.byCode.get("DIA-01")!;
  await runProcedure(cat, proc, io, { mode: "standard" });
}

async function recordFaults(
  cat: Catalog,
  faults: FaultCatalog,
  groupId: string | undefined,
  order: WorkOrder,
  term: Term,
  checkText: string,
): Promise<void> {
  const g = groupId ? faults.byId.get(groupId) : undefined;
  if (!g) {
    const code = (await term.ask("     ↳ неисправность. Код операции (пусто — заметка): "))
      .trim()
      .toUpperCase();
    const comment = (await term.ask("     комментарий (пусто — нет): ")).trim();
    addFinding(cat, order, term, code, [checkText, comment].filter(Boolean).join("; "));
    return;
  }

  term.print(`     ${g.title} — что не так?`);
  g.faults.forEach((fl, i) => {
    term.print(`       ${i + 1}) ${fl.label}${fl.code ? `   → ${fl.code}` : ""}`);
  });
  const sel = (await term.ask("     номера через запятую (можно несколько, напр. 1,3), 0 — заметкой: ")).trim();
  const comment = (await term.ask("     комментарий (пусто — нет): ")).trim();
  const idxs = sel
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= g.faults.length);

  if (idxs.length === 0) {
    order.request = appendNote(order.request, comment || checkText);
    return;
  }
  for (const i of idxs) {
    const fl = g.faults[i - 1]!;
    addFinding(cat, order, term, fl.code, [fl.label, fl.note, comment].filter(Boolean).join("; "));
  }
}

function addFinding(cat: Catalog, order: WorkOrder, term: Term, code: string, note: string): void {
  const proc = code ? cat.byCode.get(code.toUpperCase()) : undefined;
  if (proc?.code) {
    const existing = order.items.find((i) => i.code === proc.code);
    if (existing) {
      existing.notes = existing.notes ? `${existing.notes}; ${note}` : note;
    } else {
      order.items.push({
        code: proc.code,
        name: proc.name,
        agreed: false,
        done: false,
        parts: [],
        notes: note,
      });
      term.print(`       + ${proc.code} ${proc.name}`);
    }
  } else {
    if (code) term.print("       нет такой операции — записано как заметка");
    order.request = appendNote(order.request, note);
  }
}

function appendNote(base: string, note: string): string {
  if (!note) return base;
  return `${base}${base ? " | " : ""}${note}`;
}

async function addItems(order: WorkOrder, term: Term, cat: Catalog): Promise<void> {
  while (true) {
    const proc = await pickOperation(term, cat);
    if (!proc || !proc.code) break;
    if (order.items.some((i) => i.code === proc.code)) {
      term.print("  уже в списке");
      continue;
    }
    const notes = (await term.ask(`  «${proc.name}» — риски / комментарий (пусто — нет): `)).trim();
    order.items.push({
      code: proc.code,
      name: proc.name,
      agreed: false,
      done: false,
      parts: [],
      notes,
    });
    term.print(`  + ${proc.code} ${proc.name}`);
  }
}

// Выбор операции из каталога: поиск по коду/названию либо список по группам.
async function pickOperation(term: Term, cat: Catalog): Promise<Procedure | null> {
  const skip = new Set(["DIA-01", "DIA-01R"]); // диагностика — не отдельная работа наряда
  const ops = cat.procedures.filter(
    (p): p is Procedure & { code: string } => !!p.code && !skip.has(p.code),
  );
  const groups = [...new Set(ops.map((p) => p.code.split("-")[0]!))];

  while (true) {
    const q = (
      await term.ask("Работа — часть кода/названия для поиска, Enter — по группам, пусто ещё раз — закончить: ")
    ).trim();

    if (!q) {
      const grp = await term.pick("Группа:", [...groups, "← закончить"]);
      if (grp === "← закончить") return null;
      const list = ops.filter((p) => p.code.startsWith(grp + "-"));
      return chooseFrom(term, list);
    }

    const ql = q.toLowerCase();
    const matches = ops.filter(
      (p) => p.code.toLowerCase().includes(ql) || p.name.toLowerCase().includes(ql),
    );
    if (matches.length === 0) {
      term.print("  ничего не найдено");
      continue;
    }
    if (matches.length === 1) return matches[0]!;
    const chosen = await chooseFrom(term, matches);
    if (chosen) return chosen;
  }
}

async function chooseFrom(term: Term, list: Procedure[]): Promise<Procedure | null> {
  if (list.length === 0) return null;
  const labels = list.map((p) => `${p.code}  ${p.name}`);
  const pick = await term.pick("Выбор:", [...labels, "← назад"]);
  if (pick === "← назад") return null;
  const code = pick.split(/\s+/)[0]!;
  return list.find((p) => p.code === code) ?? null;
}

// --- Этап 4, 6–9: ведение обращения ---

async function driveOrder(
  db: DB,
  order: WorkOrder,
  term: Term,
  cat: Catalog,
  makeIO: MakeIO,
): Promise<void> {
  printOrder(order, term);

  if (order.status === "приём" || order.status === "согласование") {
    term.print("\n— СОГЛАСОВАНИЕ С КЛИЕНТОМ —");
    for (const it of order.items) {
      it.agreed = await term.yesNo(`  ${it.code} ${it.name}${it.notes ? " (" + it.notes + ")" : ""} — согласовано?`);
    }
    order.status = "в работе";
    saveDB(db);
    term.print("  Наряд сформирован, статус: в работе");
  }

  if (order.status === "в работе") {
    term.print("\n— РЕМОНТ —");
    const mode = await pickMode(term);
    for (const it of order.items) {
      if (!it.agreed || it.done) continue;
      term.print(`\n▶ ${it.code} ${it.name}`);
      await runOne(cat, it.code, term, makeIO, mode);
      const mins = Number((await term.ask("  фактическое время, мин: ")).trim());
      if (Number.isFinite(mins)) it.actualMinutes = mins;
      const parts = (await term.ask("  израсходованные запчасти (через запятую): ")).trim();
      it.parts = parts ? parts.split(",").map((p) => p.trim()).filter(Boolean) : [];
      it.notes = ((await term.ask("  отклонения от карты (пусто — нет): ")).trim()) || it.notes;
      it.doneBy = ((await term.ask("  кто выполнял: ")).trim()) || undefined;
      it.done = true;
      saveDB(db);
    }
    // доп. работы, найденные в процессе
    if (await term.yesNo("\nНайдены доп. работы?")) {
      await addItems(order, term, cat);
      for (const it of order.items) {
        if (it.agreed) continue;
        it.agreed = await term.yesNo(`  ${it.code} ${it.name} — согласовано с клиентом?`);
      }
      saveDB(db);
      if (order.items.some((i) => i.agreed && !i.done)) {
        term.print("Есть несделанные согласованные работы — повтори «Открытые обращения».");
        return;
      }
    }
    order.status = "проверка";
    order.finishedAt = new Date().toISOString();
    saveDB(db);
  }

  if (order.status === "проверка") {
    term.print("\n— ПОВТОРНАЯ ДИАГНОСТИКА —");
    await runOne(cat, "DIA-01R", term, makeIO);
    if (await term.yesNo("Всё в порядке, выдаём клиенту?")) {
      order.status = "выдан";
      order.handedOverAt = new Date().toISOString();
      saveDB(db);
    } else {
      order.status = "в работе";
      saveDB(db);
      term.print("Возвращено в работу.");
      return;
    }
  }

  term.print("\n— ВЫДАЧА —");
  printOrder(order, term);
  const client = db.clients.find((c) => c.phone === order.clientPhone);
  term.print(`\nКлиент: ${client?.name ?? order.clientPhone} · тел. ${order.clientPhone}`);
  term.print(order.status === "выдан" ? "Статус: выдан ✔" : `Статус: ${order.status}`);
}

// --- вспомогательное ---

async function pickMode(term: Term): Promise<RunMode> {
  const m = await term.pick("Режим показа процедур:", [
    "Мастер (только главы и проверки)",
    "Стандарт (главы и шаги)",
    "Обучение (всё, с пояснениями)",
  ]);
  return m.startsWith("Мастер") ? "master" : m.startsWith("Обучение") ? "training" : "standard";
}

async function runOne(
  cat: Catalog,
  code: string,
  term: Term,
  makeIO: MakeIO,
  mode: RunMode = "standard",
): Promise<void> {
  const proc = cat.byCode.get(code);
  if (!proc) {
    term.print(`  процедура ${code} не найдена в каталоге`);
    return;
  }
  await runProcedure(cat, proc, makeIO(mode), { mode });
  if (proc.quality.length) {
    term.print("  ПРОВЕРКА КАЧЕСТВА:");
    for (const q of proc.quality) term.print(`   • ${q}`);
  }
}

function printOrder(order: WorkOrder, term: Term): void {
  term.print(`\n═══ ${order.number} · велосипед ${order.bikeNumber} · [${order.status}] ═══`);
  term.print(`запрос: ${order.request || "—"}`);
  if (order.items.length === 0) {
    term.print("работы: —");
    return;
  }
  term.print("работы:");
  for (const it of order.items) {
    const flags = [it.agreed ? "согл." : "не согл.", it.done ? "готово" : "—"].join(" / ");
    const extra = it.done
      ? `  ${it.actualMinutes ?? "?"} мин${it.parts.length ? " · " + it.parts.join(", ") : ""}`
      : "";
    term.print(`  ${it.code} ${it.name}  [${flags}]${extra}`);
  }
}
