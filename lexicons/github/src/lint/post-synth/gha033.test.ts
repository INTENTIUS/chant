import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha033 } from "./gha033";

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

describe("GHA033: blanket write-all permissions", () => {
  test("flags workflow-level write-all", () => {
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
    const diags = gha033.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA033");
    expect(diags[0].message).toContain("write-all");
  });

  test("flags job-level write-all", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    permissions: write-all
    steps:
      - run: echo build
`;
    const diags = gha033.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag scoped permissions", () => {
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
    const diags = gha033.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
