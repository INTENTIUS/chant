import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha034 } from "./gha034";

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

describe("GHA034: workflow-wide write scope", () => {
  test("flags a workflow-level write scope", () => {
    const yaml = `name: CI
on:
  push:
permissions:
  contents: write
  packages: write
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    const diags = gha034.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA034");
    expect(diags[0].message).toContain("contents");
    expect(diags[0].message).toContain("packages");
  });

  test("does not flag workflow-level read-only scopes", () => {
    const yaml = `name: CI
on:
  push:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    const diags = gha034.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag write-all (owned by GHA033)", () => {
    const yaml = `name: CI
on:
  push:
permissions: write-all
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    const diags = gha034.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag job-scoped write (the recommended form)", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - run: echo build
`;
    const diags = gha034.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
