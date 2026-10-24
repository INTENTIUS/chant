/**
 * The committed schema snapshot (#3361): what generation, the coverage report
 * and the LSP read. Never fetched here; `just snapshot` refreshes it.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { moduleSourceDir } from "@intentius/chant/module-source";
import type { OtelSpecSnapshot } from "./fetch";

export const SNAPSHOT_FILE = join(moduleSourceDir(import.meta.url), "otel-schemas.snapshot.json");

let cached: OtelSpecSnapshot | undefined;

/** The snapshot as committed, parsed once per process. */
export function loadSnapshot(): OtelSpecSnapshot {
  cached ??= JSON.parse(readFileSync(SNAPSHOT_FILE, "utf-8")) as OtelSpecSnapshot;
  return cached;
}
