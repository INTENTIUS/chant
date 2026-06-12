import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha038 } from "./gha038";

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

describe("GHA038: workflow_run with checkout", () => {
  test("flags checkout under workflow_run", () => {
    const yaml = `name: Followup
on:
  workflow_run:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo build
`;
    const diags = gha038.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA038");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag workflow_run without checkout", () => {
    const yaml = `name: Followup
on:
  workflow_run:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    const diags = gha038.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag checkout on a safe trigger", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const diags = gha038.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
