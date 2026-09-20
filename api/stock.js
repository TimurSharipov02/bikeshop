// Остатки по запчастям. Пока без прямой связи с 1С — список правится вручную
// в админке или заменяется целиком вставкой выгрузки (см. web/app.js).
// Смотреть могут все вошедшие, менять — только администратор.

import { redis, readBody, requireUser, requireAdmin } from "./_lib.js";

const KEY = "vella:stock";

export default async function handler(req, res) {
  const r = redis();
  if (!r) return res.status(503).json({ error: "storage not configured" });

  if (req.method === "GET") {
    if (!requireUser(req, res)) return;
    const store = (await r.get(KEY)) || { items: [], updatedAt: null };
    return res.status(200).json(store);
  }

  if (req.method === "PUT") {
    if (!requireAdmin(req, res)) return;
    const body = readBody(req);
    const items = Array.isArray(body.items)
      ? body.items
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
    const store = { items, updatedAt: new Date().toISOString() };
    await r.set(KEY, store);
    return res.status(200).json(store);
  }

  return res.status(405).json({ error: "method not allowed" });
}
