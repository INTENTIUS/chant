import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw109 } from "./wfw109";

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

describe("WFW109: Provisioner config mismatch", () => {
  test("flags backup provisioner without filePath", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/db"

[environments.dev.provisioner]
type = "backup"
`);
    const diags = wfw109.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW109");
    expect(diags[0].message).toContain("backup");
  });

  test("passes when backup provisioner has filePath", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/db"

[environments.dev.provisioner]
type = "backup"
filePath = "/backups/dev.sql"
`);
    const diags = wfw109.check(ctx);
    expect(diags.length).toBe(0);
  });
});
