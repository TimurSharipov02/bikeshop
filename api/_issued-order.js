// Выданное (оплаченное) обращение — учётная запись: по нему считается
// выработка мастеров и выгрузка в 1С, поэтому обычный пуш через /api/db его
// менять не может (см. _work-access.js). Ошибочную выдачу (тест, случайное
// нажатие) можно откатить только этими явными действиями — и только пока
// обращение не прошло через 1С: чек с кассы (fiscalReceipt) или выгрузка
// (exportedTo1C). Иначе в 1С осталась бы продажа, которой нет на сайте.
import { MergeConflict } from "./_db-merge.js";

export const REOPEN_WINDOW_MS = 15 * 60 * 1000; // мастер откатывает свою выдачу 15 минут

export const isIssued = (o) => !!o && (o.status === "выдан" || !!o.handedOverAt);
export const in1C = (o) => !!o?.fiscalReceipt || !!o?.exportedTo1C;
const IN_1C_MESSAGE = "обращение уже прошло через 1С — сначала отмените документ в 1С";

// Может ли пользователь вернуть выданное обращение в работу.
export function canReopen(order, user, now = Date.now()) {
  if (!isIssued(order) || in1C(order)) return false;
  if (user?.role === "admin") return true;
  const at = Date.parse(order.handedOverAt || "");
  return !!order.handedOverBy?.masterId && order.handedOverBy.masterId === user?.uid &&
    Number.isFinite(at) && now - at <= REOPEN_WINDOW_MS;
}

// Вернуть выданное обращение в работу (меняет data на месте).
export function reopenIssuedOrder(data, number, user, now = Date.now()) {
  const order = (data.orders || []).find((o) => o.number === number);
  if (!order) throw new MergeConflict(`обращение ${number} не найдено`);
  if (!isIssued(order)) throw new MergeConflict("обращение ещё не выдано");
  if (in1C(order)) throw new MergeConflict(IN_1C_MESSAGE);
  if (!canReopen(order, user, now)) {
    throw new MergeConflict("вернуть выдачу может администратор или сам мастер в течение 15 минут");
  }
  order.status = "взята в работу";
  delete order.handedOverAt;
  delete order.handedOverBy;
  order.history = [...(order.history || []), { at: new Date(now).toISOString(), by: user.uid, what: "выдача отменена" }];
  return order;
}

// Можно ли удалить обращение: невыданное — как раньше, выданное — только
// администратору и только если оно не прошло через 1С.
export function assertOrderDeletable(order, user) {
  if (!order || !isIssued(order)) return;
  if (in1C(order)) throw new MergeConflict(IN_1C_MESSAGE);
  if (user?.role !== "admin") throw new MergeConflict("выданное обращение может удалить только администратор");
}
