import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha066 } from "./gha066";

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["github", yaml]]),
    entities: new Map(),
    buildResult: { outputs: new Map([["github", yaml]]), entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

describe("GHA066: unbounded artifact retention", () => {
  test("flags upload-artifact with no retention-days", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: dist/
`;
    const diags = gha066.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA066");
    expect(diags[0].entity).toBe("build");
    expect(diags[0].message).toContain("build-output");
  });

  test("does not flag upload-artifact with retention-days set", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-artifact@v4
        with:
          name: build-output
          path: dist/
          retention-days: 7
`;
    expect(gha066.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag a job with no artifact upload", () => {
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
    expect(gha066.check(makeCtx(yaml))).toHaveLength(0);
  });
});
