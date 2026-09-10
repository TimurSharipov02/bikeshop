// Простое файловое хранилище на этапе консоли: data/db.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyDB, type DB } from "./domain.ts";

const DB_PATH = fileURLToPath(new URL("../data/db.json", import.meta.url));

export function loadDB(path = DB_PATH): DB {
  if (!existsSync(path)) return emptyDB();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<DB>;
    const db = emptyDB();
    return {
      clients: raw.clients ?? db.clients,
      bikes: raw.bikes ?? db.bikes,
      orders: raw.orders ?? db.orders,
      counters: { ...db.counters, ...(raw.counters ?? {}) },
    };
  } catch {
    return emptyDB();
  }
}

export function saveDB(db: DB, path = DB_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(db, null, 2), "utf8");
}
