import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { gha058 } from "./gha058";

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

describe("GHA058: dependency update without cooldown", () => {
  test("flags an update with no cooldown", () => {
    const yaml = `version: 2

updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
`;
    const diags = gha058.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("GHA058");
    expect(diags[0].entity).toBe("npm");
  });

  test("does not flag an update with a cooldown window", () => {
    const yaml = `version: 2

updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 7
`;
    const diags = gha058.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("flags an all-zero cooldown", () => {
    const yaml = `version: 2

updates:
  - package-ecosystem: pip
    directory: /
    schedule:
      interval: daily
    cooldown:
      default-days: 0
`;
    const diags = gha058.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("pip");
  });
});
