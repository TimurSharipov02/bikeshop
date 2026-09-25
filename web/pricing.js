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

// Считано сканером с существующих кассовых карточек услуг. Настройка
// конкретного сотрудника в админке имеет приоритет над этим соответствием.
const knownServiceBarcodes = {
  "тимур": "2000999796289",
  "эльнар": "2000999806483",
  "сергей": "2000999796371",
};

// Обращения, готовые к выгрузке в 1С: выданные клиенту и ещё не забранные
// предыдущим запросом (или все выданные, если all). Общая форма для двух
// вызывающих: api/1c-export.js (по секретному ключу, для самой 1С) и
// api/1c-sync.js (по логину администратора — ручная сверка/очистка списка
// на сайте, когда что-то уже занесено в 1С другим путём).
export function orderFor1C(db, o, { barcodesByMaster = {} } = {}) {
  const client = (db.clients || []).find((c) => c.phone === o.clientPhone);
  const bike = (db.bikes || []).find((b) => b.number === o.bikeNumber);
  const agreed = (o.items || []).filter((it) => it.agreed);
  const parts = agreed.flatMap((it) => (it.parts || []).map((p) => ({
    sku: p.sku || "", name: p.name,
    qty: (p.qty || 1) * (it.quantityMode === "instances" ? (it.qty || 1) : 1),
    price: p.price || 0,
  })));
  // На кассе у каждого мастера отдельная услуга со своим штрихкодом.
  // Суммируем именно стоимость работ исполнителя, без стоимости деталей.
  const byMaster = new Map();
  for (const it of agreed) {
    const masterId = it.doneBy?.masterId || "";
    const masterName = it.doneBy?.masterName || "";
    const key = masterId || `name:${masterName}`;
    const line = byMaster.get(key) || {
      masterId, masterName,
      serviceBarcode: barcodesByMaster[masterId] || knownServiceBarcodes[masterName.trim().toLocaleLowerCase("ru-RU")] || "",
      amount: 0,
    };
    line.amount += itemWorkValue(it);
    byMaster.set(key, line);
  }
  const laborLines = [...byMaster.values()].filter((line) => line.amount !== 0);
  const laborSum = agreed.reduce((s, it) => s + itemWorkValue(it), 0);
  // Старые позиции могут содержать цену запчастей одной суммой без
  // номенклатуры. Их нельзя молча терять при передаче оплаты в 1С.
  const unallocatedPartsSum = agreed.reduce((s, it) =>
    s + (it.partsPrice || 0) * (it.quantityMode === "instances" ? (it.qty || 1) : 1), 0);
  const partsSum = parts.reduce((s, p) => s + p.qty * p.price, 0) + unallocatedPartsSum;
  return {
    number: o.number,
    handedOverAt: o.handedOverAt,
    clientName: client?.name || "",
    clientPhone: o.clientPhone,
    bikeName: bike?.name || "",
    parts,
    laborLines,
    laborSum,
    partsSum,
    unallocatedPartsSum,
    total: laborSum + partsSum,
    exportedTo1C: !!o.exportedTo1C,
  };
}

export function pendingExportOrders(db, { all = false, barcodesByMaster = {} } = {}) {
  return (db.orders || [])
    .filter((o) => o.handedOverAt && (all || !o.exportedTo1C))
    .map((o) => orderFor1C(db, o, { barcodesByMaster }));
}
