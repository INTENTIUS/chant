import { describe, test, expect } from "bun:test";
import { GitLabGenerator } from "./generator";
import type { TemplateIR } from "@intentius/chant/import/parser";

const generator = new GitLabGenerator();

describe("GitLabGenerator", () => {
  test("generates import statement", () => {
    const ir: TemplateIR = {
      resources: [
        { logicalId: "testJob", type: "GitLab::CI::Job", properties: { script: ["test"] } },
      ],
      parameters: [],
    };

    const files = generator.generate(ir);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("main.ts");
    expect(files[0].content).toContain('from "@intentius/chant-lexicon-gitlab"');
    expect(files[0].content).toContain("Job");
  });

  test("generates Job constructor", () => {
    const ir: TemplateIR = {
      resources: [
        {
          logicalId: "buildJob",
          type: "GitLab::CI::Job",
          properties: {
            stage: "build",
            script: ["npm run build"],
          },
        },
      ],
      parameters: [],
    };

    const files = generator.generate(ir);
    const content = files[0].content;
    expect(content).toContain("export const buildJob = new Job(");
    expect(content).toContain('stage: "build"');
    expect(content).toContain('script: ["npm run build"]');
  });

  test("generates Default constructor", () => {
    const ir: TemplateIR = {
      resources: [
        {
          logicalId: "defaults",
          type: "GitLab::CI::Default",
          properties: { interruptible: true },
        },
      ],
      parameters: [],
    };

    const files = generator.generate(ir);
    expect(files[0].content).toContain("export const defaults = new Default(");
    expect(files[0].content).toContain("interruptible: true");
  });

  test("generates Workflow constructor", () => {
    const ir: TemplateIR = {
      resources: [
        {
          logicalId: "workflow",
          type: "GitLab::CI::Workflow",
          properties: { name: "CI Pipeline" },
        },
      ],
      parameters: [],
    };

    const files = generator.generate(ir);
    expect(files[0].content).toContain("export const workflow = new Workflow(");
    expect(files[0].content).toContain('"CI Pipeline"');
  });

  test("wraps nested property types in constructors", () => {
    const ir: TemplateIR = {
      resources: [
        {
          logicalId: "testJob",
          type: "GitLab::CI::Job",
          properties: {
            script: ["test"],
            artifacts: { paths: ["dist/"], expireIn: "1 week" },
            cache: { key: "node", paths: ["node_modules/"] },
          },
        },
      ],
      parameters: [],
    };

    const files = generator.generate(ir);
    const content = files[0].content;
    expect(content).toContain("new Artifacts(");
    expect(content).toContain("new Cache(");
    expect(content).toContain("Artifacts");
    expect(content).toContain("Cache");
  });

  test("wraps rules in Rule constructors", () => {
    const ir: TemplateIR = {
      resources: [
        {
          logicalId: "testJob",
          type: "GitLab::CI::Job",
          properties: {
            script: ["test"],
            rules: [{ if: "$CI_COMMIT_BRANCH", when: "always" }],
          },
        },
      ],
      parameters: [],
    };

    const files = generator.generate(ir);
    const content = files[0].content;
    expect(content).toContain("new Rule(");
    expect(content).toContain("Rule");
  });

  test("generates multiple resources", () => {
    const ir: TemplateIR = {
      resources: [
        { logicalId: "buildJob", type: "GitLab::CI::Job", properties: { stage: "build", script: ["build"] } },
        { logicalId: "testJob", type: "GitLab::CI::Job", properties: { stage: "test", script: ["test"] } },
      ],
      parameters: [],
    };

    const files = generator.generate(ir);
    const content = files[0].content;
    expect(content).toContain("export const buildJob");
    expect(content).toContain("export const testJob");
  });

  test("includes stages comment from metadata", () => {
    const ir: TemplateIR = {
      resources: [
        { logicalId: "testJob", type: "GitLab::CI::Job", properties: { script: ["test"] } },
      ],
      parameters: [],
      metadata: { stages: ["build", "test", "deploy"] },
    };

    const files = generator.generate(ir);
    expect(files[0].content).toContain("Pipeline stages: build, test, deploy");
  });
});
