import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha009 } from "./gha009";

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

describe("GHA009: empty matrix dimension", () => {
  test("flags empty matrix array", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: []
    steps:
      - run: echo test
`;
    const diags = gha009.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA009");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("node-version");
  });

  test("does not flag non-empty matrix", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20, 22]
    steps:
      - run: echo test
`;
    const diags = gha009.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
