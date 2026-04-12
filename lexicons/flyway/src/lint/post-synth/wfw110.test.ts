import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw110 } from "./wfw110";

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

describe("WFW110: Schema mismatch", () => {
  test("flags child environment with different schemas than parent", () => {
    const ctx = makeCtx(`
[environments.base]
url = "jdbc:postgresql://localhost:5432/db"
schemas = ["public"]

[environments.staging]
url = "jdbc:postgresql://staging:5432/db"
extends = "base"
schemas = ["staging_schema"]
`);
    const diags = wfw110.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW110");
    expect(diags[0].message).toContain("staging");
    expect(diags[0].message).toContain("base");
  });

  test("passes when child environment has same schemas as parent", () => {
    const ctx = makeCtx(`
[environments.base]
url = "jdbc:postgresql://localhost:5432/db"
schemas = ["public"]

[environments.staging]
url = "jdbc:postgresql://staging:5432/db"
extends = "base"
schemas = ["public"]
`);
    const diags = wfw110.check(ctx);
    expect(diags.length).toBe(0);
  });
});
