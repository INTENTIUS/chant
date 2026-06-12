import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha042 } from "./gha042";

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

describe("GHA042: whole secrets context passed", () => {
  test("flags toJSON(secrets)", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: some/action@v1
        with:
          blob: \${{ toJSON(secrets) }}
`;
    const diags = gha042.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA042");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag a specific secret reference", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: some/action@v1
        with:
          token: \${{ secrets.API_TOKEN }}
`;
    const diags = gha042.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
