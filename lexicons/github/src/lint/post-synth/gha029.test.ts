import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha029, findUnpinnedActions } from "./gha029";

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

describe("GHA029: unpinned action / reusable workflow", () => {
  test("flags a step action pinned to a tag", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
      - run: echo build
`;
    const diags = gha029.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA029");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].entity).toBe("build");
    expect(diags[0].message).toContain("actions/setup-node@v4");
  });

  test("flags a job-level reusable workflow pinned to a tag", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  call:
    uses: org/repo/.github/workflows/reusable.yml@v1
`;
    const diags = gha029.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("reusable.yml@v1");
  });

  test("does not flag an action pinned to a full SHA", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b
      - run: echo build
`;
    const diags = gha029.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag a SHA pin with a trailing version comment", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b # v4.0.2
      - run: echo build
`;
    const diags = gha029.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag actions/checkout (owned by GHA021)", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const diags = gha029.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag local actions", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/local
`;
    const diags = gha029.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("allowlist exempts a trusted owner", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: trustedco/action@v1
`;
    expect(findUnpinnedActions(yaml)).toHaveLength(1);
    expect(findUnpinnedActions(yaml, new Set(["trustedco"]))).toHaveLength(0);
  });
});
