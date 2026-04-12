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
});
