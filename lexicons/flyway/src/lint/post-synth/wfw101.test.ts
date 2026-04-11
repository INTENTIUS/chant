import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw101 } from "./wfw101";

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

describe("WFW101: Production clean enabled", () => {
  test("flags prod environment without cleanDisabled=true", () => {
    const ctx = makeCtx(`
[environments.prod]
url = "jdbc:postgresql://prod:5432/db"
`);
    const diags = wfw101.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW101");
    expect(diags[0].message).toContain("prod");
  });

  test("passes when prod has cleanDisabled=true", () => {
    const ctx = makeCtx(`
[environments.prod]
url = "jdbc:postgresql://prod:5432/db"
cleanDisabled = true
`);
    const diags = wfw101.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes when prod has cleanDisabled=true in nested flyway section", () => {
    const ctx = makeCtx(`
[environments.prod]
url = "jdbc:postgresql://prod:5432/db"

[environments.prod.flyway]
cleanDisabled = true
`);
    const diags = wfw101.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags prod with cleanDisabled=false in nested flyway section", () => {
    const ctx = makeCtx(`
[environments.prod]
url = "jdbc:postgresql://prod:5432/db"

[environments.prod.flyway]
cleanDisabled = false
`);
    const diags = wfw101.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW101");
  });
});
