import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl049 } from "./wgl049";

function makeCtx(yaml: string): PostSynthContext {
  return {
    outputs: new Map([["gitlab", yaml]]),
    entities: new Map(),
    buildResult: { outputs: new Map([["gitlab", yaml]]), entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
  };
}

describe("WGL049: dependency install without a cache", () => {
  test("flags a job that installs deps with no cache in scope", () => {
    const yaml = `build:
  stage: build
  script:
    - npm ci
    - npm run build
`;
    const diags = wgl049.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL049");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag when the job has its own cache", () => {
    const yaml = `build:
  stage: build
  cache:
    key: npm-cache
    paths:
      - node_modules/
  script:
    - npm ci
`;
    expect(wgl049.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag when a pipeline-wide cache: block exists", () => {
    const yaml = `cache:
  key: global
  paths:
    - node_modules/

build:
  stage: build
  script:
    - npm ci
`;
    expect(wgl049.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag a job that extends another config", () => {
    const yaml = `build:
  extends: .node-job
  script:
    - npm ci
`;
    expect(wgl049.check(makeCtx(yaml))).toHaveLength(0);
  });

  test("does not flag a job with no dependency install command", () => {
    const yaml = `lint:
  stage: test
  script:
    - eslint .
`;
    expect(wgl049.check(makeCtx(yaml))).toHaveLength(0);
  });
});

describe("WGL049: job ids and section boundaries (#3256)", () => {
  test("flags a job whose id starts with a capital", () => {
    const yaml = `Build_App:
  script:
    - npm ci
`;
    const diags = wgl049.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].entity).toBe("Build_App");
  });

  test("a cache: in the next job is not read as this job's cache", () => {
    const yaml = `build:
  script:
    - npm ci
other:
  cache:
    paths: [node_modules/]
  script: echo
`;
    const diags = wgl049.check(makeCtx(yaml));
    expect(diags.map((d) => d.entity)).toEqual(["build"]);
  });
});
