// Обмен с кассой УНФ: 1С получает готовое обращение до оплаты и сообщает
// результат только после успешного оформления оплаты и фискального чека.
// Включается лишь после установки обработки на кассе: INTEGRATION_1C_CHECKOUT=1.
import { createHmac } from "node:crypto";
import { readBody } from "./_lib.js";
import { dbRedis, loadDB, updateDB } from "./_atomic-db.js";
import { checkKey, keyConfigured } from "./_1c-auth.js";
import { serviceBarcodesByMaster } from "./_1c-service-barcodes.js";
import { orderAllDone, orderRange } from "../web/order-calc.js";
import { orderFor1C } from "../web/pricing.js";

const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const money = (amount) => Math.round(Number(amount) * 100);
// Список УНФ показывает ФД с ведущими нулями, а копия чека без них.
// Нормализация нужна и для повтора POST, и для защиты от второго обращения.
const decimalId = (value) => String(value).replace(/^0+(?=\d)/, "");
const receiptKey = (r) => `${r.fn}:${decimalId(r.fd)}:${decimalId(r.fp)}`;

function quote(db, order, barcodesByMaster) {
  const value = orderFor1C(db, order, { barcodesByMaster });
  const range = orderRange(order);
  if (range.min !== range.max || !Number.isFinite(value.total) || money(range.min) !== money(value.total)) {
    throw error("сумма обращения не определена однозначно");
  }
  if (value.laborLines.some((line) => !line.masterName || !line.serviceBarcode)) {
    throw error("для каждой оплачиваемой работы нужен мастер со штрихкодом услуги 1С");
  }
  const quoteId = createHmac("sha256", process.env.INTEGRATION_1C_KEY)
    .update(JSON.stringify(value)).digest("hex");
  return { ...value, quoteId };
}

export default async function handler(req, res, r = dbRedis()) {
  if (!r) return res.status(503).json({ error: "storage not configured" });
  const checkoutEnabled = process.env.INTEGRATION_1C_CHECKOUT === "1";
  const previewEnabled = process.env.INTEGRATION_1C_PREVIEW === "1";
  if (!keyConfigured() || (!checkoutEnabled && !(req.method === "GET" && previewEnabled))) {
    return res.status(503).json({ error: "подтверждение оплаты через 1С не включено" });
  }
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "method not allowed" });
  const body = req.method === "POST" ? readBody(req) : {};
  if (!checkKey(req.headers?.["x-1c-key"] || body.key)) return res.status(401).json({ error: "неверный ключ" });
  const number = String(req.method === "GET" ? req.query?.number || "" : body.number || "").trim();
  if (!number) return res.status(400).json({ error: "не указан номер обращения" });

  try {
    const barcodesByMaster = await serviceBarcodesByMaster(r);
    if (req.method === "GET") {
      const { data: db } = await loadDB(r);
      const order = (db.orders || []).find((o) => o.number === number);
      if (!order || order.handedOverAt || !orderAllDone(order)) throw error("обращение не готово к оплате", 409);
      return res.status(200).json({ order: quote(db, order, barcodesByMaster) });
    }

    const receipt = body.receipt || {};
    const fiscal = {
      fn: String(receipt.fn || "").trim(), fd: decimalId(String(receipt.fd || "").trim()),
      fp: decimalId(String(receipt.fp || "").trim()),
    };
    if (!/^\d{16}$/.test(fiscal.fn) || !/^\d{1,10}$/.test(fiscal.fd) || !/^\d{1,10}$/.test(fiscal.fp) ||
        !/^[a-f0-9]{64}$/.test(String(body.quoteId || "")) ||
        !Number.isFinite(Number(body.total)) || money(body.total) < 0) {
      return res.status(400).json({ error: "нужны точная сумма, идентификатор расчёта и реквизиты фискального чека (fn, fd, fp)" });
    }

    let result;
    await updateDB(r, (db) => {
      const next = structuredClone(db);
      const order = (next.orders || []).find((o) => o.number === number);
      if (!order) throw error("обращение не найдено", 404);
      const key = receiptKey(fiscal);
      if ((next.orders || []).some((o) => o.number !== number && o.fiscalReceipt && receiptKey(o.fiscalReceipt) === key)) {
        throw error("этот фискальный чек уже привязан к другому обращению", 409);
      }
      if (order.handedOverAt) {
        if (order.fiscalReceipt && receiptKey(order.fiscalReceipt) === key &&
            money(order.paidTotal) === money(body.total) && order.paymentQuoteId === body.quoteId) {
          result = { ok: true, alreadyConfirmed: true, handedOverAt: order.handedOverAt };
          return next;
        }
        throw error("обращение уже выдано с другой оплатой", 409);
      }
      if (!orderAllDone(order)) throw error("работы в обращении ещё не завершены", 409);
      const currentQuote = quote(next, order, barcodesByMaster);
      if (currentQuote.quoteId !== body.quoteId || money(currentQuote.total) !== money(body.total)) {
        throw error("состав или сумма обращения изменились: сверяйте кассу до подтверждения", 409);
      }
      order.status = "выдан";
      order.occupiedBy = null;
      order.occupiedByName = "";
      order.handedOverAt = new Date().toISOString();
      order.paidTotal = currentQuote.total;
      order.paymentQuoteId = currentQuote.quoteId;
      order.fiscalReceipt = fiscal;
      // Чек уже создан в 1С: не передаём тот же заказ повторно через
      // старую послевыданную выгрузку /api/1c-export.
      order.exportedTo1C = true;
      result = { ok: true, alreadyConfirmed: false, handedOverAt: order.handedOverAt };
      return next;
    });
    return res.status(200).json(result);
  } catch (e) {
    return res.status(e.statusCode || 500).json({ error: String(e.message || e) });
  }
}
