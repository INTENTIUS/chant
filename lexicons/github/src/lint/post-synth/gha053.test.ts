import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha053 } from "./gha053";

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

describe("GHA053: unsafe workflow-command opt-in", () => {
  test("flags ACTIONS_ALLOW_UNSECURE_COMMANDS", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      ACTIONS_ALLOW_UNSECURE_COMMANDS: true
    steps:
      - run: echo build
`;
    const diags = gha053.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA053");
    expect(diags[0].severity).toBe("error");
  });

  test("flags ::set-env:: emission", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "::set-env name=FOO::bar"
`;
    const diags = gha053.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
  });

  test("does not flag normal env file usage", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "FOO=bar" >> "$GITHUB_ENV"
`;
    const diags = gha053.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
