import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha065 } from "./gha065";

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["github", yaml]]),
    entities: new Map(),
    buildResult: { outputs: new Map([["github", yaml]]), entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

describe("GHA065: unbounded matrix fan-out", () => {
  test("flags a large multi-dimension matrix with no max-parallel", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [14, 16, 18, 20, 22]
    runs-on: \${{ matrix.os }}
    steps:
      - run: npm test
`;
    const diags = gha065.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA065");
    expect(diags[0].entity).toBe("build");
    expect(diags[0].message).toContain("15 jobs");
  });

  test("does not flag when max-parallel caps the fan-out", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    strategy:
      max-parallel: 4
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [14, 16, 18, 20, 22]
    runs-on: \${{ matrix.os }}
    steps:
      - run: npm test
`;
    expect(gha065.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag a small matrix under the threshold", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [18, 20]
    runs-on: \${{ matrix.os }}
    steps:
      - run: npm test
`;
    expect(gha065.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag a single-dimension matrix", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    strategy:
      matrix:
        node: [16, 18, 20, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22]
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
    expect(gha065.check(makeCtx(yaml))).toHaveLength(0);
  });
});
