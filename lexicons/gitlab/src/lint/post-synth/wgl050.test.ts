import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl050 } from "./wgl050";

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["gitlab", yaml]]),
    entities: new Map(),
    buildResult: { outputs: new Map([["gitlab", yaml]]), entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

describe("WGL050: merge-request job missing interruptible", () => {
  test("flags a merge-request-reachable job with no interruptible: true", () => {
    const yaml = `test:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - npm test
`;
    const diags = wgl050.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL050");
    expect(diags[0].entity).toBe("test");
  });

  test("does not flag when interruptible: true is set", () => {
    const yaml = `test:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  interruptible: true
  script:
    - npm test
`;
    expect(wgl050.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag a deploy job", () => {
    const yaml = `deploy-app:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - ./deploy.sh
`;
    expect(wgl050.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag a job not reachable from merge requests", () => {
    const yaml = `test:
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
  script:
    - npm test
`;
    expect(wgl050.check(makeCtx(yaml))).toHaveLength(0);
  });
});
