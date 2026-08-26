import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha064 } from "./gha064";

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["github", yaml]]),
    entities: new Map(),
    buildResult: { outputs: new Map([["github", yaml]]), entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

describe("GHA064: expensive runner without justification", () => {
  test("flags a macOS runner with no macOS-specific step", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;
    const diags = gha064.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA064");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag macOS when a step is Xcode-specific", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - run: xcodebuild -scheme App build
`;
    expect(gha064.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag runs-on driven by a matrix expression", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - run: npm test
`;
    expect(gha064.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag a Linux runner", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
    expect(gha064.check(makeCtx(yaml))).toHaveLength(0);
  });
});
