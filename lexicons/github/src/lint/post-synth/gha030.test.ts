import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha030 } from "./gha030";

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

describe("GHA030: container image without digest", () => {
  test("flags a container image pinned to a tag", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    container:
      image: node:20
    steps:
      - run: echo build
`;
    const diags = gha030.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA030");
    expect(diags[0].entity).toBe("build");
    expect(diags[0].message).toContain("node:20");
  });

  test("flags a service image pinned to a tag", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    services:
      redis:
        image: redis:7
    steps:
      - run: echo build
`;
    const diags = gha030.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("redis:7");
  });

  test("flags a docker:// step reference without digest", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: docker://alpine:3.19
`;
    const diags = gha030.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("alpine:3.19");
  });

  test("does not flag a container image pinned to a digest", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    container:
      image: node@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    steps:
      - run: echo build
`;
    const diags = gha030.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
