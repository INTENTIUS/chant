import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfj010 } from "./wfj010";
import { wfj011 } from "./wfj011";

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

describe("WFJ010: unresolved action reference", () => {
  test("flags a bare owner/repo ref", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: docker
    steps:
      - uses: some-org/custom-action@v1
`;
    const diags = wfj010.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WFJ010");
    expect(diags[0].message).toContain("some-org/custom-action@v1");
  });

  test("does not flag a resolved full-URL ref", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: docker
    steps:
      - uses: https://code.forgejo.org/actions/checkout@v4
`;
    expect(wfj010.check(makeCtx(yaml))).toHaveLength(0);
  });
});

describe("WFJ011: GitHub-hosted runner label", () => {
  test("flags a macos-latest label", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: macos-latest
    steps:
      - run: echo hi
`;
    const diags = wfj011.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WFJ011");
    expect(diags[0].message).toContain("macos-latest");
  });

  test("does not flag a mapped Forgejo label", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: docker
    steps:
      - run: echo hi
`;
    expect(wfj011.check(makeCtx(yaml))).toHaveLength(0);
  });
});
