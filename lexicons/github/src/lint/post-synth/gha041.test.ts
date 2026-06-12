import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha041 } from "./gha041";

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

describe("GHA041: secrets: inherit", () => {
  test("flags a reusable call with secrets: inherit", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  call:
    uses: org/repo/.github/workflows/deploy.yml@v1
    secrets: inherit
`;
    const diags = gha041.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA041");
    expect(diags[0].entity).toBe("call");
  });

  test("does not flag explicit secret pass-through", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  call:
    uses: org/repo/.github/workflows/deploy.yml@v1
    secrets:
      token: \${{ secrets.DEPLOY_TOKEN }}
`;
    const diags = gha041.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
