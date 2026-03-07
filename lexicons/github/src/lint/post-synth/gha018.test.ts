import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha018 } from "./gha018";

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

describe("GHA018: pull_request_target + checkout", () => {
  test("flags pull_request_target with checkout", () => {
    const yaml = `name: CI
on:
  pull_request_target:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
    const diags = gha018.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA018");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("checkout");
  });

  test("does not flag pull_request_target without checkout", () => {
    const yaml = `name: CI
on:
  pull_request_target:
jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - run: echo "label"
`;
    const diags = gha018.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag push trigger with checkout", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
    const diags = gha018.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
