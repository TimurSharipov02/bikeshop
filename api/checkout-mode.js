// Публичен только флаг режима. Секрет интеграции и данные обращений здесь не выдаём.
export default function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ enabled: process.env.INTEGRATION_1C_CHECKOUT === "1" });
}
