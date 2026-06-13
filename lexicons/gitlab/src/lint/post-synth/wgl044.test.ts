import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl044 } from "./wgl044";

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

describe("WGL044: public artifacts", () => {
  test("flags artifacts:public: true", () => {
    const yaml = `build:
  artifacts:
    public: true
    paths:
      - dist/
  script:
    - make
`;
    const diags = wgl044.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL044");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag private artifacts", () => {
    const yaml = `build:
  artifacts:
    paths:
      - dist/
  script:
    - make
`;
    const diags = wgl044.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
