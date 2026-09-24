// Переопределения встроенных работ каталога (из catalog/*.proc + prices.json) —
// администратор может переименовать, поправить цену/усложнения или вовсе
// скрыть работу, не трогая код. Хранится одним документом в Upstash Redis,
// общее для всех пользователей, живёт поверх статического каталога.
//
// byCode: { "WHL-05": { name?, price?, minutes?, complications?, hidden?, quantityMode?, maxInstances? } }
// quantityMode: single — одна работа; instances — отдельные одинаковые
// задачи; quantity — одна задача с числовым количеством. multiple остаётся
// только у усложнений и означает числовое количество самого усложнения.
// Присутствует только то, что реально переопределено; null-поле в PUT —
// сброс конкретного поля к значению по умолчанию.

import { redis, readBody, requireUser, requireAdmin } from "./_lib.js";

const KEY = "vella:overrides";
const WORK_INSTANCE_LIMIT = 5;
const loadStore = async (r) => (await r.get(KEY)) || { byCode: {} };

function sanitizeComplications(list) {
  return Array.isArray(list)
    ? list.map((c) => ({ label: String(c.label || "").trim(), add: Number(c.add) || 0, addMinutes: Number(c.addMinutes) || 0, multiple: !!c.multiple })).filter((c) => c.label)
    : undefined;
}
const sanitizeQuantityMode = (value) => ["single", "instances", "quantity"].includes(value) ? value : "single";

export default async function handler(req, res) {
  const r = redis();
  if (!r) return res.status(503).json({ error: "storage not configured" });

  if (req.method === "GET") {
    if (!(await requireUser(req, res))) return;
    const store = await loadStore(r);
    return res.status(200).json(store);
  }

  if (req.method === "PUT") {
    if (!(await requireAdmin(req, res))) return;
    const body = readBody(req);
    const code = String(body.code || "").trim();
    if (!code) return res.status(400).json({ error: "не указан код работы" });
    const store = await loadStore(r);
    const entry = { ...(store.byCode[code] || {}) };

    const setOrClear = (key, val, transform = (v) => v) => {
      if (val === null) delete entry[key];
      else if (val !== undefined) entry[key] = transform(val);
    };
    setOrClear("name", body.name, (v) => String(v).trim());
    setOrClear("price", body.price, (v) => Number(v) || 0);
    setOrClear("minutes", body.minutes, (v) => Number(v) || 0);
    setOrClear("complications", body.complications, sanitizeComplications);
    setOrClear("hidden", body.hidden, (v) => !!v);
    setOrClear("quantityMode", body.quantityMode, sanitizeQuantityMode);
    if (body.quantityMode === null) delete entry.maxInstances;
    else if (body.quantityMode !== undefined) entry.maxInstances = sanitizeQuantityMode(body.quantityMode) === "instances" ? WORK_INSTANCE_LIMIT : 0;

    if (Object.keys(entry).length === 0) delete store.byCode[code];
    else store.byCode[code] = entry;
    await r.set(KEY, store);
    return res.status(200).json(store);
  }

  if (req.method === "DELETE") {
    if (!(await requireAdmin(req, res))) return;
    const body = readBody(req);
    const code = String(body.code || "").trim();
    const store = await loadStore(r);
    delete store.byCode[code];
    await r.set(KEY, store);
    return res.status(200).json(store);
  }

  return res.status(405).json({ error: "method not allowed" });
}
