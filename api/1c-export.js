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
//      переписку/CLAUDE.md про интеграцию).
// POST {key, numbers:[...]} — пометить обращения выгруженными, чтобы не
//      прислать их снова при следующем запросе.

import { redis, readBody } from "./_lib.js";

const KEY = "vella:db";
const empty = () => ({ clients: [], bikes: [], orders: [], counters: { order: 0, bike: 0 } });

function checkKey(provided) {
  const expected = process.env.INTEGRATION_1C_KEY;
  return !!expected && provided === expected;
}

// Та же формула, что itemWorkValue в web/app.js — стоимость самой работы
// (без запчастей): цена работы за все единицы плюс подтвердившиеся
// усложнения. Отдельный серверный файл без доступа к общему модулю
// приложения — держать в синхроне вручную при правке той функции.
function itemWorkValue(it) {
  let v = (it.workPrice || 0) * (it.qty || 1);
  for (const d of it.difficulties || []) if (d.state === "yes") v += (d.add || 0) * (d.qty || 1);
  return v;
}

export default async function handler(req, res) {
  const r = redis();
  if (!r) return res.status(503).json({ error: "storage not configured" });
  if (!process.env.INTEGRATION_1C_KEY) return res.status(503).json({ error: "интеграция с 1С не настроена (нет INTEGRATION_1C_KEY)" });

  if (req.method === "GET") {
    if (!checkKey(req.query?.key)) return res.status(401).json({ error: "неверный ключ" });
    const db = (await r.get(KEY)) || empty();
    const orders = (db.orders || [])
      .filter((o) => o.handedOverAt && !o.exportedTo1C)
      .map((o) => {
        const client = (db.clients || []).find((c) => c.phone === o.clientPhone);
        const bike = (db.bikes || []).find((b) => b.number === o.bikeNumber);
        const agreed = (o.items || []).filter((it) => it.agreed);
        const parts = agreed.flatMap((it) => (it.parts || []).map((p) => ({ sku: p.sku || "", name: p.name, qty: p.qty || 1 })));
        const laborSum = agreed.reduce((s, it) => s + itemWorkValue(it), 0);
        return {
          number: o.number,
          handedOverAt: o.handedOverAt,
          clientName: client?.name || "",
          clientPhone: o.clientPhone,
          bikeName: bike?.name || "",
          parts,
          laborSum,
        };
      });
    return res.status(200).json({ orders });
  }

  if (req.method === "POST") {
    const body = readBody(req);
    if (!checkKey(body.key)) return res.status(401).json({ error: "неверный ключ" });
    const numbers = Array.isArray(body.numbers) ? body.numbers.map(String) : [];
    if (!numbers.length) return res.status(400).json({ error: "не указаны номера обращений" });
    const db = (await r.get(KEY)) || empty();
    let marked = 0;
    for (const o of db.orders || []) {
      if (numbers.includes(o.number) && !o.exportedTo1C) { o.exportedTo1C = true; marked++; }
    }
    await r.set(KEY, db);
    return res.status(200).json({ ok: true, marked });
  }

  return res.status(405).json({ error: "method not allowed" });
}
