import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw108 } from "./wfw108";

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

describe("WFW108: Missing environment URL", () => {
  test("flags environment without url", () => {
    const ctx = makeCtx(`
[environments.dev]
user = "admin"
`);
    const diags = wfw108.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW108");
    expect(diags[0].message).toContain("dev");
  });

  test("passes when environment has url", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/db"
`);
    const diags = wfw108.check(ctx);
    expect(diags.length).toBe(0);
  });
});
