import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha046, unsoundReason } from "./gha046";

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

describe("GHA046: unsound guard condition", () => {
  test("unsoundReason classifies constants", () => {
    expect(unsoundReason("true")).toContain("always true");
    expect(unsoundReason("${{ false }}")).toContain("always false");
    expect(unsoundReason("${{ success() || true }}")).toContain("always true");
    expect(unsoundReason("${{ github.ref == github.ref }}")).toContain("always true");
    expect(unsoundReason("${{ github.ref == 'refs/heads/main' }}")).toBeUndefined();
  });

  test("flags an always-true literal gate", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    if: true
    steps:
      - run: echo build
`;
    const diags = gha046.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA046");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag a real condition", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    if: \${{ github.ref == 'refs/heads/main' }}
    steps:
      - run: echo build
`;
    const diags = gha046.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
