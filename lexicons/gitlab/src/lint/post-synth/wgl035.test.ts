import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl035 } from "./wgl035";

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

describe("WGL035: untrusted CI variable in script", () => {
  test("flags an untrusted ref name used in a script command", () => {
    const yaml = `build:
  stage: build
  script:
    - git checkout $CI_COMMIT_REF_NAME
`;
    const diags = wgl035.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL035");
    expect(diags[0].entity).toBe("build");
    expect(diags[0].message).toContain("CI_COMMIT_REF_NAME");
  });

  test("does not flag a trusted variable", () => {
    const yaml = `build:
  stage: build
  script:
    - echo "$CI_COMMIT_SHA"
`;
    const diags = wgl035.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
