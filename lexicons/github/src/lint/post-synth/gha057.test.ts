import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { gha057 } from "./gha057";

function makeCtx(dependabotYaml: string): PostSynthContext {
  const output: SerializerResult = { primary: "", files: { "dependabot.yml": dependabotYaml } };
  return {
    outputs: new Map([["github", output]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["github", output]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

describe("GHA057: dependency update executing untrusted code", () => {
  test("flags insecure-external-code-execution: allow", () => {
    const yaml = `version: 2

updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    insecure-external-code-execution: allow
`;
    const diags = gha057.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA057");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].entity).toBe("npm");
  });

  test("does not flag deny", () => {
    const yaml = `version: 2

updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    insecure-external-code-execution: deny
`;
    const diags = gha057.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag a workflow-only output", () => {
    const ctx: PostSynthContext = {
      outputs: new Map([["github", "name: CI\non:\n  push:\n"]]),
      entities: new Map(),
      buildResult: { outputs: new Map(), entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
    };
    expect(gha057.check(ctx)).toHaveLength(0);
  });
});
