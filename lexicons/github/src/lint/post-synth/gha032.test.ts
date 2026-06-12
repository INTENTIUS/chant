import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha032 } from "./gha032";

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

describe("GHA032: archived or compromised action", () => {
  test("flags a known compromised action", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: tj-actions/changed-files@v44
`;
    const diags = gha032.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA032");
    expect(diags[0].entity).toBe("build");
    expect(diags[0].message).toContain("tj-actions/changed-files");
  });

  test("flags a known archived action", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-ruby@v1
`;
    const diags = gha032.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("ruby/setup-ruby");
  });

  test("does not flag a maintained action", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
`;
    const diags = gha032.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
