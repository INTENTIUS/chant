#!/usr/bin/env tsx
/**
 * `just fetch-schemas`: download each schema at the pinned commit into
 * `src/spec/schemas/`, then print its digest beside the one the pin records. The
 * only step in this lexicon that touches the network; run it when bumping
 * `GRAFANA_SCHEMA_PIN`, then `npm run generate`.
 */
import { writeFileSync } from "fs";
import { GRAFANA_SCHEMA_PIN, SCHEMA_NAMES, schemaUrl } from "../pin";
import { schemaPath, sha256 } from "./schemas";

let changed = 0;
for (const name of SCHEMA_NAMES) {
  const res = await fetch(schemaUrl(name));
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from ${schemaUrl(name)}`);
  const text = await res.text();
  writeFileSync(schemaPath(name), text);
  const digest = sha256(text);
  const same = digest === GRAFANA_SCHEMA_PIN.files[name];
  if (!same) changed++;
  console.error(`${same ? "  " : "! "}${name}: ${digest}`);
}
console.error(
  changed === 0
    ? `All ${SCHEMA_NAMES.length} schemas match the pin (${GRAFANA_SCHEMA_PIN.ref}).`
    : `${changed} schema(s) differ from the pin: update GRAFANA_SCHEMA_PIN.files in src/pin.ts, then run npm run generate.`,
);
