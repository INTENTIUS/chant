import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha028 } from "./gha028";

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

describe("GHA028: workflow with no on triggers", () => {
  test("flags workflow without on: block", () => {
    const yaml = `name: CI
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const diags = gha028.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA028");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("on:");
  });

  test("does not flag workflow with on: block", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const diags = gha028.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
