#!/usr/bin/env tsx
/**
 * Refresh the capability table on the plan previews page (chant #4001) from
 * the capability plugins. `scripts/plan-previews.test.ts` fails when the
 * committed table and the plugins disagree, so run this after a capability
 * gains or loses `plan` or `outputs`, or after a plugin adds or drops one.
 *
 *   npm run generate:plan-previews
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLANNERS, PLAN_PREVIEWS_DOC, capabilityRows, replacePlanPreviewsBlock } from "./plan-previews";

const rows = capabilityRows();
const undescribed = rows.filter((r) => r.plan && !PLANNERS[r.kind]).map((r) => r.kind);
if (undescribed.length > 0) {
  console.error(
    `Capabilities with plan and no entry in PLANNERS (scripts/plan-previews.ts): ${undescribed.join(", ")}. ` +
      "Say what each one's plan reads and what the note shows, and add a section for it to the page.",
  );
  process.exit(1);
}
const path = join(import.meta.dirname, "..", PLAN_PREVIEWS_DOC);
writeFileSync(path, replacePlanPreviewsBlock(readFileSync(path, "utf-8"), rows));
console.error(`updated ${PLAN_PREVIEWS_DOC}: ${rows.length} capabilities, ${rows.filter((r) => r.plan).length} with plan`);
