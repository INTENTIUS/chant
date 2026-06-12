import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha056 } from "./gha056";

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

describe("GHA056: workflow without a name", () => {
  test("flags a workflow with no name", () => {
    const yaml = `on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    const diags = gha056.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA056");
  });

  test("does not flag a named workflow", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    const diags = gha056.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
