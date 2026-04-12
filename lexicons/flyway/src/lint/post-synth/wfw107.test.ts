import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw107 } from "./wfw107";

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

describe("WFW107: Enterprise-only callback", () => {
  test("flags undo callback events", () => {
    const ctx = makeCtx(`
[flyway.callbacks]
beforeUndo = "SELECT 1"
`);
    const diags = wfw107.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW107");
    expect(diags[0].message).toContain("beforeUndo");
  });

  test("passes with non-enterprise callback events", () => {
    const ctx = makeCtx(`
[flyway.callbacks]
beforeMigrate = "SELECT 1"
`);
    const diags = wfw107.check(ctx);
    expect(diags.length).toBe(0);
  });
});
