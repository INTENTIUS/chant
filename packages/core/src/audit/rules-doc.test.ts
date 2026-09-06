import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { renderRulesReference, ruleBlock } from "./rules-doc";
import { resolveAuditCatalog, ruleDocUrl, auditRule } from "./catalog";
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

describe("ruleBlock, aliases and deprecated (chant #2113)", () => {
  test("renders aliases as a list", () => {
    const m = { ...auditRule("NEW001", "report-only", "guidance", "T", "r"), aliases: ["OLD001", "LEGACY_OLD"] };
    const block = ruleBlock(m);
    expect(block).toContain("Also known as: `OLD001`, `LEGACY_OLD`.");
  });

  test("greys a deprecated rule (tags line, not the heading; the heading is the anchor `ruleDocUrl` targets)", () => {
    const m = { ...auditRule("OLD002", "report-only", "guidance", "T", "r") };
    m.deprecated = "superseded by NEW002";
    const block = ruleBlock(m);
    expect(block).toContain("### OLD002"); // heading unchanged: `ruleDocUrl("OLD002")` must still resolve
    expect(block).toContain("~~deprecated~~");
    expect(block).toContain(":::note[Deprecated]");
    expect(block).toContain("superseded by NEW002");
  });

  test("a deprecated rule with no string reason gets a generic note", () => {
    const m = { ...auditRule("OLD003", "report-only", "guidance", "T", "r") };
    m.deprecated = true;
    expect(ruleBlock(m)).toContain("This rule no longer runs.");
  });

  test("a rule with neither aliases nor deprecated renders unchanged from before #2113", () => {
    const m = auditRule("PLAIN001", "report-only", "guidance", "T", "r");
    const block = ruleBlock(m);
    expect(block).not.toContain("Also known as");
    expect(block).not.toContain(":::note[Deprecated]");
    expect(block).not.toContain("~~deprecated~~");
  });
});
