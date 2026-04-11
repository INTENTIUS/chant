import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha017 } from "./gha017";

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

describe("GHA017: missing permissions", () => {
  test("flags workflow without permissions", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const diags = gha017.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA017");
    expect(diags[0].severity).toBe("info");
  });

  test("does not flag workflow with permissions", () => {
    const yaml = `name: CI
on:
  push:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const diags = gha017.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
