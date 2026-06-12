import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha052 } from "./gha052";

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

describe("GHA052: curl | bash runtime execution", () => {
  test("flags curl piped to bash", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: curl -sSL https://example.com/install.sh | bash
`;
    const diags = gha052.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA052");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag download-then-verify", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -sSLo install.sh https://example.com/install.sh
          echo "abc123  install.sh" | sha256sum -c
          bash install.sh
`;
    const diags = gha052.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
