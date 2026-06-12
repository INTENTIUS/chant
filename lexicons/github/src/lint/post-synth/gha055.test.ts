import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha055 } from "./gha055";

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

describe("GHA055: redundant runtime install", () => {
  test("flags apt-get install of a preinstalled tool", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: sudo apt-get install -y jq
`;
    const diags = gha055.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA055");
    expect(diags[0].message).toContain("jq");
  });

  test("does not flag installing a tool not on the runner", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: sudo apt-get install -y libpq-dev
`;
    const diags = gha055.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
