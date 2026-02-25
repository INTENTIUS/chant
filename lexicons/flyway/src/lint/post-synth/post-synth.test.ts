/**
 * Integration test: runs all WFW post-synth checks against a realistic
 * multi-environment Flyway config to verify they work together.
 */

import { describe, test, expect } from "bun:test";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";

import { wfw101 } from "./wfw101";
import { wfw102 } from "./wfw102";
import { wfw103 } from "./wfw103";
import { wfw104 } from "./wfw104";
import { wfw105 } from "./wfw105";
import { wfw106 } from "./wfw106";
import { wfw107 } from "./wfw107";
import { wfw108 } from "./wfw108";
import { wfw109 } from "./wfw109";
import { wfw110 } from "./wfw110";

const allChecks = [wfw101, wfw102, wfw103, wfw104, wfw105, wfw106, wfw107, wfw108, wfw109, wfw110];

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

describe("Post-synth integration", () => {
  test("all checks have unique ids", () => {
    const ids = allChecks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("clean config produces no diagnostics", () => {
    const ctx = makeCtx(`
[flyway]
locations = ["filesystem:sql/migrations"]

[flyway.callbacks]
beforeMigrate = "SELECT 1"

[environments.dev]
url = "jdbc:postgresql://localhost:5432/dev"

[environments.prod]
url = "jdbc:postgresql://prod:5432/db"
cleanDisabled = true
validateOnMigrate = true
schemas = ["public"]
`);
    for (const check of allChecks) {
      const diags = check.check(ctx);
      expect(diags.length).toBe(0);
    }
  });

  test("insecure prod config triggers multiple checks", () => {
    const ctx = makeCtx(`
[environments.prod]
url = "jdbc:postgresql://prod:5432/db"
baselineOnMigrate = true
`);
    const allDiags = allChecks.flatMap((c) => c.check(ctx));
    const checkIds = new Set(allDiags.map((d) => d.checkId));
    // Should trigger at least WFW101, WFW102, WFW103, WFW105
    expect(checkIds.has("WFW101")).toBe(true);
    expect(checkIds.has("WFW102")).toBe(true);
    expect(checkIds.has("WFW103")).toBe(true);
    expect(checkIds.has("WFW105")).toBe(true);
  });
});
