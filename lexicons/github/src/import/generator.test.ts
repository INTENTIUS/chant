import { describe, test, expect } from "vitest";
import { GitHubActionsGenerator } from "./generator";
import type { TemplateIR } from "@intentius/chant/import/parser";

const generator = new GitHubActionsGenerator();

describe("GitHubActionsGenerator", () => {
  test("generates import statement", () => {
    const ir: TemplateIR = {
      resources: [
        {
          logicalId: "workflow",
          type: "GitHub::Actions::Workflow",
          properties: { name: "CI" },
        },
      ],
      parameters: [],
    };
    const files = generator.generate(ir);
    expect(files).toHaveLength(1);
    expect(files[0].content).toContain('import { Workflow } from "@intentius/chant-lexicon-github"');
  });

  test("generates workflow export", () => {
    const ir: TemplateIR = {
      resources: [
        {
          logicalId: "workflow",
          type: "GitHub::Actions::Workflow",
          properties: { name: "CI" },
        },
      ],
      parameters: [],
    };
    const files = generator.generate(ir);
    expect(files[0].content).toContain("export const workflow = new Workflow(");
    expect(files[0].content).toContain('"name": "CI"');
  });

  test("generates job exports", () => {
    const ir: TemplateIR = {
      resources: [
        {
          logicalId: "build",
          type: "GitHub::Actions::Job",
          properties: { "runs-on": "ubuntu-latest" },
        },
      ],
      parameters: [],
    };
    const files = generator.generate(ir);
    expect(files[0].content).toContain("export const build = new Job(");
    expect(files[0].content).toContain('"runs-on": "ubuntu-latest"');
  });

  test("imports multiple used constructors", () => {
    const ir: TemplateIR = {
      resources: [
        {
          logicalId: "workflow",
          type: "GitHub::Actions::Workflow",
          properties: { name: "CI" },
        },
        {
          logicalId: "build",
          type: "GitHub::Actions::Job",
          properties: { "runs-on": "ubuntu-latest" },
        },
      ],
      parameters: [],
    };
    const files = generator.generate(ir);
    expect(files[0].content).toContain("Job");
    expect(files[0].content).toContain("Workflow");
  });

  test("wraps nested property constructors", () => {
    const ir: TemplateIR = {
      resources: [
        {
          logicalId: "build",
          type: "GitHub::Actions::Job",
          properties: {
            "runs-on": "ubuntu-latest",
            strategy: { matrix: { "node-version": ["18", "20"] } },
          },
        },
      ],
      parameters: [],
    };
    const files = generator.generate(ir);
    expect(files[0].content).toContain("new Strategy(");
    expect(files[0].content).toContain("Strategy");
  });

  test("output file is named main.ts", () => {
    const ir: TemplateIR = {
      resources: [
        {
          logicalId: "workflow",
          type: "GitHub::Actions::Workflow",
          properties: { name: "CI" },
        },
      ],
      parameters: [],
    };
    const files = generator.generate(ir);
    expect(files[0].path).toBe("main.ts");
  });
});
