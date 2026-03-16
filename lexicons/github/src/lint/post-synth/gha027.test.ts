import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha027 } from "./gha027";

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

describe("GHA027: missing if: always() on cleanup steps", () => {
  test("check is exported with correct id", () => {
    expect(gha027.id).toBe("GHA027");
    expect(typeof gha027.check).toBe("function");
  });

  test("does not flag workflows without cleanup step names", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: npm run build
      - run: npm test
`;
    const diags = gha027.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag empty workflow", () => {
    const yaml = `name: CI
on:
  push:
`;
    const diags = gha027.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
