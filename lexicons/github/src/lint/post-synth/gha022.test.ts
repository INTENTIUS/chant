import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha022 } from "./gha022";

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

describe("GHA022: job without timeout-minutes", () => {
  test("flags job missing timeout-minutes", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const diags = gha022.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA022");
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("build");
  });

  test("does not flag workflow without jobs", () => {
    const yaml = `name: CI
on:
  push:
`;
    const diags = gha022.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
