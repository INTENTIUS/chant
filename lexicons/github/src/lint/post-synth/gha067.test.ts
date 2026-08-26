import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha067 } from "./gha067";

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["github", yaml]]),
    entities: new Map(),
    buildResult: { outputs: new Map([["github", yaml]]), entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

describe("GHA067: unconditional docker build with no path filter or guard", () => {
  test("flags a docker build on push with no paths filter and no if guard", () => {
    const yaml = `name: CI
on:
  push: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t app .
`;
    const diags = gha067.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA067");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag when the trigger has a paths filter", () => {
    const yaml = `name: CI
on:
  push:
    paths:
      - "src/**"
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: docker build -t app .
`;
    expect(gha067.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag when the step has an if guard", () => {
    const yaml = `name: CI
on:
  push: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: docker build -t app .
        if: github.event.head_commit.modified contains 'Dockerfile'
`;
    expect(gha067.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag a workflow with no push/pull_request trigger", () => {
    const yaml = `name: CI
on:
  workflow_dispatch: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: docker build -t app .
`;
    expect(gha067.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag a step that isn't a docker build", () => {
    const yaml = `name: CI
on:
  push: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
    expect(gha067.check(makeCtx(yaml))).toHaveLength(0);
  });
});
