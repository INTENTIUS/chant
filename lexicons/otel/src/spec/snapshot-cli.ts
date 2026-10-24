#!/usr/bin/env tsx
/**
 * Refresh the committed schema snapshot (`just snapshot`, #3361).
 *
 * Reads both distribution manifests at the versions in `pin.ts`, indexes every
 * component they list, and keeps the schema documents the built-ins reach. The
 * output is re-indented so a version move reads as a diff. Run it on a
 * networked machine after bumping `OTELCOL_CONTRIB_VERSION` or
 * `OTELCOL_K8S_VERSION`, then paste the printed pin into `pin.ts` and run
 * `just generate`, all in one commit.
 */

import { writeFileSync } from "fs";
import { fetchUpstreamSpec } from "./fetch";
import { OTELCOL_CONTRIB_VERSION, OTELCOL_K8S_VERSION, pinBlock, specDigest } from "./pin";
import { BUILTIN_SPECS } from "./builtins";
import { SNAPSHOT_FILE } from "./snapshot";

const snapshot = await fetchUpstreamSpec({
  contribVersion: OTELCOL_CONTRIB_VERSION,
  k8sVersion: OTELCOL_K8S_VERSION,
  keep: BUILTIN_SPECS,
  force: process.argv.includes("--force"),
  log: (m) => console.error(m),
});
const json = `${JSON.stringify(snapshot, null, 1)}\n`;
writeFileSync(SNAPSHOT_FILE, json);
const documents = Object.keys(snapshot.schemas).length;
console.error(`Wrote ${documents} schema documents (${(json.length / 1024).toFixed(0)} KB) to ${SNAPSHOT_FILE}`);
const unresolved = Object.keys(snapshot.unresolved);
if (unresolved.length > 0) console.error(`Unresolved $ref documents (typed as unknown): ${unresolved.join(", ")}`);
console.error(`\nPaste into src/spec/pin.ts:\n\n${pinBlock(specDigest(snapshot), documents)}`);
