import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw115 } from "./wfw115";

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

describe("WFW115: Provisioner without matching environment", () => {
  test("passes when no provisioner is set", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"

[environments.staging]
url = "jdbc:postgresql://localhost:5432/staging"
`);
    const diags = wfw115.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("passes when provisioner matches a defined environment", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
provisioner = "shadow"

[environments.shadow]
url = "jdbc:postgresql://localhost:5432/shadow"
`);
    const diags = wfw115.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags when provisioner does not match any environment", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
provisioner = "nonexistent"
`);
    const diags = wfw115.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW115");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("dev");
    expect(diags[0].message).toContain("nonexistent");
    expect(diags[0].message).toContain("not a defined environment");
  });

  test("flags multiple environments with invalid provisioners", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
provisioner = "missing1"

[environments.staging]
url = "jdbc:postgresql://localhost:5432/staging"
provisioner = "missing2"
`);
    const diags = wfw115.check(ctx);
    expect(diags.length).toBe(2);
    const messages = diags.map((d) => d.message);
    expect(messages.some((m) => m.includes("missing1"))).toBe(true);
    expect(messages.some((m) => m.includes("missing2"))).toBe(true);
  });

  test("passes with no environments defined", () => {
    const ctx = makeCtx(`
[flyway]
locations = ["filesystem:sql/migrations"]
`);
    const diags = wfw115.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("does not flag when provisioner is not a string", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
provisioner = 42
`);
    const diags = wfw115.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("handles self-referencing provisioner correctly", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
provisioner = "dev"
`);
    const diags = wfw115.check(ctx);
    expect(diags.length).toBe(0);
  });
});
