import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha021 } from "./gha021";

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

describe("GHA021: checkout without pinned SHA", () => {
  test("flags checkout with tag ref", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo test
`;
    const diags = gha021.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA021");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("v4");
  });

  test("does not flag checkout with pinned SHA", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11
      - run: echo test
`;
    const diags = gha021.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-checkout actions", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
      - run: echo test
`;
    const diags = gha021.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
