import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { DECLARABLE_MARKER, type Declarable } from "@intentius/chant/declarable";
import { wgl010 } from "./wgl010";
import { wgl011 } from "./wgl011";

// ── Helpers ─────────────────────────────────────────────────────────

class MockJob implements Declarable {
  readonly [DECLARABLE_MARKER] = true as const;
  readonly lexicon = "gitlab";
  readonly entityType = "GitLab::CI::Job";
  readonly kind = "resource" as const;
  readonly props: Record<string, unknown>;

  constructor(props: Record<string, unknown> = {}) {
    this.props = props;
  }
}

function makeCtx(
  yaml: string,
  entities: Map<string, Declarable> = new Map(),
): PostSynthContext {
  return {
    outputs: new Map([["gitlab", yaml]]),
    entities,
    buildResult: {
      outputs: new Map([["gitlab", yaml]]),
      entities,
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

// ── WGL010: Undefined stage ─────────────────────────────────────────

describe("WGL010: undefined stage", () => {
  test("flags job referencing undefined stage", () => {
    const yaml = `stages:
  - build
  - test

deploy-app:
  stage: deploy
  script:
    - deploy.sh
`;
    const diags = wgl010.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL010");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("deploy");
    expect(diags[0].message).toContain("deploy-app");
  });

  test("does not flag job with valid stage", () => {
    const yaml = `stages:
  - build
  - test

test-job:
  stage: test
  script:
    - npm test
`;
    const diags = wgl010.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag when no stages are defined", () => {
    const yaml = `test-job:
  script:
    - npm test
`;
    const diags = wgl010.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("flags multiple jobs with undefined stages", () => {
    const yaml = `stages:
  - build

deploy-job:
  stage: deploy
  script:
    - deploy.sh

release-job:
  stage: release
  script:
    - release.sh
`;
    const diags = wgl010.check(makeCtx(yaml));
    expect(diags).toHaveLength(2);
  });
});

// ── WGL011: Unreachable job ─────────────────────────────────────────

describe("WGL011: unreachable job", () => {
  test("flags job where all rules have when: never", () => {
    const entities = new Map<string, Declarable>();
    entities.set("neverJob", new MockJob({
      script: ["test"],
      rules: [
        { when: "never" },
        { when: "never" },
      ],
    }));

    const diags = wgl011.check(makeCtx("", entities));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL011");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("neverJob");
  });

  test("does not flag job with reachable rules", () => {
    const entities = new Map<string, Declarable>();
    entities.set("okJob", new MockJob({
      script: ["test"],
      rules: [
        { if: "$CI_COMMIT_BRANCH", when: "always" },
        { when: "never" },
      ],
    }));

    const diags = wgl011.check(makeCtx("", entities));
    expect(diags).toHaveLength(0);
  });

  test("does not flag job without rules", () => {
    const entities = new Map<string, Declarable>();
    entities.set("simpleJob", new MockJob({
      script: ["test"],
    }));

    const diags = wgl011.check(makeCtx("", entities));
    expect(diags).toHaveLength(0);
  });

  test("does not flag job with empty rules array", () => {
    const entities = new Map<string, Declarable>();
    entities.set("emptyRulesJob", new MockJob({
      script: ["test"],
      rules: [],
    }));

    const diags = wgl011.check(makeCtx("", entities));
    expect(diags).toHaveLength(0);
  });
});
