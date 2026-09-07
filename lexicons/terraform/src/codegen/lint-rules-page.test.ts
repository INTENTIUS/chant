import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { scanRules } from "@intentius/chant/codegen/docs-rule-scanning";
import { RULE_CATALOG } from "@intentius/chant/audit/catalog";

/**
 * `docs/pages/lint-rules.mdx` is authored by hand, one `##` section per rule
 * (#2108). Nothing regenerates those sections, so nothing stops the page
 * lagging the catalog the moment a new rule ships without one. This test
 * reads the same rule scan the generated `rules` table (`All Rules`) is built
 * from and fails the moment a scanned id has no matching heading on the
 * authored page, so the page cannot silently fall behind.
 */
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The TF ids core owns rather than this lexicon (#2220). `scanRules` walks
 * this package's `src/`, so it cannot see them: TF023 (Terraform state
 * committed to the repository) lives in `packages/core/src/audit/catalog.ts`
 * because it reads the discovered file list rather than a parsed root module,
 * and its page section here was the one TF section nothing guarded. Read off
 * `RULE_CATALOG` rather than hardcoded, so a second core-owned TF id is
 * covered on the day it lands.
 */
function coreOwnedTfIds(): string[] {
  return Object.keys(RULE_CATALOG).filter((id) => /^TF\d+$/.test(id));
}

describe("lint-rules.mdx stays in sync with the rule catalog", () => {
  test("every rule id scanned from source has a ## section on the authored page", () => {
    const core = coreOwnedTfIds();
    expect(core, "core owns at least TF023").toContain("TF023");

    const ids = [...new Set([...scanRules(join(pkgDir, "src")).map((r) => r.id), ...core])].sort();
    expect(ids.length).toBeGreaterThan(0);

    const page = readFileSync(join(pkgDir, "docs", "pages", "lint-rules.mdx"), "utf-8");
    const headingIds = new Set([...page.matchAll(/^## (TF\d+)\b/gm)].map((m) => m[1]));

    const missing = ids.filter((id) => !headingIds.has(id));
    expect(missing, `lint-rules.mdx has no section for: ${missing.join(", ")}`).toEqual([]);
  });
});
