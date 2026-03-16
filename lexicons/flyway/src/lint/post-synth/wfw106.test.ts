import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw106 } from "./wfw106";

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

describe("WFW106: Invalid callback event", () => {
  test("flags unknown callback event name", () => {
    const ctx = makeCtx(`
[flyway.callbacks]
beforeMigratte = "SELECT 1"
`);
    const diags = wfw106.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW106");
    expect(diags[0].message).toContain("beforeMigratte");
  });

  test("passes with valid callback event name", () => {
    const ctx = makeCtx(`
[flyway.callbacks]
beforeMigrate = "SELECT 1"
`);
    const diags = wfw106.check(ctx);
    expect(diags.length).toBe(0);
  });
});
