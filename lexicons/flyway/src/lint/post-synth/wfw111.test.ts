import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { wfw111 } from "./wfw111";

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

describe("WFW111: Unknown key detection", () => {
  test("passes for valid keys in all sections", () => {
    const ctx = makeCtx(`
id = "my-project"
name = "my-project"

[flyway]
locations = ["filesystem:sql/migrations"]
defaultSchema = "public"
cleanDisabled = true

[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
user = "dev_user"
schemas = ["public"]

[flywayDesktop]
developmentEnvironment = "dev"
shadowEnvironment = "shadow"

[redgateCompare]
filterFile = "filter.rgf"
`);
    const diags = wfw111.check(ctx);
    expect(diags.length).toBe(0);
  });

  test("flags unknown key in [flyway] section", () => {
    const ctx = makeCtx(`
[flyway]
locations = ["filesystem:sql/migrations"]
bogusKey = "value"
`);
    const diags = wfw111.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].checkId).toBe("WFW111");
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toContain("bogusKey");
    expect(diags[0].message).toContain("[flyway]");
  });

  test("flags unknown key at root level", () => {
    const ctx = makeCtx(`
id = "my-project"
unknownRoot = "value"

[flyway]
locations = ["filesystem:sql/migrations"]
`);
    const diags = wfw111.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("unknownRoot");
    expect(diags[0].message).toContain("[root]");
  });

  test("flags unknown key in environment section", () => {
    const ctx = makeCtx(`
[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
madeUpOption = true
`);
    const diags = wfw111.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("madeUpOption");
    expect(diags[0].message).toContain("[environments.dev]");
  });

  test("flags unknown key in [flywayDesktop] section", () => {
    const ctx = makeCtx(`
[flywayDesktop]
developmentEnvironment = "dev"
notARealKey = "value"
`);
    const diags = wfw111.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("notARealKey");
    expect(diags[0].message).toContain("[flywayDesktop]");
  });

  test("flags unknown key in [redgateCompare] section", () => {
    const ctx = makeCtx(`
[redgateCompare]
filterFile = "filter.rgf"
badKey = "value"
`);
    const diags = wfw111.check(ctx);
    expect(diags.length).toBe(1);
    expect(diags[0].message).toContain("badKey");
    expect(diags[0].message).toContain("[redgateCompare]");
  });

  test("flags multiple unknown keys across sections", () => {
    const ctx = makeCtx(`
weirdRoot = true

[flyway]
locations = ["filesystem:sql/migrations"]
fakeOption = "x"

[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"
inventedKey = 42
`);
    const diags = wfw111.check(ctx);
    expect(diags.length).toBe(3);
    const messages = diags.map((d) => d.message);
    expect(messages.some((m) => m.includes("weirdRoot"))).toBe(true);
    expect(messages.some((m) => m.includes("fakeOption"))).toBe(true);
    expect(messages.some((m) => m.includes("inventedKey"))).toBe(true);
  });

  test("does not flag known sections as unknown root keys", () => {
    const ctx = makeCtx(`
[flyway]
locations = ["filesystem:sql/migrations"]

[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"

[flywayDesktop]
developmentEnvironment = "dev"

[redgateCompare]
filterFile = "filter.rgf"
`);
    const diags = wfw111.check(ctx);
    expect(diags.length).toBe(0);
  });
});
