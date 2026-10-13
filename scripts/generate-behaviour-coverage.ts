#!/usr/bin/env tsx
/**
 * Refresh the behaviour coverage page (chant #2404) from the rows the
 * lexicons contribute through `behaviourKinds`.
 *
 * Run this after adding, removing or re-describing a row in any lexicon's
 * behaviour kinds, then commit the regenerated page alongside the change.
 * `test/behaviour-coverage.test.ts` asserts the committed block equals what
 * this renders, so a forgotten run fails CI rather than shipping a page that
 * disagrees with the rows. Same shape as `generate-egress-catalogue.ts`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BEHAVIOUR_COVERAGE_CONTRIBUTORS,
  BEHAVIOUR_COVERAGE_DOC,
  replaceBehaviourCoverageBlock,
} from "../test/behaviour-coverage";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const docPath = join(repoRoot, BEHAVIOUR_COVERAGE_DOC);
writeFileSync(docPath, replaceBehaviourCoverageBlock(readFileSync(docPath, "utf-8")));
console.error(`  updated ${BEHAVIOUR_COVERAGE_DOC}`);
console.error(
  `Behaviour coverage: ${BEHAVIOUR_COVERAGE_CONTRIBUTORS.map((c) => `${c.lexicon} (${Object.keys(c.kinds.mapped ?? {}).length} mapped, ${Object.keys(c.kinds.unmapped ?? {}).length} unmapped)`).join(", ")}`,
);
