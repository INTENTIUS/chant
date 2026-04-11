import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha026 } from "./gha026";

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

describe("GHA026: secret without environment protection", () => {
  test("flags secrets usage without environment", () => {
    const yaml = `name: Deploy
on:
  push:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo secrets.DEPLOY_KEY
`;
    const diags = gha026.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA026");
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("secrets");
  });

  test("does not flag secrets with environment", () => {
    const yaml = `name: Deploy
on:
  push:
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: echo secrets.DEPLOY_KEY
`;
    const diags = gha026.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag workflow without secrets", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo test
`;
    const diags = gha026.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
