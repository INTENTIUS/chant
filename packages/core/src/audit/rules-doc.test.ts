import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { renderRulesReference } from "./rules-doc";
import { resolveAuditCatalog, ruleDocUrl } from "./catalog";
import { AUDIT_LEXICONS } from "./discover";

const PAGE = fileURLToPath(new URL("../../../../docs/src/content/docs/lint-rules/audit-rules.mdx", import.meta.url));

describe("audit rules reference", () => {
  test("committed page is in sync with the catalog (regenerate if this fails)", async () => {
    const committed = readFileSync(PAGE, "utf-8");
    expect(committed).toBe(await renderRulesReference());
  });

  test("every rule has an anchor reachable from ruleDocUrl", async () => {
    const page = await renderRulesReference();
    const catalog = await resolveAuditCatalog([...AUDIT_LEXICONS]);
    for (const id of Object.keys(catalog)) {
      // `### GHA033` → Starlight slug `#gha033`, which ruleDocUrl targets.
      expect(page).toContain(`### ${id}`);
      expect(ruleDocUrl(id)).toBe(`https://intentius.io/chant/lint-rules/audit-rules/#${id.toLowerCase()}`);
    }
  });
});
