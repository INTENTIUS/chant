import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl039 } from "./wgl039";

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

describe("WGL039: secret echoed to logs", () => {
  test("flags echo of a secret variable", () => {
    const yaml = `debug:
  script:
    - echo $API_TOKEN
`;
    const diags = wgl039.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL039");
    expect(diags[0].entity).toBe("debug");
  });

  test("does not flag a normal echo", () => {
    const yaml = `build:
  script:
    - echo "building the project"
`;
    const diags = wgl039.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
