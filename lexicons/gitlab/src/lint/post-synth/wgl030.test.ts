import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wgl030 } from "./wgl030";

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

describe("WGL030: mutable or insecure include:remote", () => {
  test("errors on an HTTP remote include", () => {
    const yaml = `include:
  - remote: http://example.com/ci.yml

stages:
  - build
`;
    const diags = wgl030.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WGL030");
    expect(diags[0].severity).toBe("error");
  });

  test("warns on an HTTPS remote include", () => {
    const yaml = `include:
  - remote: https://example.com/ci.yml

stages:
  - build
`;
    const diags = wgl030.check(makeCtx(yaml));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
  });

  test("does not flag a project include", () => {
    const yaml = `include:
  - project: my-group/ci-templates
    ref: v1.0.0
    file: /x.yml

stages:
  - build
`;
    const diags = wgl030.check(makeCtx(yaml));
    expect(diags).toHaveLength(0);
  });
});
