// Модель данных мастерской. На этапе консоли хранится в data/db.json.

export interface Client {
  phone: string; // уникальный ключ
  name: string;
  consentToCall: boolean;
}

export interface Bike {
  number: string; // сгенерированный, напр. B-000042
  kind: string; // шоссе / гревел / МТБ
  brand: string;
  model: string;
  ownerPhone: string;
}

export type OrderStatus =
  | "приём"
  | "оценка"
  | "согласование"
  | "в работе"
  | "проверка"
  | "выдан";

export type DifficultyState = "yes" | "no" | "unknown"; // будет / не будет / неизвестно

export interface DifficultyAssessment {
  label: string;
  add: number; // надбавка к цене работы, ₽
  state: DifficultyState;
}

export interface WorkItem {
  code: string; // код операции из каталога
  name: string;
  agreed: boolean; // согласовано с клиентом
  done: boolean;
  actualMinutes?: number;
  parts: string[];
  notes: string;
  doneBy?: string;
  workPrice?: number; // цена работы на момент оценки, ₽
  difficulties?: DifficultyAssessment[]; // оценка возможных трудностей
}

// Вилка цены по работе: минимум — только «будет»; максимум — «будет» + «неизвестно».
export function itemPriceRange(it: WorkItem): { min: number; max: number } {
  const base = it.workPrice ?? 0;
  let min = base;
  let max = base;
  for (const d of it.difficulties ?? []) {
    if (d.state === "yes") {
      min += d.add;
      max += d.add;
    } else if (d.state === "unknown") {
      max += d.add;
    }
  }
  return { min, max };
}

export function orderPriceRange(order: WorkOrder): { min: number; max: number } {
  return order.items
    .filter((i) => i.agreed)
    .reduce(
      (acc, it) => {
        const r = itemPriceRange(it);
        return { min: acc.min + r.min, max: acc.max + r.max };
      },
      { min: 0, max: 0 },
    );
}

export interface WorkOrder {
  number: string; // сгенерированный, напр. V26-000147
  clientPhone: string;
  bikeNumber: string;
  request: string; // слова клиента — не меняются автоматически
  diagnosticNotes?: string[]; // замечания с диагностики без привязки к операции
  status: OrderStatus;
  items: WorkItem[];
  createdAt: string;
  finishedAt?: string;
  handedOverAt?: string;
  totalCost?: number; // на будущее — из прайса
}

export interface DB {
  clients: Client[];
  bikes: Bike[];
  orders: WorkOrder[];
  counters: { order: number; bike: number };
}

export function emptyDB(): DB {
  return { clients: [], bikes: [], orders: [], counters: { order: 0, bike: 0 } };
}

const yy = () => String(new Date().getFullYear()).slice(2);

export function nextOrderNumber(db: DB, locationCode = "V"): string {
  db.counters.order += 1;
  return `${locationCode}${yy()}-${String(db.counters.order).padStart(6, "0")}`;
}

export function nextBikeNumber(db: DB): string {
  db.counters.bike += 1;
  return `B-${String(db.counters.bike).padStart(6, "0")}`;
}
