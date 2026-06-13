import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl046 } from "./wgl046";

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

describe("WGL046: cache populated in a merge-request pipeline", () => {
  test("flags a cache write reachable from merge requests", () => {
    const yaml = `build:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  cache:
    key: build-cache
    paths:
      - node_modules/
  script:
    - npm ci
`;
    const diags = wgl046.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL046");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag a pull-only cache", () => {
    const yaml = `build:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  cache:
    key: build-cache
    paths:
      - node_modules/
    policy: pull
  script:
    - npm ci
`;
    const diags = wgl046.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag a cache on a protected-only job", () => {
    const yaml = `build:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
  cache:
    key: build-cache
    paths:
      - node_modules/
  script:
    - npm ci
`;
    const diags = wgl046.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
