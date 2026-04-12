import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw112 } from "./wfw112";

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

describe("WFW112: Mixed versioned and repeatable migrations", () => {
  test("passes when only locations are set without repeatableSqlMigrationPrefix", () => {
    const ctx = makeCtx(`
[flyway]
locations = ["filesystem:sql/migrations"]
`);
    const diags = wfw112.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes when repeatableSqlMigrationPrefix is set without locations", () => {
    const ctx = makeCtx(`
[flyway]
repeatableSqlMigrationPrefix = "R"
`);
    const diags = wfw112.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes when no [flyway] section exists", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
`);
    const diags = wfw112.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags when both locations and repeatableSqlMigrationPrefix are set", () => {
    const ctx = makeCtx(`
[flyway]
locations = ["filesystem:sql/migrations"]
repeatableSqlMigrationPrefix = "R"
`);
    const diags = wfw112.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW112");
    expect(diags[0].severity).toBe("info");
    expect(diags[0].message).toContain("repeatable");
    expect(diags[0].message).toContain("locations");
  });

  test("flags with multiple locations and custom repeatable prefix", () => {
    const ctx = makeCtx(`
[flyway]
locations = ["filesystem:sql/versioned", "filesystem:sql/repeatable"]
repeatableSqlMigrationPrefix = "REP"
`);
    const diags = wfw112.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW112");
  });

  test("does not flag when locations is empty array", () => {
    const ctx = makeCtx(`
[flyway]
locations = []
repeatableSqlMigrationPrefix = "R"
`);
    const diags = wfw112.check(ctx);
    expect(diags.length).toBe(0);
  });
});
