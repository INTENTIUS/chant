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

  test("each entry is a model-based, report-only correctness finding with no authority", () => {
    for (const [id, meta] of Object.entries(pulumiAuditCatalog)) {
      expect(meta.id).toBe(id);
      expect(meta).toMatchObject({ tier: "report-only", fixKind: "guidance", category: "correctness", yamlBased: false });
      expect(meta.authority).toBeUndefined();
    }
  });
});
