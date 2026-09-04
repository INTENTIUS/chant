/**
 * Regenerate docs/src/content/docs/lint-rules/audit-rules.mdx from the audit
 * catalog. The page is derived data: `packages/core/src/audit/rules-doc.test.ts`
 * fails when the committed page and `renderRulesReference()` disagree, so run
 * this after changing any lexicon's audit-catalog.ts or audit-lineage.ts.
 *
 *   npx tsx scripts/generate-audit-rules-doc.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderRulesReference } from "../packages/core/src/audit/rules-doc";

const PAGE = resolve(import.meta.dirname, "../docs/src/content/docs/lint-rules/audit-rules.mdx");
const page = await renderRulesReference();
writeFileSync(PAGE, page);
console.log(`wrote ${PAGE} (${page.length} bytes)`);
