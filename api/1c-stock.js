// Приём остатков по запчастям из 1С. 1С шлёт сюда POST (кнопкой
// «Отправить остатки на сайт» или по расписанию) с текущим полным списком
// остатков — тот же формат, что и ручной импорт в админке (web/app.js,
// экран «Запчасти»). Не завязано на сессию: дёргает не залогиненный
// пользователь, а сама 1С, поэтому авторизация тем же секретным ключом
// INTEGRATION_1C_KEY, что и у 1c-export.js (см. _1c-auth.js).
//
// POST {key, items:[{sku,name,qty,unit,price,group,maxQty}, ...], force?}
//   Полностью заменяет список остатков (как и ручной PUT/вставка в
//   админке) — 1С считается источником истины по остаткам, частичная
//   догрузка "только изменившееся" рисковала бы оставить на сайте
//   позиции, которых в 1С уже нет. Если после очистки/фильтрации список
//   пуст, а до этого остатки не были пустыми — отказываем и просим
//   повторить с {force:true}: пустая выгрузка почти всегда означает
//   ошибку на стороне 1С, а не то, что склад правда опустел.

import { readBody, redis } from "./_lib.js";
import { checkKey, keyConfigured } from "./_1c-auth.js";
import { STOCK_KEY, sanitizeStockItems } from "./stock.js";

export default async function handler(req, res, r = redis()) {
  if (!r) return res.status(503).json({ error: "storage not configured" });
  if (!keyConfigured()) return res.status(503).json({ error: "интеграция с 1С не настроена (нет INTEGRATION_1C_KEY)" });
  if (req.method !== "POST") return res.status(405).json({ error: "method not allowed" });

  const body = readBody(req);
  if (!checkKey(body.key)) return res.status(401).json({ error: "неверный ключ" });

  const items = sanitizeStockItems(body.items);
  if (!items.length && !body.force) {
    const existing = (await r.get(STOCK_KEY)) || { items: [] };
    if ((existing.items || []).length > 0) {
      return res.status(400).json({ error: "получен пустой список остатков — если это ожидаемо, повторите запрос с force: true" });
    }
  }
  const store = { items, updatedAt: new Date().toISOString(), source: "1c" };
  await r.set(STOCK_KEY, store);
  return res.status(200).json({ ok: true, count: items.length, updatedAt: store.updatedAt });
}
