import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl029 } from "./wgl029";

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

describe("WGL029: unpinned include:project / component", () => {
  test("flags include:project on a branch ref", () => {
    const yaml = `include:
  - project: my-group/ci-templates
    ref: main
    file: /templates/build.yml

stages:
  - build
`;
    const diags = wgl029.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL029");
    expect(diags[0].message).toContain("main");
  });

  test("flags include:project with no ref", () => {
    const yaml = `include:
  - project: my-group/ci-templates
    file: /templates/build.yml

stages:
  - build
`;
    const diags = wgl029.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("default branch");
  });

  test("does not flag a pinned tag ref", () => {
    const yaml = `include:
  - project: my-group/ci-templates
    ref: v1.2.3
    file: /templates/build.yml

stages:
  - build
`;
    const diags = wgl029.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("flags a floating component version and not a pinned one", () => {
    const floating = `include:
  - component: gitlab.example.com/my-group/my-comp@main

stages:
  - build
`;
    const pinned = `include:
  - component: gitlab.example.com/my-group/my-comp@1.0.0

stages:
  - build
`;
    expect(wgl029.check(makeCtx(floating))).toHaveLength(1);
    expect(wgl029.check(makeCtx(pinned))).toHaveLength(0);
  });
});
