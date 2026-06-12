import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha031, editDistance, nearestLookAlike } from "./gha031";

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

describe("GHA031: look-alike action reference", () => {
  test("editDistance basics", () => {
    expect(editDistance("abc", "abc", 2)).toBe(0);
    expect(editDistance("actions/chekout", "actions/checkout", 2)).toBe(1);
    expect(editDistance("totally/different-name-xyz", "actions/checkout", 2)).toBe(3);
  });

  test("nearestLookAlike returns the close known slug", () => {
    expect(nearestLookAlike("actions/checkout")).toBeUndefined(); // exact match
    expect(nearestLookAlike("actions/chekout")).toBe("actions/checkout");
    expect(nearestLookAlike("totally/unrelated")).toBeUndefined();
  });

  test("flags a typo-squatted action", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkoutt@v4
`;
    const diags = gha031.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA031");
    expect(diags[0].message).toContain("actions/checkout");
  });

  test("does not flag a legitimate exact known action", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const diags = gha031.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag an unrelated third-party action", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: my-org/my-custom-thing@v1
`;
    const diags = gha031.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
