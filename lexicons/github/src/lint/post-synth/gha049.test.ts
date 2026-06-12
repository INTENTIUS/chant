import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha049 } from "./gha049";

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

describe("GHA049: persisted checkout credentials in artifact", () => {
  test("flags checkout + upload-artifact without persist-credentials: false", () => {
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
          path: .
`;
    const diags = gha049.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA049");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag when persist-credentials is disabled", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/upload-artifact@v4
        with:
          path: .
`;
    const diags = gha049.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag checkout without artifact upload", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo build
`;
    const diags = gha049.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
