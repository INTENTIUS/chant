/**
 * The MySQL catalog the generation reads (#5449): the committed snapshot of
 * each supported major line, `mysql-catalog-<major>.snapshot.json`. Nothing is
 * downloaded and no server is started.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MYSQL_PINS } from "./mysql-pin";
import { parseMysqlCatalog, type MysqlCatalog } from "./mysql-catalog";

const here = dirname(fileURLToPath(import.meta.url));

/** The path of a major line's snapshot. */
export function mysqlSnapshotPath(major: string): string {
  return join(here, `mysql-catalog-${major}.snapshot.json`);
}

/**
 * The catalog of a major line (the latest supported, by default). A snapshot
 * that names another version than the pin, or another major, is refused: a pin
 * move changes the snapshot in the same commit.
 */
export function readMysqlCatalog(major: string = MYSQL_PINS[MYSQL_PINS.length - 1]!.major): MysqlCatalog {
  const pin = MYSQL_PINS.find((p) => p.major === major);
  if (!pin) throw new Error(`MySQL ${major} is not a supported major (${MYSQL_PINS.map((p) => p.major).join(", ")})`);
  const catalog = parseMysqlCatalog(readFileSync(mysqlSnapshotPath(major), "utf-8"));
  if (catalog.major !== pin.major || catalog.version !== pin.version) {
    throw new Error(`mysql-catalog-${major}.snapshot.json is for MySQL ${catalog.version}, and the pin in mysql-pin.ts is ${pin.version}; change them together`);
  }
  return catalog;
}
