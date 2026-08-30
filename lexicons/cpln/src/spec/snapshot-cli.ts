#!/usr/bin/env tsx
/**
 * Refresh the committed offline spec snapshot (`just snapshot`).
 *
 * Fetches the live Control Plane OpenAPI document and writes back the subset
 * reachable from the modelled kinds. Pruning is what makes committing it
 * reasonable: the full document is 2.8 MB of which this lexicon reads 23
 * schemas, and the remainder is `patch_*` mirrors and kinds not modelled here
 * — churn in a file whose whole purpose is to be a stable fallback. It is
 * written re-indented rather than compact so upstream changes show up as a
 * readable diff.
 *
 * Run this on a networked machine whenever the generated surface is meant to
 * move, and commit the result in the same change as the regenerated types, so
 * the snapshot and the types in the tree always describe the same API.
 */

import { writeFileSync } from "fs";
import { SCHEMA_URL, SNAPSHOT_FILE } from "./fetch";
import { KINDS } from "../kinds";

const REF_RE = /#\/components\/schemas\/([A-Za-z0-9_]+)/g;

interface Spec {
  openapi?: string;
  info?: unknown;
  components?: { schemas?: Record<string, unknown> };
}

async function main(): Promise<void> {
  console.error(`Fetching ${SCHEMA_URL} …`);
  const response = await fetch(SCHEMA_URL);
  if (!response.ok) {
    throw new Error(`${SCHEMA_URL} answered ${response.status} ${response.statusText}`);
  }
  const spec = (await response.json()) as Spec;
  const schemas = spec.components?.schemas;
  if (!schemas) throw new Error("response carried no components.schemas");

  // Transitive closure over `$ref` from the modelled kinds.
  const keep = new Set<string>();
  const queue = KINDS.map((k) => k.schema);
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (keep.has(name) || !(name in schemas)) continue;
    keep.add(name);
    for (const match of JSON.stringify(schemas[name]).matchAll(REF_RE)) queue.push(match[1]);
  }

  const missing = KINDS.filter((k) => !keep.has(k.schema));
  if (missing.length > 0) {
    throw new Error(`spec is missing schemas for: ${missing.map((k) => k.schema).join(", ")}`);
  }

  const pruned = {
    openapi: spec.openapi,
    info: spec.info,
    components: {
      schemas: Object.fromEntries([...keep].sort().map((name) => [name, schemas[name]])),
    },
  };

  const json = `${JSON.stringify(pruned, null, 1)}\n`;
  writeFileSync(SNAPSHOT_FILE, json);
  console.error(`Wrote ${keep.size} schemas (${(json.length / 1024).toFixed(0)} KB) to ${SNAPSHOT_FILE}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
