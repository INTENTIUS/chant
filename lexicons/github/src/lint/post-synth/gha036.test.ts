import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha036 } from "./gha036";

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

describe("GHA036: untrusted input in run:", () => {
  test("flags PR title interpolated into a block-scalar run", () => {
    const yaml = `name: CI
on:
  pull_request_target:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: greet
        run: |
          echo "Title: \${{ github.event.pull_request.title }}"
`;
    const diags = gha036.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA036");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("build");
    expect(diags[0].message).toContain("github.event.pull_request.title");
  });

  test("flags head_ref interpolated into an inline run", () => {
    const yaml = `name: CI
on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ github.head_ref }}
`;
    const diags = gha036.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("github.head_ref");
  });

  test("does not flag a trusted context in run:", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ github.sha }}
`;
    const diags = gha036.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
