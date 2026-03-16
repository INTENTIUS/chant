import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw113 } from "./wfw113";

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

describe("WFW113: Conflicting schemas across environments", () => {
  test("passes when environments have different URLs", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
schemas = ["public"]

[environments.staging]
url = "jdbc:postgresql://localhost:5432/staging"
schemas = ["app"]
`);
    const diags = wfw113.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes when environments share URL and same schemas", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/mydb"
schemas = ["public", "app"]

[environments.test]
url = "jdbc:postgresql://localhost:5432/mydb"
schemas = ["app", "public"]
`);
    const diags = wfw113.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags when environments share URL but have different schemas", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/mydb"
schemas = ["public"]

[environments.test]
url = "jdbc:postgresql://localhost:5432/mydb"
schemas = ["app"]
`);
    const diags = wfw113.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW113");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("dev");
    expect(diags[0].message).toContain("test");
    expect(diags[0].message).toContain("different schemas");
  });

  test("passes when no environments are defined", () => {
    const ctx = makeCtx(`
[flyway]
locations = ["filesystem:sql/migrations"]
`);
    const diags = wfw113.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes when environments have no schemas key", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/mydb"

[environments.test]
url = "jdbc:postgresql://localhost:5432/mydb"
`);
    const diags = wfw113.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags when one environment has schemas and another does not for same URL", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/mydb"
schemas = ["public"]

[environments.test]
url = "jdbc:postgresql://localhost:5432/mydb"
`);
    const diags = wfw113.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW113");
  });

  test("handles three environments with same URL and mixed schemas", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/mydb"
schemas = ["public"]

[environments.staging]
url = "jdbc:postgresql://localhost:5432/mydb"
schemas = ["public"]

[environments.test]
url = "jdbc:postgresql://localhost:5432/mydb"
schemas = ["app"]
`);
    const diags = wfw113.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("different schemas");
  });
});
