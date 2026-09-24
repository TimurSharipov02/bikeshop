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

// Обращения, готовые к выгрузке в 1С: выданные клиенту и ещё не забранные
// предыдущим запросом (или все выданные, если all). Общая форма для двух
// вызывающих: api/1c-export.js (по секретному ключу, для самой 1С) и
// api/1c-sync.js (по логину администратора — ручная сверка/очистка списка
// на сайте, когда что-то уже занесено в 1С другим путём).
export function pendingExportOrders(db, { all = false } = {}) {
  return (db.orders || [])
    .filter((o) => o.handedOverAt && (all || !o.exportedTo1C))
    .map((o) => {
      const client = (db.clients || []).find((c) => c.phone === o.clientPhone);
      const bike = (db.bikes || []).find((b) => b.number === o.bikeNumber);
      const agreed = (o.items || []).filter((it) => it.agreed);
      const parts = agreed.flatMap((it) => (it.parts || []).map((p) => ({
        sku: p.sku || "", name: p.name,
        qty: (p.qty || 1) * (it.quantityMode === "instances" ? (it.qty || 1) : 1),
      })));
      const laborSum = agreed.reduce((s, it) => s + itemWorkValue(it), 0);
      return {
        number: o.number,
        handedOverAt: o.handedOverAt,
        clientName: client?.name || "",
        clientPhone: o.clientPhone,
        bikeName: bike?.name || "",
        parts,
        laborSum,
        exportedTo1C: !!o.exportedTo1C,
      };
    });
}
