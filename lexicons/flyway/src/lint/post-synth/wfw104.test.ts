import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw104 } from "./wfw104";

function makeCtx(toml: string): PostSynthContext {
  return {
    outputs: new Map([["flyway", toml]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["flyway", toml]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

describe("WFW104: Unresolved resolver reference", () => {
  test("flags resolver ref without corresponding resolver config", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "\${vault.db-url}"
`);
    const diags = wfw104.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW104");
    expect(diags[0].message).toContain("vault");
  });

  test("passes when flyway prefix is used (built-in)", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "\${flyway.db-url}"
`);
    const diags = wfw104.check(ctx);
    expect(diags.length).toBe(0);
  });
});
