import { describe, expect, it } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { augurPlugin } from "./plugin";
import { augurAuditCatalog } from "./lint/audit-catalog";

describe("augur plugin", () => {
  it("is a valid LexiconPlugin", () => {
    // `isLexiconPlugin` rejects at load time without all four lifecycle
    // methods, so this is the check that a lexicon exists at all.
    expect(isLexiconPlugin(augurPlugin)).toBe(true);
  });

  it("declares all four lifecycle methods", () => {
    for (const member of ["generate", "validate", "coverage", "package"] as const) {
      expect(typeof augurPlugin[member], `${member} is missing`).toBe("function");
    }
  });

  it("names itself augur, and its rules AUG", () => {
    expect(augurPlugin.name).toBe("augur");
    expect(augurPlugin.serializer.name).toBe("augur");
    expect(augurPlugin.serializer.rulePrefix).toBe("AUG");
  });

  it("registers predictBehaviour — the first lexicon to (#2357)", () => {
    expect(typeof augurPlugin.predictBehaviour).toBe("function");
  });

  it("registers none of the three reads, because there is no substrate to read", () => {
    // Not a gap. `describeResources`, `observeResourcesDeep` and
    // `listArtifacts` report what a substrate holds; augur holds nothing and
    // asks an engine what would happen. Declaring one returning `[]` would
    // pass a check while claiming a read that never happens.
    expect(augurPlugin.describeResources).toBeUndefined();
    expect(augurPlugin.observeResourcesDeep).toBeUndefined();
    expect(augurPlugin.listArtifacts).toBeUndefined();
  });

  it("gives every post-synth check a catalog entry, or it contributes nothing to chant audit", () => {
    const checkIds = (augurPlugin.postSynthChecks?.() ?? []).map((c) => c.id);
    expect(checkIds.length).toBeGreaterThan(0);
    for (const id of checkIds) {
      expect(Object.keys(augurAuditCatalog), `${id} has no catalog entry`).toContain(id);
    }
  });

  it("keeps every rule id under the declared prefix", () => {
    const ids = [
      ...(augurPlugin.lintRules?.() ?? []).map((r) => r.id),
      ...(augurPlugin.postSynthChecks?.() ?? []).map((c) => c.id),
    ];
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.filter((id) => !id.startsWith("AUG"))).toEqual([]);
  });

  it("derives its presets from the catalog rather than a second list", async () => {
    const presets = augurPlugin.lintPresets?.();
    expect(presets?.all).toEqual(Object.keys(augurAuditCatalog));
    expect(presets?.recommended).toContain("AUG101");
  });

  it("accounts for every kind it has an opinion about", async () => {
    // The tier-1 `coverageReport()` check. There is no upstream spec here to
    // leave anything unaccounted for; the coverage augur does have an opinion
    // about is `src/mapping.ts`'s, and `coverageFor` is total over entity types.
    expect((await augurPlugin.coverageReport?.())?.unaccountedKinds).toEqual([]);
  });

  it("detects its own emitted profile document and nothing else", () => {
    expect(augurPlugin.detectTemplate?.({ augur: "augur/profiles/v1", profiles: [] })).toBe(true);
    expect(augurPlugin.detectTemplate?.({ Resources: {} })).toBe(false);
    expect(augurPlugin.detectTemplate?.("apiVersion: apps/v1")).toBe(false);
    expect(augurPlugin.detectTemplate?.(null)).toBe(false);
    expect(augurPlugin.detectTemplate?.([])).toBe(false);
  });
});
