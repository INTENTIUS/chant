import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl047 } from "./wgl047";

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

describe("WGL047: curl | bash runtime execution", () => {
  test("flags curl piped to bash", () => {
    const yaml = `build:
  script:
    - curl -sSL https://example.com/install.sh | bash
`;
    const diags = wgl047.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL047");
    expect(diags[0].entity).toBe("build");
  });

  test("does not flag download-then-run on separate lines", () => {
    const yaml = `build:
  script:
    - curl -sSLo install.sh https://example.com/install.sh
    - bash install.sh
`;
    const diags = wgl047.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
