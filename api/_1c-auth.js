// Общая проверка ключа интеграции с 1С. Один и тот же секрет
// (переменная окружения INTEGRATION_1C_KEY в Vercel) используют обе стороны
// обмена — выгрузка выполненных работ (1c-export.js) и приём остатков
// (1c-stock.js). Один ключ проще объяснить и хранить не-технической
// владелице магазина, чем два разных.

export function checkKey(provided) {
  const expected = process.env.INTEGRATION_1C_KEY;
  return !!expected && provided === expected;
}
export function keyConfigured() {
  return !!process.env.INTEGRATION_1C_KEY;
}
