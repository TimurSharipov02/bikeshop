// Загрузка каталога процедур из catalog/*.proc

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalog, type Catalog } from "./model.ts";
import { parseProc } from "./dsl.ts";

const CATALOG_DIR = fileURLToPath(new URL("../catalog", import.meta.url));

export function loadCatalog(dir = CATALOG_DIR): Catalog {
  const files = readdirSync(dir).filter((f) => f.endsWith(".proc")).sort();
  const procedures = files.flatMap((f) =>
    parseProc(readFileSync(join(dir, f), "utf8"), f),
  );
  return buildCatalog(procedures);
}
