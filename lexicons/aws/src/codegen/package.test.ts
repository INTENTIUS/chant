import { describe, test, expect } from "bun:test";
import { packageLexicon } from "./package";
import { validateManifest } from "@intentius/chant/lexicon-schema";

describe("packageLexicon", () => {
  test("produces valid BundleSpec with all artifacts", async () => {
    const { spec, stats } = await packageLexicon();

    // Manifest fields
    expect(spec.manifest.name).toBe("aws");
    expect(spec.manifest.version).toBeTruthy();
    expect(spec.manifest.chantVersion).toBe(">=0.1.0");
    expect(spec.manifest.namespace).toBe("AWS");

    // Intrinsics
    expect(spec.manifest.intrinsics).toBeDefined();
    expect(spec.manifest.intrinsics!.length).toBeGreaterThan(0);
    const sub = spec.manifest.intrinsics!.find((i) => i.name === "Sub");
    expect(sub).toBeDefined();
    expect(sub!.outputKey).toBe("Fn::Sub");
    expect(sub!.isTag).toBe(true);
    const ref = spec.manifest.intrinsics!.find((i) => i.name === "Ref");
    expect(ref).toBeDefined();
    expect(ref!.outputKey).toBe("Ref");

    // Pseudo-parameters
    expect(spec.manifest.pseudoParameters).toBeDefined();
    expect(spec.manifest.pseudoParameters!.StackName).toBe("AWS::StackName");
    expect(spec.manifest.pseudoParameters!.Region).toBe("AWS::Region");
    expect(spec.manifest.pseudoParameters!.AccountId).toBe("AWS::AccountId");

    // Registry (lexicon JSON)
    expect(spec.registry.length).toBeGreaterThan(0);
    const registry = JSON.parse(spec.registry);
    expect(Object.keys(registry).length).toBeGreaterThan(100);

    // Types
    expect(spec.typesDTS.length).toBeGreaterThan(0);
    expect(spec.typesDTS).toContain("export declare class");

    // Rules
    expect(spec.rules.size).toBeGreaterThan(0);
    expect(spec.rules.has("s3-encryption.ts")).toBe(true);
    expect(spec.rules.has("iam-wildcard.ts")).toBe(true);

    // Skills
    expect(spec.skills.size).toBeGreaterThan(0);

    // Stats
    expect(stats.resources).toBeGreaterThan(100);
    expect(stats.ruleCount).toBeGreaterThan(0);
  }, 120_000);

  test("manifest passes validation", async () => {
    const { spec } = await packageLexicon();
    const validated = validateManifest(spec.manifest);
    expect(validated.name).toBe("aws");
    expect(validated.version).toBeTruthy();
  }, 120_000);
});
