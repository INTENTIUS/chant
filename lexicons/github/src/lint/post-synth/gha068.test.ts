import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha068 } from "./gha068";

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["github", yaml]]),
    entities: new Map(),
    buildResult: { outputs: new Map([["github", yaml]]), entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

describe("GHA068: pull-request workflow missing a concurrency group", () => {
  test("flags a pull_request workflow with no concurrency block", () => {
    const yaml = `name: CI
on:
  pull_request: {}
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
    const diags = gha068.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA068");
    expect(diags[0].message).toContain("CI");
  });

  test("does not flag when a concurrency block is present", () => {
    const yaml = `name: CI
on:
  pull_request: {}
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
    expect(gha068.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag a deploy workflow (covered by GHA024)", () => {
    const yaml = `name: Deploy
on:
  pull_request: {}
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh
`;
    expect(gha068.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag a workflow with no pull_request trigger", () => {
    const yaml = `name: CI
on:
  push: {}
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;
    expect(gha068.check(makeCtx(yaml))).toHaveLength(0);
  });
});
