import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha048 } from "./gha048";

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

describe("GHA048: obfuscated guard condition", () => {
  test("flags an operand built with format() in a comparison", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    if: \${{ format('{0}', github.actor) == 'octocat' }}
    steps:
      - run: echo build
`;
    const diags = gha048.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA048");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag a direct comparison", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    if: \${{ github.actor == 'octocat' }}
    steps:
      - run: echo build
`;
    const diags = gha048.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
