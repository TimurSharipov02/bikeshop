import { MergeConflict } from "./_db-merge.js";

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Check the proposed merged state on each CAS attempt, so a stale client
// cannot edit a work item claimed by a different master.
export function assertWorkAccess(current, merged, user) {
  // Paid orders are an accounting record. This applies to administrators too,
  // and also catches deletion through the ordinary snapshot merge.
  for (const previous of current.orders || []) {
    if (previous.status !== "выдан" && !previous.handedOverAt) continue;
    const next = (merged.orders || []).find((order) => order.number === previous.number);
    if (!same(previous, next)) throw new MergeConflict(`оплаченное обращение ${previous.number} нельзя изменять`);
  }
  for (const order of merged.orders || []) {
    const previous = (current.orders || []).find((o) => o.number === order.number);
    if (!previous) continue;
    const oldItems = new Map((previous.items || []).map((item) => [item.code, item]));
    const newItems = new Map((order.items || []).map((item) => [item.code, item]));
    for (const old of previous.items || []) {
      const next = newItems.get(old.code);
      if (same(old, next)) continue;
      if (previous.status === "взята в работу" && old.agreed && user.role !== "admin") {
        const releasingDone = old.done && next && !next.done && !next.doneBy && !next.claimedBy && !next.waitingForPart &&
          Object.keys(old).every((key) => ["done", "doneBy", "claimedBy", "waitingForPart"].includes(key) || same(old[key], next[key]));
        if (releasingDone && old.doneBy?.masterId === user.uid) continue;
        if (old.done && next && !next.done && old.doneBy?.masterId !== user.uid) {
          throw new MergeConflict(`снять отметку может только исполнитель работы «${old.name}»`);
        }
        if (old.claimedBy?.masterId && old.claimedBy.masterId !== user.uid) {
          throw new MergeConflict(`работа «${old.name}» закреплена за другим мастером`);
        }
        if (next && next.claimedBy?.masterId !== (old.claimedBy?.masterId || user.uid)) {
          throw new MergeConflict(`работа «${old.name}» должна быть закреплена за вами`);
        }
        if (next?.done && !old.done && next.doneBy?.masterId !== user.uid) {
          throw new MergeConflict(`исполнитель работы «${old.name}» не совпадает с текущим мастером`);
        }
      }
    }
    if (previous.status === "взята в работу" && user.role !== "admin") {
      for (const item of order.items || []) {
        if (!oldItems.has(item.code) && item.claimedBy?.masterId && item.claimedBy.masterId !== user.uid) {
          throw new MergeConflict(`работа «${item.name}» закреплена за другим мастером`);
        }
      }
    }
    if (previous.status === "взята в работу" && order.status === "выдан") {
      if (!order.items?.length || order.items.some((item) => !item.agreed || !item.done)) {
        throw new MergeConflict("нельзя выдать заявку с незавершёнными работами");
      }
    }
  }
}
