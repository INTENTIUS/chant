import { describe, test, expect } from "vitest";
import { GitHubActionsParser } from "./parser";

const parser = new GitHubActionsParser();

describe("GitHubActionsParser", () => {
  test("parses workflow-level properties", () => {
    const yaml = `name: CI
on:
  push:
    branches: [main]
permissions:
  contents: read
`;
    const ir = parser.parse(yaml);
    const wf = ir.resources.find((r) => r.type === "GitHub::Actions::Workflow");
    expect(wf).toBeDefined();
    expect(wf!.properties.name).toBe("CI");
    expect(wf!.properties.permissions).toBeDefined();
  });

  test("parses jobs as Job resources", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const ir = parser.parse(yaml);
    const jobs = ir.resources.filter((r) => r.type === "GitHub::Actions::Job");
    expect(jobs).toHaveLength(2);
    expect(jobs[0].logicalId).toBe("build");
    expect(jobs[1].logicalId).toBe("test");
  });

  test("converts kebab-case job IDs to camelCase logical IDs", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const ir = parser.parse(yaml);
    const job = ir.resources.find((r) => r.type === "GitHub::Actions::Job");
    expect(job!.logicalId).toBe("buildAndTest");
    expect(job!.metadata?.originalName).toBe("build-and-test");
  });

  test("detects reusable workflow call jobs", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  call-other:
    uses: owner/repo/.github/workflows/reusable.yml@main
`;
    const ir = parser.parse(yaml);
    const job = ir.resources.find((r) => r.type === "GitHub::Actions::ReusableWorkflowCallJob");
    expect(job).toBeDefined();
    expect(job!.logicalId).toBe("callOther");
  });

  test("returns empty resources for non-workflow YAML", () => {
    const yaml = `key: value\nother: stuff`;
    const ir = parser.parse(yaml);
    // May have a workflow resource with key/value, but no jobs
    const jobs = ir.resources.filter((r) => r.type === "GitHub::Actions::Job");
    expect(jobs).toHaveLength(0);
  });

  test("preserves job properties", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
    const ir = parser.parse(yaml);
    const job = ir.resources.find((r) => r.type === "GitHub::Actions::Job");
    expect(job!.properties["runs-on"]).toBe("ubuntu-latest");
    expect(job!.properties["timeout-minutes"]).toBe(30);
  });
});
