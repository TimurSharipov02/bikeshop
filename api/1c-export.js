// Выгрузка для 1С: только уже выданные клиенту обращения, ещё не забранные
// предыдущим запросом. Отдельный секретный ключ (переменная окружения
// INTEGRATION_1C_KEY в Vercel) — эту ручку дёргает не залогиненный
// пользователь, а сама 1С кнопкой «Загрузить с сайта», поэтому не завязано
// на сессию/куки.
//
// GET  ?key=...        — список невыгруженных обращений: запчасти (по
//      артикулу sku — тому же, что и в остатках) и отдельно сумма за
//      работу (одним числом, без разбивки по видам работ — разбивка тут
//      не нужна, оплата труда мастеров идёт через кассу отдельно, см.
//      переписку/CLAUDE.md про интеграцию). С ?all=1 — вообще все выданные
//      обращения, включая уже выгруженные (для сверки, ничего не меняет).
// POST {key, numbers:[...]} — пометить обращения выгруженными, чтобы не
//      прислать их снова при следующем запросе.

import { readBody } from "./_lib.js";
import { dbRedis, loadDB, updateDB } from "./_atomic-db.js";
import { pendingExportOrders } from "../web/pricing.js";
import { checkKey, keyConfigured } from "./_1c-auth.js";

export default async function handler(req, res, r = dbRedis()) {
  if (!r) return res.status(503).json({ error: "storage not configured" });
  if (!keyConfigured()) return res.status(503).json({ error: "интеграция с 1С не настроена (нет INTEGRATION_1C_KEY)" });

  if (req.method === "GET") {
    if (!checkKey(req.query?.key)) return res.status(401).json({ error: "неверный ключ" });
    const { data: db } = await loadDB(r);
    const orders = pendingExportOrders(db, { all: req.query?.all === "1" });
    return res.status(200).json({ orders });
  }

  if (req.method === "POST") {
    const body = readBody(req);
    if (!checkKey(body.key)) return res.status(401).json({ error: "неверный ключ" });
    const numbers = Array.isArray(body.numbers) ? body.numbers.map(String) : [];
    if (!numbers.length) return res.status(400).json({ error: "не указаны номера обращений" });
    try {
      let marked = 0;
      await updateDB(r, (current) => {
        const db = structuredClone(current);
        marked = 0;
        for (const o of db.orders || []) {
          if (numbers.includes(o.number) && !o.exportedTo1C) { o.exportedTo1C = true; marked++; }
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
