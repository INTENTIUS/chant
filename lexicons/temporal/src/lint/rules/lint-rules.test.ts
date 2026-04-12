/**
 * Lint rule tests — TMP001, TMP002.
 */

import { describe, test, expect } from "vitest";
import type { LintContext } from "@intentius/chant/lint/rule";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { tmp001 } from "./tmp001";
import { tmp002 } from "./tmp002";

// ── Helpers ─────────────────────────────────────────────────────────

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

function makeCtx(entities: Map<string, unknown>): LintContext {
  return {
    entities: entities as Map<string, never>,
    project: { name: "test" } as never,
  };
}

// ── TMP001: retention-too-short ──────────────────────────────────────

describe("TMP001: retention-too-short", () => {
  test("flags namespace with 1d retention", () => {
    const ctx = makeCtx(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "1d" })],
    ]));
    const diags = tmp001.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("TMP001");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain("1d");
  });

  test("flags namespace with 48h retention", () => {
    const ctx = makeCtx(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "48h" })],
    ]));
    const diags = tmp001.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("TMP001");
  });

  test("passes with 3d retention (exactly at threshold)", () => {
    const ctx = makeCtx(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "3d" })],
    ]));
    expect(tmp001.check(ctx)).toHaveLength(0);
  });

  test("passes with 7d retention", () => {
    const ctx = makeCtx(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "7d" })],
    ]));
    expect(tmp001.check(ctx)).toHaveLength(0);
  });

  test("passes when retention is unset (defaults to 7d)", () => {
    const ctx = makeCtx(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default" })],
    ]));
    expect(tmp001.check(ctx)).toHaveLength(0);
  });

  test("skips non-namespace entities", () => {
    const ctx = makeCtx(new Map([
      ["s", makeEntity("Temporal::Server", { mode: "dev" })],
    ]));
    expect(tmp001.check(ctx)).toHaveLength(0);
  });

  test("skips unrecognised retention format", () => {
    const ctx = makeCtx(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default", retention: "1week" })],
    ]));
    expect(tmp001.check(ctx)).toHaveLength(0);
  });
});

// ── TMP002: allowall-without-note ────────────────────────────────────

describe("TMP002: allowall-without-note", () => {
  test("warns for AllowAll overlap without state.note", () => {
    const ctx = makeCtx(new Map([
      ["sched", makeEntity("Temporal::Schedule", {
        scheduleId: "heavy-job",
        spec: { cronExpressions: ["0 * * * *"] },
        action: { workflowType: "heavyWorkflow", taskQueue: "heavy" },
        policies: { overlap: "AllowAll" },
      })],
    ]));
    const diags = tmp002.check(ctx);
    expect(diags).toHaveLength(1);
    expect(diags[0].ruleId).toBe("TMP002");
    expect(diags[0].severity).toBe("warning");
  });

  test("passes when AllowAll has a note", () => {
    const ctx = makeCtx(new Map([
      ["sched", makeEntity("Temporal::Schedule", {
        scheduleId: "heavy-job",
        spec: { cronExpressions: ["0 * * * *"] },
        action: { workflowType: "heavyWorkflow", taskQueue: "heavy" },
        policies: { overlap: "AllowAll" },
        state: { note: "Workflow is idempotent — concurrent runs are safe" },
      })],
    ]));
    expect(tmp002.check(ctx)).toHaveLength(0);
  });

  test("passes for Skip overlap (no note needed)", () => {
    const ctx = makeCtx(new Map([
      ["sched", makeEntity("Temporal::Schedule", {
        scheduleId: "daily",
        spec: { cronExpressions: ["0 3 * * *"] },
        action: { workflowType: "dailyWorkflow", taskQueue: "daily" },
        policies: { overlap: "Skip" },
      })],
    ]));
    expect(tmp002.check(ctx)).toHaveLength(0);
  });

  test("passes when no policies set", () => {
    const ctx = makeCtx(new Map([
      ["sched", makeEntity("Temporal::Schedule", {
        scheduleId: "daily",
        spec: { cronExpressions: ["0 3 * * *"] },
        action: { workflowType: "dailyWorkflow", taskQueue: "daily" },
      })],
    ]));
    expect(tmp002.check(ctx)).toHaveLength(0);
  });

  test("skips non-schedule entities", () => {
    const ctx = makeCtx(new Map([
      ["ns", makeEntity("Temporal::Namespace", { name: "default" })],
    ]));
    expect(tmp002.check(ctx)).toHaveLength(0);
  });
});
