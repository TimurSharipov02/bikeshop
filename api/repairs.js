// Неисправности, которые администратор добавляет вручную прямо на экране
// диагностики (без .proc-процедуры) — у каждой сразу своя цена, время и
// список связанных работ (relatedWorks — id других таких же неисправностей,
// которые можно быстро добавить «из» этой, см. миграцию ниже), привязка
// только к узлу (group = id блока диагностики). Смотреть могут все вошедшие,
// добавлять/менять/удалять — только администратор. Хранится одним списком в
// Upstash Redis, общий для всех.

import { redis, readBody, requireUser, requireAdmin } from "./_lib.js";

const KEY = "vella:repairs";
const loadStore = async (r) => (await r.get(KEY)) || { items: [] };
const sanitizeRelatedWorks = (list) =>
  Array.isArray(list) ? [...new Set(list.map((x) => String(x || "").trim()).filter(Boolean))] : [];

// Усложнения раньше жили вложенным списком {label, add, addMinutes, multiple}
// прямо в каждой работе — задваивались при наборе вручную для разных работ и
// не были отдельно отмечаемыми задачами. От этого отказались: усложнение —
// просто ещё одна работа, которую можно быстро добавить «из» родительской
// (см. relatedWorks и openRepairSheet на клиенте). При первом обращении к
// хранилищу после обновления каждое вложенное усложнение превращается в
// свою отдельную позицию и связывается через relatedWorks; повторно не
// запускается (store.migratedRelatedWorks).
function migrateComplications(store) {
  if (store.migratedRelatedWorks) return false;
  const additions = [];
  for (const it of store.items) {
    if (!it.complications?.length) continue;
    const related = new Set(it.relatedWorks || []);
    for (const c of it.complications) {
      additions.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${additions.length}`,
        group: it.group || "", label: String(c.label || "").trim(),
        price: Number(c.add) || 0, minutes: Number(c.addMinutes) || 0,
        multiple: !!c.multiple, relatedWorks: [],
      });
      related.add(additions[additions.length - 1].id);
    }
    it.relatedWorks = [...related];
    delete it.complications;
  }
  store.items.push(...additions);
  store.migratedRelatedWorks = true;
  return true;
}

export default async function handler(req, res) {
  const r = redis();
  if (!r) return res.status(503).json({ error: "storage not configured" });

  if (req.method === "GET") {
    if (!requireUser(req, res)) return;
    const store = await loadStore(r);
    if (migrateComplications(store)) await r.set(KEY, store);
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
      multiple: !!body.multiple,
      relatedWorks: sanitizeRelatedWorks(body.relatedWorks),
    };
    const store = await loadStore(r);
    migrateComplications(store);
    store.items.push(item);
    await r.set(KEY, store);
    return res.status(200).json({ item, items: store.items });
  }

  if (req.method === "PUT") {
    if (!requireAdmin(req, res)) return;
    const body = readBody(req);
    const store = await loadStore(r);
    migrateComplications(store);
    const it = store.items.find((x) => x.id === body.id);
    if (!it) return res.status(404).json({ error: "не найдено" });
    if (body.label != null) it.label = String(body.label).trim();
    if (body.price != null) it.price = Number(body.price) || 0;
    if (body.minutes != null) it.minutes = Number(body.minutes) || 0;
    if (body.multiple != null) it.multiple = !!body.multiple;
    if (body.relatedWorks != null) it.relatedWorks = sanitizeRelatedWorks(body.relatedWorks);
    await r.set(KEY, store);
    return res.status(200).json({ item: it, items: store.items });
  }

  if (req.method === "DELETE") {
    if (!requireAdmin(req, res)) return;
    const body = readBody(req);
    const store = await loadStore(r);
    migrateComplications(store);
    store.items = store.items.filter((x) => x.id !== body.id);
    // Убираем удалённую работу и из чужих relatedWorks — иначе там остаётся
    // ссылка в никуда.
    for (const it of store.items) {
      if (it.relatedWorks?.includes(body.id)) it.relatedWorks = it.relatedWorks.filter((id) => id !== body.id);
    }
    await r.set(KEY, store);
    return res.status(200).json({ ok: true, items: store.items });
  }

  return res.status(405).json({ error: "method not allowed" });
}
