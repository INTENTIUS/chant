import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha023 } from "./gha023";

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

describe("GHA023: deprecated ::set-output command", () => {
  test("flags step using ::set-output", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "::set-output name=version::1.0.0"
      - run: echo done
`;
    const diags = gha023.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA023");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("set-output");
  });

  test("does not flag step using GITHUB_OUTPUT", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "version=1.0.0" >> $GITHUB_OUTPUT
      - run: echo done
`;
    const diags = gha023.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
