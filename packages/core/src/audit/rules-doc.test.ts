import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { renderRulesReference } from "./rules-doc";
import { RULE_CATALOG, ruleDocUrl } from "./catalog";

const PAGE = fileURLToPath(new URL("../../../../docs/src/content/docs/lint-rules/audit-rules.mdx", import.meta.url));

describe("audit rules reference", () => {
  test("committed page is in sync with the catalog (regenerate if this fails)", () => {
    const committed = readFileSync(PAGE, "utf-8");
    expect(committed).toBe(renderRulesReference());
  });

  test("every rule has an anchor reachable from ruleDocUrl", () => {
    const page = renderRulesReference();
    for (const id of Object.keys(RULE_CATALOG)) {
      // `### GHA033` → Starlight slug `#gha033`, which ruleDocUrl targets.
      expect(page).toContain(`### ${id}`);
      expect(ruleDocUrl(id)).toBe(`https://intentius.io/chant/lint-rules/audit-rules/#${id.toLowerCase()}`);
    }
  });
});
