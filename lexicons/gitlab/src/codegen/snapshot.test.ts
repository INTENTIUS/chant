import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const generatedDir = join(dirname(dirname(fileURLToPath(import.meta.url))), "generated");

describe("generated lexicon-gitlab.json", () => {
  const content = readFileSync(join(generatedDir, "lexicon-gitlab.json"), "utf-8");
  const registry = JSON.parse(content);

  test("is valid JSON with expected entries", () => {
    expect(Object.keys(registry)).toHaveLength(15);
  });

  test("contains all resource entities", () => {
    expect(registry.Job).toBeDefined();
    expect(registry.Job.kind).toBe("resource");
    expect(registry.Job.resourceType).toBe("GitLab::CI::Job");
    expect(registry.Job.lexicon).toBe("gitlab");

    expect(registry.Default).toBeDefined();
    expect(registry.Default.kind).toBe("resource");

    expect(registry.Workflow).toBeDefined();
    expect(registry.Workflow.kind).toBe("resource");
  });

  test("contains all property entities", () => {
    const propertyNames = [
      "AllowFailure", "Artifacts", "AutoCancel", "Cache",
      "Environment", "Image", "Include", "Parallel",
      "Release", "Retry", "Rule", "Trigger",
    ];
    for (const name of propertyNames) {
      expect(registry[name]).toBeDefined();
      expect(registry[name].kind).toBe("property");
      expect(registry[name].lexicon).toBe("gitlab");
    }
  });

  test("entries match snapshot", () => {
    expect(registry.Job).toMatchSnapshot();
    expect(registry.Artifacts).toMatchSnapshot();
    expect(registry.Cache).toMatchSnapshot();
    expect(registry.Image).toMatchSnapshot();
  });
});

describe("generated index.d.ts", () => {
  const content = readFileSync(join(generatedDir, "index.d.ts"), "utf-8");

  test("contains all class declarations", () => {
    const expectedClasses = [
      "Job", "Default", "Workflow",
      "AllowFailure", "Artifacts", "AutoCancel", "Cache",
      "Environment", "Image", "Include", "Parallel",
      "Release", "Retry", "Rule", "Trigger",
    ];
    for (const cls of expectedClasses) {
      expect(content).toContain(`export declare class ${cls}`);
    }
  });

  test("contains CI variables declaration", () => {
    expect(content).toContain("export declare const CI");
    expect(content).toContain("readonly CommitBranch: string");
    expect(content).toContain("readonly CommitSha: string");
    expect(content).toContain("readonly PipelineId: string");
  });

  test("Job class has key properties in constructor", () => {
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
  const content = readFileSync(join(generatedDir, "index.ts"), "utf-8");

  test("has correct resource createResource calls", () => {
    expect(content).toContain('createResource("GitLab::CI::Default"');
    expect(content).toContain('createResource("GitLab::CI::Job"');
    expect(content).toContain('createResource("GitLab::CI::Workflow"');
  });

  test("has correct property createProperty calls", () => {
    expect(content).toContain('createProperty("GitLab::CI::Artifacts"');
    expect(content).toContain('createProperty("GitLab::CI::Cache"');
    expect(content).toContain('createProperty("GitLab::CI::Image"');
    expect(content).toContain('createProperty("GitLab::CI::Rule"');
  });

  test("re-exports reference and CI", () => {
    expect(content).toContain('export { reference } from "../intrinsics"');
    expect(content).toContain('export { CI } from "../variables"');
  });

  test("imports from runtime", () => {
    expect(content).toContain('from "./runtime"');
  });
});
