import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha040 } from "./gha040";

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

describe("GHA040: self-hosted runner on untrusted trigger", () => {
  test("flags self-hosted runner under pull_request", () => {
    const yaml = `name: CI
on:
  pull_request:
jobs:
  build:
    runs-on: self-hosted
    steps:
      - run: echo build
`;
    const diags = gha040.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA040");
    expect(diags[0].entity).toBe("build");
  });

  test("flags self-hosted in an array runs-on under workflow_run", () => {
    const yaml = `name: CI
on:
  workflow_run:
jobs:
  build:
    runs-on: [self-hosted, linux]
    steps:
      - run: echo build
`;
    const diags = gha040.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
  });

  test("does not flag GitHub-hosted runner under untrusted trigger", () => {
    const yaml = `name: CI
on:
  pull_request:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    const diags = gha040.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag self-hosted on a safe trigger", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: self-hosted
    steps:
      - run: echo build
`;
    const diags = gha040.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
