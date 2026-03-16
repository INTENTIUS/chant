import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha020 } from "./gha020";

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

describe("GHA020: missing job-level permissions for sensitive triggers", () => {
  test("flags job without permissions when using pull_request_target", () => {
    const yaml = `name: Review
on:
  pull_request_target:
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - run: echo review
`;
    const diags = gha020.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA020");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("review");
  });

  test("flags job without permissions when using workflow_dispatch", () => {
    const yaml = `name: Manual
on:
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`;
    const diags = gha020.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA020");
    expect(diags[0].message).toContain("deploy");
  });

  test("does not flag when trigger is not sensitive", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    const diags = gha020.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
