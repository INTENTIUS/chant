import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const generatedDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "generated");
const hasGenerated = existsSync(join(generatedDir, "lexicon-gitlab.json"));

describe("generated lexicon-gitlab.json", () => {
  test.skipIf(!hasGenerated)("is valid JSON with expected entries", () => {
    const content = readFileSync(join(generatedDir, "lexicon-gitlab.json"), "utf-8");
    const registry = JSON.parse(content);
    expect(Object.keys(registry)).toHaveLength(19);
  });

  test.skipIf(!hasGenerated)("contains all resource entities", () => {
    const content = readFileSync(join(generatedDir, "lexicon-gitlab.json"), "utf-8");
    const registry = JSON.parse(content);
    expect(registry.Job).toBeDefined();
    expect(registry.Job.kind).toBe("resource");
    expect(registry.Job.resourceType).toBe("GitLab::CI::Job");
    expect(registry.Job.lexicon).toBe("gitlab");

    expect(registry.Default).toBeDefined();
    expect(registry.Default.kind).toBe("resource");

    expect(registry.Workflow).toBeDefined();
    expect(registry.Workflow.kind).toBe("resource");
  });

  test.skipIf(!hasGenerated)("contains all property entities", () => {
    const content = readFileSync(join(generatedDir, "lexicon-gitlab.json"), "utf-8");
    const registry = JSON.parse(content);
    const propertyNames = [
      "AllowFailure", "Artifacts", "AutoCancel", "Cache",
      "Environment", "Image", "Include", "Inherit", "Parallel",
      "Need", "Release", "Retry", "Rule", "Service", "Trigger",
      "WorkflowRule",
    ];
    for (const name of propertyNames) {
      expect(registry[name]).toBeDefined();
      expect(registry[name].kind).toBe("property");
      expect(registry[name].lexicon).toBe("gitlab");
    }
  });

  test.skipIf(!hasGenerated)("entries match snapshot", () => {
    const content = readFileSync(join(generatedDir, "lexicon-gitlab.json"), "utf-8");
    const registry = JSON.parse(content);
    expect(registry.Job).toMatchSnapshot();
    expect(registry.Artifacts).toMatchSnapshot();
    expect(registry.Cache).toMatchSnapshot();
    expect(registry.Image).toMatchSnapshot();
  });
});

describe("generated index.d.ts", () => {
  test.skipIf(!hasGenerated)("contains all class declarations", () => {
    const content = readFileSync(join(generatedDir, "index.d.ts"), "utf-8");
    const expectedClasses = [
      "Job", "Default", "Workflow",
      "AllowFailure", "Artifacts", "AutoCancel", "Cache",
      "Environment", "Image", "Include", "Inherit", "Parallel",
      "Need", "Release", "Retry", "Rule", "Service", "Trigger",
      "WorkflowRule",
    ];
    for (const cls of expectedClasses) {
      expect(content).toContain(`export declare class ${cls}`);
    }
  });

  test.skipIf(!hasGenerated)("contains CI variables declaration", () => {
    const content = readFileSync(join(generatedDir, "index.d.ts"), "utf-8");
    expect(content).toContain("export declare const CI");
    expect(content).toContain("readonly CommitBranch: string");
    expect(content).toContain("readonly CommitSha: string");
    expect(content).toContain("readonly PipelineId: string");
  });

  test.skipIf(!hasGenerated)("Job class has key properties in constructor", () => {
    const content = readFileSync(join(generatedDir, "index.d.ts"), "utf-8");
    // Extract the Job class declaration
    const jobMatch = content.match(/export declare class Job \{[\s\S]*?\n\}/);
    expect(jobMatch).toBeDefined();
    const jobDecl = jobMatch![0];
    expect(jobDecl).toContain("script");
    expect(jobDecl).toContain("stage");
    expect(jobDecl).toContain("image");
    expect(jobDecl).toContain("artifacts");
    expect(jobDecl).toContain("cache");
  });
});

describe("generated index.ts", () => {
  test.skipIf(!hasGenerated)("has correct resource createResource calls", () => {
    const content = readFileSync(join(generatedDir, "index.ts"), "utf-8");
    expect(content).toContain('createResource("GitLab::CI::Default"');
    expect(content).toContain('createResource("GitLab::CI::Job"');
    expect(content).toContain('createResource("GitLab::CI::Workflow"');
  });

  test.skipIf(!hasGenerated)("has correct property createProperty calls", () => {
    const content = readFileSync(join(generatedDir, "index.ts"), "utf-8");
    expect(content).toContain('createProperty("GitLab::CI::Artifacts"');
    expect(content).toContain('createProperty("GitLab::CI::Cache"');
    expect(content).toContain('createProperty("GitLab::CI::Image"');
    expect(content).toContain('createProperty("GitLab::CI::Rule"');
  });

  test.skipIf(!hasGenerated)("re-exports reference and CI", () => {
    const content = readFileSync(join(generatedDir, "index.ts"), "utf-8");
    expect(content).toContain('export { reference } from "../intrinsics"');
    expect(content).toContain('export { CI } from "../variables"');
  });

  test.skipIf(!hasGenerated)("imports from runtime", () => {
    const content = readFileSync(join(generatedDir, "index.ts"), "utf-8");
    expect(content).toContain('from "./runtime"');
  });
});
