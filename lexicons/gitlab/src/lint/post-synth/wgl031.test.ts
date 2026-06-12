import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl031 } from "./wgl031";

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

describe("WGL031: container image without digest", () => {
  test("flags an image pinned to a tag", () => {
    const yaml = `build-job:
  image:
    name: node:20
  script:
    - echo build
`;
    const diags = wgl031.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL031");
    expect(diags[0].message).toContain("node:20");
  });

  test("flags a service image pinned to a tag", () => {
    const yaml = `build-job:
  services:
    - name: postgres:16
  script:
    - echo build
`;
    const diags = wgl031.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("postgres:16");
  });

  test("does not flag an image pinned to a digest", () => {
    const yaml = `build-job:
  image:
    name: node@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
  script:
    - echo build
`;
    const diags = wgl031.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag a variable-based image reference", () => {
    const yaml = `build-job:
  image:
    name: $CI_REGISTRY_IMAGE:latest
  script:
    - echo build
`;
    const diags = wgl031.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
