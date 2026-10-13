import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha019 } from "./gha019";

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

describe("GHA019: circular needs chain", () => {
  test("detects simple cycle", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    needs: [deploy]
    steps:
      - run: echo build
  deploy:
    runs-on: ubuntu-latest
    needs: [build]
    steps:
      - run: echo deploy
`;
    const diags = gha019.check(makeCtx(yaml));
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("GHA019");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("\u2192");
  });

  test("does not flag acyclic graph", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  test:
    runs-on: ubuntu-latest
    needs: [build]
    steps:
      - run: echo test
  deploy:
    runs-on: ubuntu-latest
    needs: [test]
    steps:
      - run: echo deploy
`;
    const diags = gha019.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("detects a cycle through scalar needs: (#3201)", () => {
    const yaml = `name: CI
on: push
jobs:
  a:
    needs: b
    runs-on: ubuntu-latest
    steps:
      - run: echo a
  b:
    needs: a
    runs-on: ubuntu-latest
    steps:
      - run: echo b
`;
    const diags = gha019.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
  });

  test("no false cycle when a later job id has an underscore (#3201)", () => {
    // The line-based extractJobs did not split on "extra_thing", so its
    // needs: landed on shared-alb and read as shared-alb -> shared-alb.
    // generateGithubPipeline emits this shape for a component named Extra_Thing.
    const yaml = `name: chant-components
on:
  workflow_dispatch: {}
jobs:
  shared-alb:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
  extra_thing:
    runs-on: ubuntu-latest
    needs:
      - shared-alb
    steps:
      - uses: actions/checkout@v7
`;
    const diags = gha019.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
