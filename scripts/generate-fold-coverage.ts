#!/usr/bin/env tsx
/**
 * Refresh the published fold-coverage count (chant #1062, epic #1019) in
 * `docs/src/content/docs/concepts/typescript-as-data.mdx`.
 *
 * Builds every corpus entry once with `{ fold: true }` (the same corpus and
 * wiring `examples/fold-differential.test.ts` uses), classifies each with
 * the shared {@link classifyFoldMode}, and rewrites the marker-delimited
 * block `examples/fold-coverage.ts` owns. Run this after any change that
 * moves fold coverage — a fold-subset change, a new/removed/rewritten
 * example — then commit the doc alongside it.
 *
 * `examples/fold-differential.test.ts` has its own guard test asserting the
 * committed doc matches its OWN run's live count (no second corpus build
 * there); this script is the one place that pays the build cost, on demand,
 * to fix a failing guard.
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { build } from "@intentius/chant/build";
import { discoverCorpus, classifyFoldMode } from "../examples/differential-corpus";
import { replaceFoldCoverageBlock, FOLD_COVERAGE_DOCS } from "../examples/fold-coverage";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const corpus = discoverCorpus();
let foldCount = 0;

for (const entry of corpus) {
  const result = await build(entry.srcDir, entry.serializers, undefined, { fold: true, intrinsics: entry.intrinsics, lexicons: entry.lexicons });
  const mode = classifyFoldMode(result.foldDecisions);
  if (mode === "fold") foldCount++;
  console.error(`  ${mode.padEnd(12)} ${entry.name}`);
}

for (const relPath of FOLD_COVERAGE_DOCS) {
  const docPath = join(repoRoot, relPath);
  const doc = readFileSync(docPath, "utf-8");
  writeFileSync(docPath, replaceFoldCoverageBlock(doc, foldCount, corpus.length));
  console.error(`  updated ${relPath}`);
}

console.error(`Fold coverage: ${foldCount} of ${corpus.length} — ${FOLD_COVERAGE_DOCS.length} doc(s) refreshed`);
