// Ручная сверка с 1С прямо из админки сайта (вход по обычному логину
// администратора, без секретного ключа INTEGRATION_1C_KEY). Нужно, когда
// часть выданных обращений уже занесена в 1С другим путём (например,
// вручную, до того как заработала автоматическая выгрузка — см.
// api/1c-export.js) и нужно один раз пометить их как выгруженные, чтобы
// автоматика потом не притащила их ещё раз.
//
// GET  — список обращений, ещё не помеченных выгруженными.
// POST — пометить ВСЕ текущие невыгруженные обращения выгруженными
//        (список пересчитывается заново на сервере, а не берётся из
//        того, что когда-то показал GET — так безопаснее, если между
//        просмотром и подтверждением кто-то выдал ещё один заказ).

import { requireAdmin } from "./_lib.js";
import { dbRedis, loadDB, updateDB } from "./_atomic-db.js";
import { pendingExportOrders } from "../web/pricing.js";

export default async function handler(req, res, r = dbRedis()) {
  if (!r) return res.status(503).json({ error: "storage not configured" });
  const user = await requireAdmin(req, res, r);
  if (!user) return;

  if (req.method === "GET") {
    const { data: db } = await loadDB(r);
    return res.status(200).json({ orders: pendingExportOrders(db) });
  }

  if (req.method === "POST") {
    try {
      let marked = 0;
      await updateDB(r, (current) => {
        const db = structuredClone(current);
        marked = 0;
        for (const o of db.orders || []) {
          if (o.handedOverAt && !o.exportedTo1C) { o.exportedTo1C = true; marked++; }
        }
        return db;
      });
      return res.status(200).json({ ok: true, marked });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  }

  return res.status(405).json({ error: "method not allowed" });
}
