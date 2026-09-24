// Общая формула оплаты работы для приложения и выгрузки в 1С.
export function itemWorkValue(it) {
  const qty = it.qty || 1;
  const wholeItemQty = it.quantityMode === "instances" ? qty : 1;
  let total = (it.workPrice || 0) * qty;
  for (const d of it.difficulties || []) {
    if (d.state === "yes") total += (d.add || 0) * (d.qty || 1) * wholeItemQty;
  }
  return total;
}
