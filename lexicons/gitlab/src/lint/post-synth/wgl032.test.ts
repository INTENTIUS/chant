import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl032, nearestKnownSource } from "./wgl032";

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["gitlab", yaml]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["gitlab", yaml]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

describe("WGL032: look-alike include source", () => {
  test("nearestKnownSource flags a near-miss", () => {
    expect(nearestKnownSource("gitlab-org/gitlab")).toBeUndefined();
    expect(nearestKnownSource("gitlab-org/gitlabb")).toBe("gitlab-org/gitlab");
    expect(nearestKnownSource("totally/unrelated")).toBeUndefined();
  });

  test("flags a typo-squatted include:project", () => {
    const yaml = `include:
  - project: gitlab-org/gitlabb
    ref: v1.0.0
    file: /x.yml

stages:
  - build
`;
    const diags = wgl032.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL032");
    expect(diags[0].message).toContain("gitlab-org/gitlab");
  });

  test("does not flag an exact known source", () => {
    const yaml = `include:
  - project: gitlab-org/gitlab
    ref: v1.0.0
    file: /x.yml

stages:
  - build
`;
    const diags = wgl032.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
