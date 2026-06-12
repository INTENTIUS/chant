import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha047 } from "./gha047";

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

describe("GHA047: reversed contains() guard", () => {
  test("flags contains('literal', dynamic)", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    if: \${{ contains('refs/heads/main', github.ref) }}
    steps:
      - run: echo build
`;
    const diags = gha047.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA047");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag normal contains(dynamic, 'literal')", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    if: \${{ contains(github.event.pull_request.labels.*.name, 'bug') }}
    steps:
      - run: echo build
`;
    const diags = gha047.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag contains() of two literals", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    if: \${{ contains('abc', 'b') }}
    steps:
      - run: echo build
`;
    const diags = gha047.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
