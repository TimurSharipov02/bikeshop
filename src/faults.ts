// Справочник типовых неисправностей (catalog/faults.json).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface Fault {
  label: string;
  code: string; // код операции из каталога; "" — привязки нет
  note?: string;
}

export interface FaultGroup {
  id: string;
  title: string;
  faults: Fault[];
}

export interface FaultCatalog {
  groups: FaultGroup[];
  byId: Map<string, FaultGroup>;
}

const PATH = fileURLToPath(new URL("../catalog/faults.json", import.meta.url));

export function loadFaults(path = PATH): FaultCatalog {
  const raw = JSON.parse(readFileSync(path, "utf8")) as { groups: FaultGroup[] };
  const groups = raw.groups ?? [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  return { groups, byId };
}
