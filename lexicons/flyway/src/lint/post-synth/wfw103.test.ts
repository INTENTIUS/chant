import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw103 } from "./wfw103";

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

describe("WFW103: Production baselineOnMigrate", () => {
  test("flags prod environment with baselineOnMigrate=true", () => {
    const ctx = makeCtx(`
[environments.prod]
url = "jdbc:postgresql://prod:5432/db"
baselineOnMigrate = true
`);
    const diags = wfw103.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW103");
    expect(diags[0].message).toContain("baselineOnMigrate");
  });

  test("passes when prod does not have baselineOnMigrate=true", () => {
    const ctx = makeCtx(`
[environments.prod]
url = "jdbc:postgresql://prod:5432/db"
baselineOnMigrate = false
`);
    const diags = wfw103.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags prod with baselineOnMigrate=true in nested flyway section", () => {
    const ctx = makeCtx(`
[environments.prod]
url = "jdbc:postgresql://prod:5432/db"

[environments.prod.flyway]
baselineOnMigrate = true
`);
    const diags = wfw103.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW103");
  });
});
