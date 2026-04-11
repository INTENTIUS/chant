import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha025 } from "./gha025";

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

describe("GHA025: pull_request_target without restrictions", () => {
  test("flags pull_request_target without types filter", () => {
    const yaml = `name: CI
on:
  pull_request_target:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const diags = gha025.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA025");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("types");
  });

  test("does not flag pull_request_target with types filter", () => {
    const yaml = `name: CI
on:
  pull_request_target:
    types: [labeled, opened]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const diags = gha025.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag workflow without pull_request_target", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const diags = gha025.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
