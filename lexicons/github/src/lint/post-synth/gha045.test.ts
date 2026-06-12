import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha045 } from "./gha045";

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

describe("GHA045: secret interpolated into run:", () => {
  test("flags a secret interpolated into a run command", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: curl -H "Authorization: \${{ secrets.API_TOKEN }}" https://example.com
`;
    const diags = gha045.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA045");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag a secret passed via env (the recommended form)", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - env:
          TOKEN: \${{ secrets.API_TOKEN }}
        run: curl -H "Authorization: $TOKEN" https://example.com
`;
    const diags = gha045.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
