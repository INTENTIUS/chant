import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha063 } from "./gha063";

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["github", yaml]]),
    entities: new Map(),
    buildResult: { outputs: new Map([["github", yaml]]), entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

describe("GHA063: dependency setup without caching", () => {
  test("flags setup-node with no cache option and no cache step", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm ci
`;
    const diags = gha063.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA063");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag setup-node with cache enabled", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: npm
      - run: npm ci
`;
    expect(gha063.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag setup-node when a separate actions/cache step covers it", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - uses: actions/cache@v4
        with:
          path: ~/.npm
          key: npm-\${{ hashFiles('package-lock.json') }}
      - run: npm ci
`;
    expect(gha063.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag a job with no setup action at all", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make build
`;
    expect(gha063.check(makeCtx(yaml))).toHaveLength(0);
  });
});
