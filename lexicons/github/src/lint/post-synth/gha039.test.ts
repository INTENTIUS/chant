import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha039 } from "./gha039";

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

describe("GHA039: spoofable identity gate", () => {
  test("flags an if: gating on commit author email", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    if: \${{ github.event.head_commit.author.email == 'maintainer@example.com' }}
    steps:
      - run: echo build
`;
    const diags = gha039.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA039");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag an if: on a trustworthy signal", () => {
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
    const diags = gha039.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag a non-author field referenced without comparison", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    if: \${{ always() }}
    steps:
      - run: echo build
`;
    const diags = gha039.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
