// Переопределения встроенных работ каталога (из catalog/*.proc + prices.json) —
// администратор может переименовать, поправить цену/связанные работы или
// вовсе скрыть работу, не трогая код. Хранится одним документом в Upstash
// Redis, общее для всех пользователей, живёт поверх статического каталога.
//
// byCode: { "WHL-05": { name?, price?, minutes?, relatedWorks?, hidden?, multiple? } }
// multiple — работу можно делать несколько раз на одном велосипеде (два
// колеса, несколько спиц и т.п.): при добавлении в наряд можно увеличивать
// количество. relatedWorks — id работ из vella:repairs (см. repairs.js),
// которые можно быстро добавить «из» этой работы (усложнение — по сути та
// же самая работа, просто обычно нужная вместе с этой, см. миграцию ниже).
// Присутствует только то, что реально переопределено; null-поле в PUT —
// сброс конкретного поля к значению по умолчанию.

import { redis, readBody, requireUser, requireAdmin } from "./_lib.js";

const KEY = "vella:overrides";
const REPAIRS_KEY = "vella:repairs";
const loadStore = async (r) => (await r.get(KEY)) || { byCode: {} };

function sanitizeRelatedWorks(list) {
  return Array.isArray(list) ? [...new Set(list.map((x) => String(x || "").trim()).filter(Boolean))] : undefined;
}

// Усложнения раньше вписывались вручную прямо в переопределение работы
// ({label, add, addMinutes, multiple}) — задваивались, если одно и то же
// усложнение нужно было для нескольких разных работ. От этого отказались:
// каждое усложнение превращается в отдельную позицию в vella:repairs и
// связывается через relatedWorks. Запускается один раз (см.
// store.migratedRelatedWorks), трогает оба хранилища атомарно в рамках
// одного запроса.
async function migrateComplications(r, store) {
  if (store.migratedRelatedWorks) return false;
  const codes = Object.keys(store.byCode).filter((c) => store.byCode[c].complications?.length);
  if (!codes.length) { store.migratedRelatedWorks = true; return true; }
  const repairsStore = (await r.get(REPAIRS_KEY)) || { items: [] };
  const additions = [];
  for (const code of codes) {
    const entry = store.byCode[code];
    const related = new Set(entry.relatedWorks || []);
    for (const c of entry.complications) {
      additions.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${additions.length}`,
        group: "", label: String(c.label || "").trim(),
        price: Number(c.add) || 0, minutes: Number(c.addMinutes) || 0,
        multiple: !!c.multiple, relatedWorks: [],
      });
      related.add(additions[additions.length - 1].id);
    }
    entry.relatedWorks = [...related];
    delete entry.complications;
  }
  repairsStore.items.push(...additions);
  await r.set(REPAIRS_KEY, repairsStore);
  store.migratedRelatedWorks = true;
  return true;
}

export default async function handler(req, res) {
  const r = redis();
  if (!r) return res.status(503).json({ error: "storage not configured" });

  if (req.method === "GET") {
    if (!requireUser(req, res)) return;
    const store = await loadStore(r);
    if (await migrateComplications(r, store)) await r.set(KEY, store);
    return res.status(200).json(store);
  }

  if (req.method === "PUT") {
    if (!requireAdmin(req, res)) return;
    const body = readBody(req);
    const code = String(body.code || "").trim();
    if (!code) return res.status(400).json({ error: "не указан код работы" });
    const store = await loadStore(r);
    await migrateComplications(r, store);
    const entry = { ...(store.byCode[code] || {}) };

    const setOrClear = (key, val, transform = (v) => v) => {
      if (val === null) delete entry[key];
      else if (val !== undefined) entry[key] = transform(val);
    };
    setOrClear("name", body.name, (v) => String(v).trim());
    setOrClear("price", body.price, (v) => Number(v) || 0);
    setOrClear("minutes", body.minutes, (v) => Number(v) || 0);
    setOrClear("relatedWorks", body.relatedWorks, sanitizeRelatedWorks);
    setOrClear("hidden", body.hidden, (v) => !!v);
    setOrClear("multiple", body.multiple, (v) => !!v);

    if (Object.keys(entry).length === 0) delete store.byCode[code];
    else store.byCode[code] = entry;
    await r.set(KEY, store);
    return res.status(200).json(store);
  }

  if (req.method === "DELETE") {
    if (!requireAdmin(req, res)) return;
    const body = readBody(req);
    const code = String(body.code || "").trim();
    const store = await loadStore(r);
    delete store.byCode[code];
    await r.set(KEY, store);
    return res.status(200).json(store);
  }

  return res.status(405).json({ error: "method not allowed" });
}
