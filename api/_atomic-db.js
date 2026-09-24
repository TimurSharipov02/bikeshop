import { redis } from "./_lib.js";

export const KEY = "vella:db";
const VERSION = "vella:db:version";
export const empty = () => ({ clients: [], bikes: [], orders: [], counters: { order: 0, bike: 0 } });
const CAS = `
  local version = tonumber(redis.call('GET', KEYS[2]) or '0')
  if version ~= tonumber(ARGV[1]) then return 0 end
  redis.call('SET', KEYS[1], ARGV[2])
  redis.call('INCR', KEYS[2])
  return 1
`;

export function dbRedis() { return redis(); }
export async function loadDB(r) {
  const [raw, version] = await r.eval(
    "return { redis.call('GET', KEYS[1]) or '', redis.call('GET', KEYS[2]) or '0' }",
    [KEY, VERSION], []);
  return { data: raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : empty(), version: Number(version) || 0 };
}
export async function updateDB(r, transform) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const { data, version } = await loadDB(r);
    const next = transform(data);
    const ok = await r.eval(CAS, [KEY, VERSION], [String(version), JSON.stringify(next)]);
    if (Number(ok) === 1) return next;
  }
  throw new Error("Слишком много одновременных изменений, повторите попытку");
}
