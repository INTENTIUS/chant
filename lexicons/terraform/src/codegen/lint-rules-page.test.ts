import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { scanRules } from "@intentius/chant/codegen/docs-rule-scanning";

/**
 * `docs/pages/lint-rules.mdx` is authored by hand, one `##` section per rule
 * (#2108). Nothing regenerates those sections, so nothing stops the page
 * lagging the catalog the moment a new rule ships without one. This test
 * reads the same rule scan the generated `rules` table (`All Rules`) is built
 * from and fails the moment a scanned id has no matching heading on the
 * authored page, so the page cannot silently fall behind.
 */
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("lint-rules.mdx stays in sync with the rule catalog", () => {
  test("every rule id scanned from source has a ## section on the authored page", () => {
    const ids = scanRules(join(pkgDir, "src")).map((r) => r.id).sort();
    expect(ids.length).toBeGreaterThan(0);

    const page = readFileSync(join(pkgDir, "docs", "pages", "lint-rules.mdx"), "utf-8");
    const headingIds = new Set([...page.matchAll(/^## (TF\d+)\b/gm)].map((m) => m[1]));

    const missing = ids.filter((id) => !headingIds.has(id));
    expect(missing, `lint-rules.mdx has no section for: ${missing.join(", ")}`).toEqual([]);
  });
});
