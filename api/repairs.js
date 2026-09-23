// Неисправности, которые администратор добавляет вручную прямо на экране
// диагностики (без .proc-процедуры) — у каждой сразу своя цена, время и
// усложнения, привязка только к узлу (group = id блока диагностики).
// Смотреть могут все вошедшие, добавлять/менять/удалять — только администратор.
// Хранится одним списком в Upstash Redis, общий для всех.

import { redis, readBody, requireUser, requireAdmin } from "./_lib.js";

const KEY = "vella:repairs";
const loadStore = async (r) => (await r.get(KEY)) || { items: [] };
const sanitizeComplications = (list) =>
  Array.isArray(list)
    ? list.map((c) => ({ label: String(c.label || "").trim(), add: Number(c.add) || 0, addMinutes: Number(c.addMinutes) || 0, multiple: !!c.multiple })).filter((c) => c.label)
    : [];
const sanitizeQuantityMode = (value, legacyMultiple = false) =>
  ["single", "instances", "quantity"].includes(value) ? value : (legacyMultiple ? "quantity" : "single");

export default async function handler(req, res) {
  const r = redis();
  if (!r) return res.status(503).json({ error: "storage not configured" });

  if (req.method === "GET") {
    if (!requireUser(req, res)) return;
    const store = await loadStore(r);
    return res.status(200).json(store);
  }

  if (req.method === "POST") {
    if (!requireAdmin(req, res)) return;
    const body = readBody(req);
    const label = String(body.label || "").trim();
    if (!label) return res.status(400).json({ error: "укажите название" });
    const item = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      group: String(body.group || "").trim(),
      label,
      price: Number(body.price) || 0,
      minutes: Number(body.minutes) || 0,
      complications: sanitizeComplications(body.complications),
      quantityMode: sanitizeQuantityMode(body.quantityMode, body.multiple),
      maxInstances: body.quantityMode === "instances" ? Math.max(0, Number(body.maxInstances) || 0) : 0,
    };
    const store = await loadStore(r);
    store.items.push(item);
    await r.set(KEY, store);
    return res.status(200).json({ item, items: store.items });
  }

  if (req.method === "PUT") {
    if (!requireAdmin(req, res)) return;
    const body = readBody(req);
    const store = await loadStore(r);
    const it = store.items.find((x) => x.id === body.id);
    if (!it) return res.status(404).json({ error: "не найдено" });
    if (body.label != null) it.label = String(body.label).trim();
    if (body.price != null) it.price = Number(body.price) || 0;
    if (body.minutes != null) it.minutes = Number(body.minutes) || 0;
    if (body.complications != null) it.complications = sanitizeComplications(body.complications);
    if (body.quantityMode != null || body.multiple != null) {
      it.quantityMode = sanitizeQuantityMode(body.quantityMode, body.multiple);
      delete it.multiple;
    }
    if (body.maxInstances != null) it.maxInstances = it.quantityMode === "instances" ? Math.max(0, Number(body.maxInstances) || 0) : 0;
    await r.set(KEY, store);
    return res.status(200).json({ item: it, items: store.items });
  }

  if (req.method === "DELETE") {
    if (!requireAdmin(req, res)) return;
    const body = readBody(req);
    const store = await loadStore(r);
    store.items = store.items.filter((x) => x.id !== body.id);
    await r.set(KEY, store);
    return res.status(200).json({ ok: true, items: store.items });
  }

  return res.status(405).json({ error: "method not allowed" });
}
