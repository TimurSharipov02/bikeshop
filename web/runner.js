// Старый каталог процедур ранней версии приложения (catalog/*.proc) — сам
// пошаговый раннер по нему удалён (нигде в интерфейсе не открывался), но
// buildCatalog() всё ещё нужен: cat.byCode используют codeRange/priceOf и
// экран «Пройти диагностику» на приёме, пока он не переведён на новый
// каталог работ (catalog/repairs, админка).
export function buildCatalog(procedures) {
  const byCode = new Map();
  for (const p of procedures) if (p.code) byCode.set(p.code, p);
  return { procedures, byCode };
}
