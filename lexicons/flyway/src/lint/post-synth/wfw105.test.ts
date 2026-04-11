import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw105 } from "./wfw105";

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

describe("WFW105: Empty locations", () => {
  test("flags missing flyway.locations", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/db"
`);
    const diags = wfw105.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW105");
  });

  test("passes when flyway.locations has entries", () => {
    const ctx = makeCtx(`
[flyway]
locations = ["filesystem:sql/migrations"]
`);
    const diags = wfw105.check(ctx);
    expect(diags.length).toBe(0);
  });
});
