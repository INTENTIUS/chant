import { describe, expect, test } from "vitest";
import { pulumiPlugin } from "../plugin";
import { pulumiAuditCatalog } from "./audit-catalog";

describe("pulumiAuditCatalog (#4494)", () => {
  test("covers every post-synth check the plugin ships, and nothing else", () => {
    const ids = (pulumiPlugin.postSynthChecks?.() ?? []).map((c) => c.id).sort();
    expect(Object.keys(pulumiAuditCatalog).sort()).toEqual(ids);
  });

  test("the plugin contributes it", () => {
    expect(pulumiPlugin.auditCatalog?.()).toBe(pulumiAuditCatalog);
  });

  test("each entry is model-based guidance with no authority (#4510)", () => {
    for (const [id, meta] of Object.entries(pulumiAuditCatalog)) {
      expect(meta.id).toBe(id);
      expect(meta).toMatchObject({ fixKind: "guidance", yamlBased: false });
      expect(meta.authority).toBeUndefined();
      expect(meta.remediation.length).toBeGreaterThan(0);
    }
  });

  test("PUL003 is the one merge-worthy security entry; the rest are report-only", () => {
    for (const [id, meta] of Object.entries(pulumiAuditCatalog)) {
      if (id === "PUL003") expect(meta).toMatchObject({ tier: "merge-worthy", category: "security" });
      else {
        expect(meta.tier).toBe("report-only");
        expect(["correctness", "best-practice"]).toContain(meta.category);
      }
    }
  });
});
