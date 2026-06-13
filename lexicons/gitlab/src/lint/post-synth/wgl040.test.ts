import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl040 } from "./wgl040";

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

describe("WGL040: hardcoded registry credential", () => {
  test("flags docker login with a literal password", () => {
    const yaml = `publish:
  script:
    - docker login -u ci -p hunter2 registry.example.com
`;
    const diags = wgl040.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL040");
    expect(diags[0].severity).toBe("error");
  });

  test("does not flag a variable password", () => {
    const yaml = `publish:
  script:
    - docker login -u ci -p $CI_REGISTRY_PASSWORD registry.example.com
`;
    const diags = wgl040.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });

  test("does not flag --password-stdin", () => {
    const yaml = `publish:
  script:
    - echo "$REG_PASS" | docker login -u ci --password-stdin registry.example.com
`;
    const diags = wgl040.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
