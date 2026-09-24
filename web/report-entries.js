// Paid work is attributed to the day the order was handed over.
// Both chart columns and the history below use the same date.
export function reportEntries(orders, masterId, from = null, to = null) {
  const out = [];
  for (const order of orders) {
    if (!order.handedOverAt) continue;
    const at = new Date(order.handedOverAt);
    if (Number.isNaN(at.getTime()) || (from && at < from) || (to && at >= to)) continue;
    for (const item of order.items || []) {
      const doneBy = item.doneBy;
      if (!doneBy?.at || (masterId != null && doneBy.masterId !== masterId)) continue;
      out.push({ order, item, at });
    }
  }
  return out;
}
