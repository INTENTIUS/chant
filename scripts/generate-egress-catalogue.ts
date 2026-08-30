#!/usr/bin/env tsx
/**
 * Refresh the published egress catalogue (chant #1984) from
 * `test/egress-catalogue.ts`.
 *
 * Run this after adding, removing or re-describing a row in
 * `EGRESS_CATALOGUE`, then commit the regenerated page alongside the change.
 * `test/no-egress.test.ts` asserts the committed block equals what this
 * renders, so a forgotten run fails CI rather than shipping a page that
 * disagrees with the tree.
 *
 * The scan runs first and is reported, not written: a row missing from the
 * catalogue is a decision for whoever added the fetch, not something a
 * generator should invent a reason for. Same discipline as
 * `scripts/generate-fold-coverage.ts` — the script refreshes what is
 * derivable and refuses to guess what is not.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EGRESS_CATALOGUE,
  EGRESS_CATALOGUE_DOCS,
  replaceEgressCatalogueBlock,
  scanEgressSites,
} from "../test/egress-catalogue";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const scanned = scanEgressSites(repoRoot);
const catalogued = new Set(EGRESS_CATALOGUE.map((site) => site.file));
const missing = scanned.filter((site) => !catalogued.has(site.file));
const stale = EGRESS_CATALOGUE.filter((site) => !scanned.some((s) => s.file === site.file));

for (const site of missing) {
  console.error(`  uncatalogued  ${site.file} [${site.primitives.join(", ")}]`);
}
for (const site of stale) {
  console.error(`  stale         ${site.file}`);
}
if (missing.length > 0 || stale.length > 0) {
  console.error(
    "\nFix test/egress-catalogue.ts first: every module that calls a network primitive needs a row naming its phase, destination and reason, and a row whose module no longer calls one must go.",
  );
  process.exit(1);
}

for (const relPath of EGRESS_CATALOGUE_DOCS) {
  const docPath = join(repoRoot, relPath);
  writeFileSync(docPath, replaceEgressCatalogueBlock(readFileSync(docPath, "utf-8")));
  console.error(`  updated ${relPath}`);
}

console.error(
  `Egress catalogue: ${EGRESS_CATALOGUE.length} modules across ${scanned.length} scanned — ${EGRESS_CATALOGUE_DOCS.length} doc(s) refreshed`,
);
