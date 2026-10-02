/**
 * Regenerate docs/src/content/docs/reference/boundary.mdx from the owner
 * roster in docs/data/boundary.yaml (#2657). The page is derived data:
 * `test/boundary-roster.test.ts` fails when the committed page and
 * `renderBoundaryPage()` disagree, so run this after editing a roster row.
 *
 *   npx tsx scripts/generate-boundary-doc.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { BOUNDARY_PAGE, readRoster, renderBoundaryPage } from "./boundary-roster";

const repoRoot = resolve(import.meta.dirname, "..");
const { rows, problems } = readRoster(repoRoot);
if (problems.length > 0) {
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nFix docs/data/boundary.yaml first.");
  process.exit(1);
}
const page = renderBoundaryPage(rows);
writeFileSync(resolve(repoRoot, BOUNDARY_PAGE), page);
console.log(`wrote ${BOUNDARY_PAGE} (${rows.length} rows, ${page.length} bytes)`);
