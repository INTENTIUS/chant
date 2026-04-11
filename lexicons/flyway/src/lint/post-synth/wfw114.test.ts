import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw114 } from "./wfw114";

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

describe("WFW114: Missing undo scripts with baselineOnMigrate", () => {
  test("passes when baselineOnMigrate is not set", () => {
    const ctx = makeCtx(`
[flyway]
locations = ["filesystem:sql/migrations"]
`);
    const diags = wfw114.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes when baselineOnMigrate is false", () => {
    const ctx = makeCtx(`
[flyway]
baselineOnMigrate = false
`);
    const diags = wfw114.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes when baselineOnMigrate is true and undoSqlMigrationPrefix is set", () => {
    const ctx = makeCtx(`
[flyway]
baselineOnMigrate = true
undoSqlMigrationPrefix = "U"
`);
    const diags = wfw114.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags when baselineOnMigrate is true in [flyway] without undo prefix", () => {
    const ctx = makeCtx(`
[flyway]
baselineOnMigrate = true
`);
    const diags = wfw114.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW114");
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("baselineOnMigrate");
    expect(diags[0].message).toContain("[flyway]");
    expect(diags[0].message).toContain("undoSqlMigrationPrefix");
  });

  test("flags when baselineOnMigrate is true in an environment without undo prefix", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
baselineOnMigrate = true
`);
    const diags = wfw114.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW114");
    expect(diags[0].message).toContain("[environments.dev]");
  });

  test("does not flag environment when global undoSqlMigrationPrefix is set", () => {
    const ctx = makeCtx(`
[flyway]
undoSqlMigrationPrefix = "U"

[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
baselineOnMigrate = true
`);
    const diags = wfw114.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags both [flyway] and environment when neither has undo prefix", () => {
    const ctx = makeCtx(`
[flyway]
baselineOnMigrate = true

[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
baselineOnMigrate = true
`);
    const diags = wfw114.check(ctx);
    expect(diags.length).toBe(2);
    const messages = diags.map((d) => d.message);
    expect(messages.some((m) => m.includes("[flyway]"))).toBe(true);
    expect(messages.some((m) => m.includes("[environments.dev]"))).toBe(true);
  });

  test("passes with no flyway section", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
`);
    const diags = wfw114.check(ctx);
    expect(diags.length).toBe(0);
  });
});
