import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl036 } from "./wgl036";

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

describe("WGL036: privileged DinD reachable from merge requests", () => {
  test("flags DinD in a merge-request-reachable job", () => {
    const yaml = `build:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  image: docker:24
  services:
    - docker:24-dind
  script:
    - docker build .
`;
    const diags = wgl036.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL036");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag DinD gated to a protected branch", () => {
    const yaml = `build:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
  image: docker:24
  services:
    - docker:24-dind
  script:
    - docker build .
`;
    const diags = wgl036.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
