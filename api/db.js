// Shared workshop data. Every mutation is a three-way merge against the
// client's last server snapshot and an atomic compare-and-swap in Redis.
import { requireUser } from "./_lib.js";
import { dbRedis, loadDB, updateDB } from "./_atomic-db.js";
import { mergeDB, MergeConflict } from "./_db-merge.js";
import { assertWorkAccess } from "./_work-access.js";

export default async function handler(req, res) {
  const r = dbRedis();
  if (!r) return res.status(503).json({ error: "storage not configured" });
  const user = await requireUser(req, res);
  if (!user) return;

  try {
    if (req.method === "GET") {
      const { data } = await loadDB(r);
      return res.status(200).json(data);
    }
    if (req.method === "PUT" || req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      if (!body.base || !body.next) return res.status(400).json({ error: "Обновите страницу перед сохранением" });
      const merged = await updateDB(r, (current) => {
        const next = mergeDB(body.base, body.next, current);
        assertWorkAccess(current, next, user);
        return next;
      });
      return res.status(200).json(merged);
    }
    if (req.method === "DELETE") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const number = String(body.number || "").trim();
      const clientPhone = String(body.clientPhone || "").trim();
      const bikeNumber = String(body.bikeNumber || "").trim();
      if (!number && !clientPhone && !bikeNumber) return res.status(400).json({ error: "не указано, что удалить" });
      const next = await updateDB(r, (current) => {
        const data = structuredClone(current);
        if (number) {
          const order = data.orders.find((o) => o.number === number);
          if (order && (order.status === "выдан" || order.handedOverAt)) {
            throw new MergeConflict(`оплаченное обращение ${number} нельзя удалять`);
          }
          data.orders = data.orders.filter((o) => o.number !== number);
        }
        else if (clientPhone) {
          data.clients = data.clients.filter((c) => c.phone !== clientPhone);
          data.bikes = data.bikes.filter((b) => b.ownerPhone !== clientPhone);
          // Каскад по явному запросу: вместе с клиентом — его обращения,
          // кроме выданных (оплаченных): по ним посчитан заработок мастеров
          // и выгрузка в 1С, их нельзя удалять и поодиночке (см. выше).
          if (body.withOrders) {
            data.orders = data.orders.filter((o) => o.clientPhone !== clientPhone || o.status === "выдан" || o.handedOverAt);
          }
        } else data.bikes = data.bikes.filter((b) => b.number !== bikeNumber);
        return data;
      });
      return res.status(200).json(next);
    }
    return res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    if (e instanceof MergeConflict) {
      const { data } = await loadDB(r);
      return res.status(409).json({ error: e.message, current: data });
    }
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
