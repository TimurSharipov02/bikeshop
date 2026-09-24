// Three-way merge: only fields changed relative to the client's last server
// snapshot are applied. Orders and their work items merge by stable keys.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = (x) => x !== null && typeof x === "object" && !Array.isArray(x);

export class MergeConflict extends Error {
  constructor(path) { super(`Данные изменены на другом устройстве: ${path}`); this.path = path; }
}

function mergeValue(base, next, current, path) {
  if (same(base, next)) return current;
  if (same(base, current) || same(next, current)) return next;
  if (object(base) && object(next) && object(current)) {
    const out = { ...current };
    for (const key of new Set([...Object.keys(base), ...Object.keys(next)])) {
      if (!Object.hasOwn(next, key) && Object.hasOwn(base, key)) {
        if (!same(base[key], current[key])) throw new MergeConflict(`${path}.${key}`);
        delete out[key];
      } else if (Object.hasOwn(next, key)) {
        out[key] = key === "items" && path.startsWith("orders.")
          ? mergeList(base[key] || [], next[key], current[key] || [], "code", `${path}.items`)
          : mergeValue(base[key], next[key], current[key], `${path}.${key}`);
      }
    }
    return out;
  }
  throw new MergeConflict(path);
}

function mergeList(base, next, current, key, path) {
  if (!Array.isArray(base) || !Array.isArray(next) || !Array.isArray(current)) throw new MergeConflict(path);
  const before = new Map(base.map((x) => [x[key], x]));
  const wanted = new Map(next.map((x) => [x[key], x]));
  const out = new Map(current.map((x) => [x[key], x]));
  if (before.size !== base.length || wanted.size !== next.length) throw new MergeConflict(path);
  for (const [id, old] of before) {
    if (wanted.has(id)) continue;
    if (!same(old, out.get(id))) throw new MergeConflict(`${path}.${id}`);
    out.delete(id);
  }
  for (const [id, value] of wanted) {
    const old = before.get(id);
    if (old === undefined) {
      if (out.has(id) && !same(out.get(id), value)) throw new MergeConflict(`${path}.${id}`);
      out.set(id, value);
    } else if (!same(old, value)) {
      if (!out.has(id)) throw new MergeConflict(`${path}.${id}`);
      out.set(id, mergeValue(old, value, out.get(id), `${path}.${id}`));
    }
  }
  return [...out.values()];
}

export function mergeDB(base, next, current) {
  if (!base || !next || !Array.isArray(base.orders) || !Array.isArray(next.orders)) throw new MergeConflict("снимок данных");
  return {
    ...current,
    clients: mergeList(base.clients || [], next.clients || [], current.clients || [], "phone", "clients"),
    bikes: mergeList(base.bikes || [], next.bikes || [], current.bikes || [], "number", "bikes"),
    orders: mergeList(base.orders, next.orders, current.orders || [], "number", "orders"),
    counters: current.counters || { order: 0, bike: 0 },
  };
}
