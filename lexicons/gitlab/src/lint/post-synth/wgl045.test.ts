import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl045 } from "./wgl045";

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

describe("WGL045: credential-bearing artifact path", () => {
  test("flags an artifact path that captures .env", () => {
    const yaml = `build:
  artifacts:
    paths:
      - dist/
      - .env
  script:
    - make
`;
    const diags = wgl045.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL045");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain(".env");
  });

  test("does not flag ordinary build output paths", () => {
    const yaml = `build:
  artifacts:
    paths:
      - dist/
      - build/output.js
  script:
    - make
`;
    const diags = wgl045.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
