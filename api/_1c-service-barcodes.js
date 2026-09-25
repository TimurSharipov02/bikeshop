// Настроенные в админке штрихкоды услуг мастеров. Старые учётные записи
// без настройки используют кассовые карточки по имени (web/pricing.js).
export async function serviceBarcodesByMaster(redis) {
  const users = (await redis.get("vella:users"))?.users || [];
  return Object.fromEntries(users.filter((user) => user.serviceBarcode1C)
    .map((user) => [user.id, user.serviceBarcode1C]));
}
