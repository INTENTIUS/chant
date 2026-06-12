import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha035 } from "./gha035";

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["github", yaml]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["github", yaml]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

describe("GHA035: elevated scope on untrusted-code trigger", () => {
  test("errors on workflow-level write with pull_request_target", () => {
    const yaml = `name: Review
on:
  pull_request_target:
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    const diags = gha035.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA035");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("pull_request_target");
  });

  test("errors on job-level write-all with workflow_run", () => {
    const yaml = `name: Followup
on:
  workflow_run:
jobs:
  build:
    runs-on: ubuntu-latest
    permissions: write-all
    steps:
      - run: echo build
`;
    const diags = gha035.check(makeCtx(yaml));
    expect(diags.some((d) => d.severity === "error" && d.entity === "build")).toBe(true);
  });

  test("does not flag write scope on a safe trigger", () => {
    const yaml = `name: CI
on:
  push:
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    const diags = gha035.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag read-only scope on untrusted trigger", () => {
    const yaml = `name: Review
on:
  pull_request_target:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    const diags = gha035.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
