// Общее хранилище данных мастерской — одна серверная функция на Vercel.
// Держит весь набор данных (клиенты, велосипеды, обращения) одним JSON
// в Upstash Redis. При записи сливает изменения, чтобы правки с разных
// устройств не затирали друг друга.
//
// Переменные окружения приходят автоматически при подключении Upstash
// через Vercel Marketplace (UPSTASH_REDIS_REST_URL / _TOKEN, либо KV_*).

import { Redis } from "@upstash/redis";
import { requireUser } from "./_lib.js";

const KEY = "vella:db";
const empty = () => ({ clients: [], bikes: [], orders: [], counters: { order: 0, bike: 0 } });

function redis() {
  // поддержим оба набора имён, которые ставит Vercel
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function mergeDB(a, b) {
  const index = (list, k) => new Map((list || []).map((x) => [x[k], x]));
  const clients = index(a.clients, "phone");
  for (const c of b.clients || []) clients.set(c.phone, c);
  const bikes = index(a.bikes, "number");
  for (const x of b.bikes || []) bikes.set(x.number, x);
  const orders = index(a.orders, "number");
  for (const o of b.orders || []) orders.set(o.number, o);
  return {
    clients: [...clients.values()],
    bikes: [...bikes.values()],
    orders: [...orders.values()],
    counters: {
      order: Math.max(a.counters?.order || 0, b.counters?.order || 0),
      bike: Math.max(a.counters?.bike || 0, b.counters?.bike || 0),
    },
  };
}

export default async function handler(req, res) {
  const r = redis();
  if (!r) return res.status(503).json({ error: "storage not configured" });
  if (!requireUser(req, res)) return;

  try {
    if (req.method === "GET") {
      const db = (await r.get(KEY)) || empty();
      return res.status(200).json(db);
    }
    if (req.method === "PUT" || req.method === "POST") {
      const incoming = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const current = (await r.get(KEY)) || empty();
      const merged = mergeDB(current, incoming);
      await r.set(KEY, merged);
      return res.status(200).json(merged);
    }
    if (req.method === "DELETE") {
      // Удаление — отдельно от PUT-слияния выше: слияние всегда берёт
      // объединение обеих сторон, так что пропавшее в несущей записи
      // стороне не удалилось бы на сервере (вернулось бы обратно при
      // следующем же merge-пуше). Тут просто убираем по ключу.
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const current = (await r.get(KEY)) || empty();
      const number = String(body.number || "").trim();
      const clientPhone = String(body.clientPhone || "").trim();
      const bikeNumber = String(body.bikeNumber || "").trim();
      if (number) {
        current.orders = (current.orders || []).filter((o) => o.number !== number);
      } else if (clientPhone) {
        current.clients = (current.clients || []).filter((c) => c.phone !== clientPhone);
        current.bikes = (current.bikes || []).filter((b) => b.ownerPhone !== clientPhone);
      } else if (bikeNumber) {
        current.bikes = (current.bikes || []).filter((b) => b.number !== bikeNumber);
      } else {
        return res.status(400).json({ error: "не указано, что удалить" });
      }
      await r.set(KEY, current);
      return res.status(200).json(current);
    }
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message ? e.message : e) });
  }
}
