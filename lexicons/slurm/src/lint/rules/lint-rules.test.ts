/**
 * Lint rule tests — SLRC001, SLRS001, SLRC002, SLRC003.
 */

import { describe, test, expect } from "vitest";
import type { LintContext } from "@intentius/chant/lint/rule";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { partitionNodesDefined } from "./partition-nodes-defined";
import { maxTimeFormat } from "./max-time-format";
import { selectTypeDeprecated } from "./select-type-deprecated";
import { defMemConflict } from "./def-mem-conflict";

// ── Helpers ─────────────────────────────────────────────────────────

function makeEntity(entityType: string, props: Record<string, unknown>) {
  return {
    [DECLARABLE_MARKER]: true,
    entityType,
    lexicon: "slurm",
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

// ── SLRC001: partition-nodes-defined ─────────────────────────────

describe("SLRC001: partition-nodes-defined", () => {
  test("flags partition with undefined node", () => {
    const ctx = makeCtx(new Map([
      ["p", makeEntity("Slurm::Conf::Partition", { PartitionName: "gpu", Nodes: "gpu[001-004]" })],
      ["n", makeEntity("Slurm::Conf::Node", { NodeName: "cpu[001-016]" })],
    ]));
    const diags = partitionNodesDefined.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].ruleId).toBe("SLRC001");
    expect(diags[0].severity).toBe("error");
  });

  test("passes when partition node is defined", () => {
    const ctx = makeCtx(new Map([
      ["p", makeEntity("Slurm::Conf::Partition", { PartitionName: "cpu", Nodes: "cpu[001-016]" })],
      ["n", makeEntity("Slurm::Conf::Node", { NodeName: "cpu[001-016]" })],
    ]));
    const diags = partitionNodesDefined.check(ctx);
    expect(diags).toHaveLength(0);
  });

  test("passes when partition has no Nodes specified", () => {
    const ctx = makeCtx(new Map([
      ["p", makeEntity("Slurm::Conf::Partition", { PartitionName: "cpu" })],
    ]));
    const diags = partitionNodesDefined.check(ctx);
    expect(diags).toHaveLength(0);
  });
});

// ── SLRS001: max-time-format ─────────────────────────────────────

describe("SLRS001: max-time-format", () => {
  test("warns for invalid format like '48h'", () => {
    const ctx = makeCtx(new Map([
      ["p", makeEntity("Slurm::Conf::Partition", { PartitionName: "sim", MaxTime: "48h" })],
    ]));
    const diags = maxTimeFormat.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].ruleId).toBe("SLRS001");
  });

  test("passes for UNLIMITED", () => {
    const ctx = makeCtx(new Map([
      ["p", makeEntity("Slurm::Conf::Partition", { PartitionName: "sim", MaxTime: "UNLIMITED" })],
    ]));
    expect(maxTimeFormat.check(ctx)).toHaveLength(0);
  });

  test("passes for D-HH:MM:SS format", () => {
    const ctx = makeCtx(new Map([
      ["p", makeEntity("Slurm::Conf::Partition", { PartitionName: "sim", MaxTime: "7-00:00:00" })],
    ]));
    expect(maxTimeFormat.check(ctx)).toHaveLength(0);
  });

  test("passes for minute-only format", () => {
    const ctx = makeCtx(new Map([
      ["p", makeEntity("Slurm::Conf::Partition", { PartitionName: "sim", MaxTime: "1440" })],
    ]));
    expect(maxTimeFormat.check(ctx)).toHaveLength(0);
  });
});

// ── SLRC002: select-type-deprecated ──────────────────────────────

describe("SLRC002: select-type-deprecated", () => {
  test("warns for select/cons_res", () => {
    const ctx = makeCtx(new Map([
      ["c", makeEntity("Slurm::Conf::Cluster", { ClusterName: "hpc", ControlMachine: "head01", SelectType: "select/cons_res" })],
    ]));
    const diags = selectTypeDeprecated.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].ruleId).toBe("SLRC002");
    expect(diags[0].severity).toBe("warning");
  });

  test("passes for select/cons_tres", () => {
    const ctx = makeCtx(new Map([
      ["c", makeEntity("Slurm::Conf::Cluster", { ClusterName: "hpc", SelectType: "select/cons_tres" })],
    ]));
    expect(selectTypeDeprecated.check(ctx)).toHaveLength(0);
  });
});

// ── SLRC003: def-mem-conflict ─────────────────────────────────────

describe("SLRC003: def-mem-conflict", () => {
  test("flags partition with both DefMemPerCPU and DefMemPerNode", () => {
    const ctx = makeCtx(new Map([
      ["p", makeEntity("Slurm::Conf::Partition", {
        PartitionName: "sim",
        DefMemPerCPU: 2048,
        DefMemPerNode: 65536,
      })],
    ]));
    const diags = defMemConflict.check(ctx);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0].ruleId).toBe("SLRC003");
    expect(diags[0].severity).toBe("error");
  });

  test("passes with only DefMemPerCPU", () => {
    const ctx = makeCtx(new Map([
      ["p", makeEntity("Slurm::Conf::Partition", { PartitionName: "cpu", DefMemPerCPU: 2048 })],
    ]));
    expect(defMemConflict.check(ctx)).toHaveLength(0);
  });

  test("passes with only DefMemPerNode", () => {
    const ctx = makeCtx(new Map([
      ["p", makeEntity("Slurm::Conf::Partition", { PartitionName: "gpu", DefMemPerNode: 1048576 })],
    ]));
    expect(defMemConflict.check(ctx)).toHaveLength(0);
  });
});
