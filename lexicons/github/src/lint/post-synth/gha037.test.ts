import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha037 } from "./gha037";

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

describe("GHA037: untrusted input to GITHUB_ENV / GITHUB_PATH", () => {
  test("flags untrusted input written to GITHUB_ENV", () => {
    const yaml = `name: CI
on:
  pull_request_target:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "BRANCH=\${{ github.event.pull_request.head.ref }}" >> "$GITHUB_ENV"
`;
    const diags = gha037.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA037");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("GITHUB_ENV");
  });

  test("does not flag a trusted value written to GITHUB_ENV", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "SHA=\${{ github.sha }}" >> "$GITHUB_ENV"
`;
    const diags = gha037.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag untrusted input that does not touch env files", () => {
    const yaml = `name: CI
on:
  pull_request_target:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`;
    const diags = gha037.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
