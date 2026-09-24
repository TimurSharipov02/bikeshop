// Остатки по запчастям. Пока без прямой связи с 1С — список правится вручную
// в админке или заменяется целиком вставкой выгрузки (см. web/app.js).
// Смотреть могут все вошедшие, менять — только администратор.

import { redis, readBody, requireUser, requireAdmin } from "./_lib.js";

export const STOCK_KEY = "vella:stock";

// Общее приведение полей позиции остатков — тем же пользуется и приём
// остатков от 1С (api/1c-stock.js), чтобы формат не разъезжался.
export function sanitizeStockItems(rawItems) {
  return Array.isArray(rawItems)
    ? rawItems
        .map((it) => ({
          sku: String(it.sku || "").trim(),
          name: String(it.name || "").trim(),
          qty: Number(it.qty) || 0,
          unit: String(it.unit || "").trim(),
          price: Number(it.price) || 0,
          group: String(it.group || "").trim(),
          maxQty: Number(it.maxQty) || 0,
        }))
        .filter((it) => it.sku || it.name)
    : [];
}

export default async function handler(req, res, r = redis()) {
  if (!r) return res.status(503).json({ error: "storage not configured" });

  if (req.method === "GET") {
    if (!(await requireUser(req, res))) return;
    const store = (await r.get(STOCK_KEY)) || { items: [], updatedAt: null };
    return res.status(200).json(store);
  }

  if (req.method === "PUT") {
    if (!(await requireAdmin(req, res))) return;
    const body = readBody(req);
    const items = sanitizeStockItems(body.items);
    const store = { items, updatedAt: new Date().toISOString(), source: "manual" };
    await r.set(STOCK_KEY, store);
    return res.status(200).json(store);
  }

  return res.status(405).json({ error: "method not allowed" });
}
