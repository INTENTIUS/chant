/**
 * Post-synth check tests — TMP010, TMP011.
 */

import { describe, test, expect } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { tmp010 } from "./tmp010-cron-syntax";
import { tmp011 } from "./tmp011-namespace-reference";

// ── Helpers ─────────────────────────────────────────────────────────

function makeCtxFromOutput(output: string | { primary: string; files: Record<string, string> }): PostSynthContext {
  return {
    outputs: new Map([["temporal", output]]),
    entities: new Map(),
    buildResult: {
      outputs: new Map([["temporal", output]]),
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

function makeEntity(entityType: string, props: Record<string, unknown>) {
  return {
    [DECLARABLE_MARKER]: true,
    entityType,
    lexicon: "temporal",
    kind: "resource",
    props,
    attributes: {},
  };
}

function makeCtxFromEntities(entities: Map<string, unknown>): PostSynthContext {
  return {
    outputs: new Map([["temporal", ""]]),
    entities: entities as Map<string, never>,
    buildResult: {
      outputs: new Map([["temporal", ""]]),
      entities: entities as Map<string, never>,
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

// ── TMP010: cron-syntax ──────────────────────────────────────────────

describe("TMP010: cron-syntax", () => {
  test("warns for invalid cron with only 4 fields", () => {
    const content = `cronExpressions: ["0 3 * *"]`;
    const ctx = makeCtxFromOutput({
      primary: "# docker-compose",
      files: { "schedules/daily.ts": content },
    });
    const diags = tmp010.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].checkId).toBe("TMP010");
    expect(diags[0].severity).toBe("warning");
  });

  test("passes for valid 5-field cron", () => {
    const content = `cronExpressions: ["0 3 * * *"]`;
    const ctx = makeCtxFromOutput({
      primary: "# docker-compose",
      files: { "schedules/daily.ts": content },
    });
    expect(tmp010.check(ctx)).toHaveLength(0);
  });

  test("passes for valid 6-field cron (with seconds)", () => {
    const content = `cronExpressions: ["0 0 3 * * *"]`;
    const ctx = makeCtxFromOutput({
      primary: "# docker-compose",
      files: { "schedules/daily.ts": content },
    });
    expect(tmp010.check(ctx)).toHaveLength(0);
  });

  test("skips non-temporal lexicons", () => {
    const ctx: PostSynthContext = {
      outputs: new Map([["aws", `cronExpressions: ["invalid"]`]]),
      entities: new Map(),
      buildResult: {
        outputs: new Map([["aws", ""]]),
        entities: new Map(),
        warnings: [],
        errors: [],
        sourceFileCount: 1,
      },
    };
    expect(tmp010.check(ctx)).toHaveLength(0);
  });

  test("skips non-schedule files", () => {
    const content = `cronExpressions: ["bad"]`;
    const ctx = makeCtxFromOutput({
      primary: content,
      files: { "temporal-setup.sh": content },
    });
    expect(tmp010.check(ctx)).toHaveLength(0);
  });

  test("passes when output is plain string (no schedule files)", () => {
    const ctx = makeCtxFromOutput("# docker-compose.yml\nservices:\n  temporal:\n");
    expect(tmp010.check(ctx)).toHaveLength(0);
  });
});

// ── TMP011: namespace-reference ──────────────────────────────────────

describe("TMP011: namespace-reference", () => {
  test("errors when SearchAttribute references undeclared namespace", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["attr", makeEntity("Temporal::SearchAttribute", { name: "Project", type: "Keyword", namespace: "prod" })],
    ]));
    const diags = tmp011.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("TMP011");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("prod");
  });

  test("passes when SearchAttribute namespace is declared", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "prod", retention: "30d" })],
      ["attr", makeEntity("Temporal::SearchAttribute", { name: "Project", type: "Keyword", namespace: "prod" })],
    ]));
    expect(tmp011.check(ctx)).toHaveLength(0);
  });

  test("passes when SearchAttribute has no namespace (global)", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["attr", makeEntity("Temporal::SearchAttribute", { name: "Project", type: "Keyword" })],
    ]));
    expect(tmp011.check(ctx)).toHaveLength(0);
  });

  test("flags each attribute with a missing namespace independently", () => {
    const ctx = makeCtxFromEntities(new Map([
      ["attr1", makeEntity("Temporal::SearchAttribute", { name: "A", type: "Keyword", namespace: "missing1" })],
      ["attr2", makeEntity("Temporal::SearchAttribute", { name: "B", type: "Keyword", namespace: "missing2" })],
    ]));
    const diags = tmp011.check(ctx);
    expect(diags).toHaveLength(2);
  });
});
