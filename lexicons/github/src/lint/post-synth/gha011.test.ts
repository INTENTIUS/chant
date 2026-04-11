import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha011 } from "./gha011";

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

describe("GHA011: invalid needs reference", () => {
  test("flags needs referencing non-existent job", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  deploy:
    runs-on: ubuntu-latest
    needs: [build, test]
    steps:
      - run: echo deploy
`;
    const diags = gha011.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA011");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("test");
    expect(diags[0].message).toContain("deploy");
  });

  test("does not flag valid needs", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  deploy:
    runs-on: ubuntu-latest
    needs: [build]
    steps:
      - run: echo deploy
`;
    const diags = gha011.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
