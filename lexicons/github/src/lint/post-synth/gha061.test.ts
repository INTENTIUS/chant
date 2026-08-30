import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { gha061, evaluateUsagePolicy } from "./gha061";

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

const YAML = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: some-rando/sketchy-action@v1
`;

describe("GHA061: usage policy enforcement (opt-in)", () => {
  test("is silent when the wrapped check runs with no policy configured", () => {
    expect(gha061.check(makeCtx(YAML))).toHaveLength(0);
  });

  test("evaluateUsagePolicy returns nothing for an empty/unset policy", () => {
    expect(evaluateUsagePolicy(YAML, {})).toHaveLength(0);
  });

  test("flags a denied slug", () => {
    const diags = evaluateUsagePolicy(YAML, { deny: ["some-rando/sketchy-action"] });
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA061");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("some-rando/sketchy-action");
    expect(diags[0].message).toContain("denied");
  });

  test("flags a denied owner (bare owner entry)", () => {
    const diags = evaluateUsagePolicy(YAML, { deny: ["some-rando"] });
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("some-rando/sketchy-action");
  });

  test("flags a slug outside the allowlist", () => {
    const diags = evaluateUsagePolicy(YAML, { allow: ["actions/*"] });
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("not in the configured action-usage allowlist");
  });

  test("does not flag a slug inside the allowlist", () => {
    const diags = evaluateUsagePolicy(YAML, { allow: ["actions/*", "some-rando/*"] });
    expect(diags).toHaveLength(0);
  });

  test("deny wins over allow for the same entry", () => {
    const diags = evaluateUsagePolicy(YAML, { allow: ["actions/*", "some-rando/*"], deny: ["some-rando/sketchy-action"] });
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
  });

  test("skips local and docker references regardless of policy", () => {
    const yaml = `name: CI
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/local
      - uses: docker://alpine@sha256:abc
`;
    expect(evaluateUsagePolicy(yaml, { allow: ["actions/*"] })).toHaveLength(0);
  });
});
