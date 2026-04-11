import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw102 } from "./wfw102";

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

describe("WFW102: Production validateOnMigrate missing", () => {
  test("flags prod environment without validateOnMigrate=true", () => {
    const ctx = makeCtx(`
[environments.production]
url = "jdbc:postgresql://prod:5432/db"
cleanDisabled = true
`);
    const diags = wfw102.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW102");
    expect(diags[0].message).toContain("production");
  });

  test("passes when prod has validateOnMigrate=true", () => {
    const ctx = makeCtx(`
[environments.production]
url = "jdbc:postgresql://prod:5432/db"
cleanDisabled = true
validateOnMigrate = true
`);
    const diags = wfw102.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes when prod has validateOnMigrate=true in nested flyway section", () => {
    const ctx = makeCtx(`
[environments.production]
url = "jdbc:postgresql://prod:5432/db"

[environments.production.flyway]
validateOnMigrate = true
`);
    const diags = wfw102.check(ctx);
    expect(diags.length).toBe(0);
  });
});
