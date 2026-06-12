import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha043 } from "./gha043";

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

describe("GHA043: secret without environment gate (inconsistent gating)", () => {
  test("flags a secret-using job with no environment when others are gated", () => {
    const yaml = `name: CD
on:
  push:
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: echo deploy
  notify:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ secrets.SLACK_TOKEN }}
`;
    const diags = gha043.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA043");
    expect(diags[0].entity).toBe("notify");
  });

  test("does not flag when the secret-using job is itself gated", () => {
    const yaml = `name: CD
on:
  push:
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: echo \${{ secrets.DEPLOY_TOKEN }}
`;
    const diags = gha043.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not fire when no job uses an environment (GHA026 territory)", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ secrets.TOKEN }}
`;
    const diags = gha043.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
