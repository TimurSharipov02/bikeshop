// Поиск по словам: каждое слово запроса должно встретиться в тексте, в любом
// порядке и в любом месте — «maxxis 700x30» находит «MAXXIS Pursuer 700x30».
// Регистр, «ё»/«е», знаки препинания и кириллическая «х» в размерах вида
// «700х30» не важны.
export function normalizeSearch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/(\d)\s*[хx×]\s*(?=\d)/g, "$1x")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
export function matchesQuery(query, ...fields) {
  const words = normalizeSearch(query).split(" ").filter(Boolean);
  if (!words.length) return true;
  const hay = normalizeSearch(fields.filter(Boolean).join(" "));
  return words.every((w) => hay.includes(w));
}
