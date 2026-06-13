import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl038 } from "./wgl038";

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

describe("WGL038: secret reachable from merge requests", () => {
  test("flags a user secret used in a merge-request-reachable job", () => {
    const yaml = `deploy:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - curl -H "Auth: $DEPLOY_TOKEN" https://api.example.com
`;
    const diags = wgl038.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL038");
    expect(diags[0].message).toContain("DEPLOY_TOKEN");
  });

  test("does not flag a built-in CI_ token", () => {
    const yaml = `deploy:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - echo "$CI_JOB_TOKEN" | docker login --password-stdin
`;
    const diags = wgl038.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag a secret gated to a protected branch", () => {
    const yaml = `deploy:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
  script:
    - curl -H "Auth: $DEPLOY_TOKEN" https://api.example.com
`;
    const diags = wgl038.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
