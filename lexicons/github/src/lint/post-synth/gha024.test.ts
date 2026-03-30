import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha024 } from "./gha024";

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

describe("GHA024: missing concurrency for deploy workflow", () => {
  test("flags deploy workflow without concurrency", () => {
    const yaml = `name: Deploy
on:
  push:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`;
    const diags = gha024.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA024");
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("concurrency");
  });

  test("does not flag deploy workflow with concurrency", () => {
    const yaml = `name: Deploy
on:
  push:
concurrency:
  group: deploy
  cancel-in-progress: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo deploy
`;
    const diags = gha024.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag deploy workflow with job-level concurrency", () => {
    const yaml = `name: CI/CD Pipeline
on:
  push:
jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency:
      group: deploy-production
      cancel-in-progress: true
    steps:
      - run: echo deploy
`;
    const diags = gha024.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag non-deploy workflow without concurrency", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo build
`;
    const diags = gha024.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
