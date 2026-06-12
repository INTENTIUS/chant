import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha054 } from "./gha054";

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

describe("GHA054: known-bad feature usage", () => {
  test("flags deprecated ::set-output::", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "::set-output name=version::1.0.0"
`;
    const diags = gha054.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA054");
    expect(diags[0].message).toContain("set-output");
  });

  test("does not flag $GITHUB_OUTPUT usage", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "version=1.0.0" >> "$GITHUB_OUTPUT"
`;
    const diags = gha054.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
