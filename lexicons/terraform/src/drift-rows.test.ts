/**
 * Drift rows (#4580) over two hand-written plans: a stock root's
 * refresh-only plan with drift and a create row, and a full plan of a root
 * under live resource markers. The count and names are checked against a
 * copy of terragucci's own rules (packages/terragucci/src/report/drift.ts
 * at integration/ci-products), so a product that moves onto these rows
 * reports the same numbers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  terraformDriftPlan,
  terraformLivePlanDrift,
  terraformPlanDriftChanges,
  terraformPlanDriftCount,
  terraformPlanDriftNames,
  terraformPlanDriftRows,
} from "./drift-rows";

const FIX = join(import.meta.dirname, "__fixtures__", "drift-rows");
const read = (name: string): unknown => JSON.parse(readFileSync(join(FIX, name), "utf-8"));
const readAt = (...path: string[]): unknown => JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", ...path), "utf-8"));

// ── terragucci's rules, copied as they are, for the parity checks ─────────────

type Json = Record<string, unknown>;
const FLIP: Record<string, string> = { create: "delete", delete: "create" };

function driftPlan(plan: unknown): unknown {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return plan;
  const p = plan as Json;
  return { ...p, resource_changes: Array.isArray(p.resource_drift) ? p.resource_drift : [] };
}

function liveDrift(plan: unknown): unknown {
  if (plan === null || typeof plan !== "object" || Array.isArray(plan)) return plan;
  const p = plan as Json;
  const changes = Array.isArray(p.resource_changes) ? (p.resource_changes as Json[]) : [];
  const resource_drift = changes
    .filter((r) => r.mode !== "data")
    .flatMap((r) => {
      const ch = (r.change ?? {}) as Json;
      const actions = Array.isArray(ch.actions) ? (ch.actions as string[]) : [];
      if (actions.length === 0 || actions.every((a) => a === "no-op" || a === "read")) return [];
      const action = actions.length === 1 ? (FLIP[actions[0]!] ?? actions[0]!) : "update";
      const live = (ch.before ?? null) as Json | null;
      let code = (ch.after ?? null) as Json | null;
      const unknown = ch.after_unknown !== null && typeof ch.after_unknown === "object" ? (ch.after_unknown as Json) : {};
      if (code && live) code = { ...code, ...Object.fromEntries(Object.keys(unknown).filter((k) => unknown[k] === true && k in live).map((k) => [k, live[k]])) };
      return [{
        ...r,
        change: { actions: [action], before: code, after: live, before_sensitive: ch.after_sensitive ?? false, after_sensitive: ch.before_sensitive ?? false },
      }];
    });
  return { ...p, resource_drift };
}

function driftCount(plan: unknown): number {
  const list = plan !== null && typeof plan === "object" ? (plan as Json).resource_drift : undefined;
  return Array.isArray(list) ? list.length : 0;
}

function driftNames(plan: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const list = plan !== null && typeof plan === "object" ? (plan as Json).resource_drift : undefined;
  if (!Array.isArray(list)) return out;
  for (const r of list as Json[]) {
    const ch = (r.change ?? {}) as Json;
    const values = [ch.after, ch.before].filter((v): v is Json => v !== null && typeof v === "object");
    for (const key of ["name", "id", "bucket", "function_name", "arn"]) {
      const v = values.map((x) => x[key]).find((x) => typeof x === "string" && x !== "");
      if (typeof v === "string") {
        out.set(String(r.address), v);
        break;
      }
    }
  }
  return out;
}

// ── the rows ──────────────────────────────────────────────────────────────────

describe("a stock root's refresh-only plan", () => {
  const plan = read("refresh-plan.json");
  const rows = terraformPlanDriftRows(plan);

  test("every resource_drift entry is a row, creates and data blocks included", () => {
    expect(rows).toEqual([
      { address: "aws_s3_bucket.logs", action: "update", type: "aws_s3_bucket", name: "acme-logs" },
      { address: "aws_lambda_function.worker", action: "delete", type: "aws_lambda_function", name: "acme-worker" },
      { address: "aws_sqs_queue.jobs", action: "create", type: "aws_sqs_queue", name: "acme-jobs" },
      { address: "aws_iam_role.runner", action: "update", type: "aws_iam_role", name: "arn:aws:iam::000000000000:role/acme-runner" },
      { address: "data.aws_caller_identity.me", action: "update", type: "aws_caller_identity" },
    ]);
  });

  test("rows carry no attribute values", () => {
    for (const row of rows) expect(Object.keys(row).every((k) => ["address", "action", "type", "name"].includes(k))).toBe(true);
  });

  test("the count and names match terragucci's report", () => {
    expect(terraformPlanDriftCount(plan)).toBe(driftCount(plan));
    expect(terraformPlanDriftCount(plan)).toBe(5);
    expect(terraformPlanDriftNames(plan)).toEqual(driftNames(plan));
  });

  test("a delete-and-create pair is a replace", () => {
    const pair = { resource_drift: [{ address: "a.b", change: { actions: ["delete", "create"], before: { id: "x" }, after: { id: "y" } } }] };
    expect(terraformPlanDriftRows(pair)).toEqual([{ address: "a.b", action: "replace", name: "y" }]);
  });
});

describe("a live root's full plan", () => {
  const plan = read("live-root-plan.json");
  const rows = terraformPlanDriftRows(plan, { live: true });

  test("changes read as drift from the other side, data, no-op and resource_drift left out", () => {
    expect(rows).toEqual([
      { address: "aws_s3_bucket.assets", action: "delete", type: "aws_s3_bucket", name: "acme-assets" },
      { address: "aws_sqs_queue.stray", action: "create", type: "aws_sqs_queue", name: "acme-stray" },
      { address: "aws_lambda_function.api", action: "update", type: "aws_lambda_function", name: "acme-api" },
      { address: "aws_iam_role.deployer", action: "update", type: "aws_iam_role", name: "acme-deployer-old" },
      { address: "aws_security_group.edge", action: "update", type: "aws_security_group", name: "sg-0001" },
    ]);
  });

  test("the count and names match terragucci's report after liveDrift", () => {
    const drifted = liveDrift(plan);
    expect(terraformPlanDriftCount(plan, { live: true })).toBe(driftCount(drifted));
    expect(terraformPlanDriftCount(plan, { live: true })).toBe(5);
    expect(terraformPlanDriftNames(plan, { live: true })).toEqual(driftNames(drifted));
  });

  test("read as a stock plan, the same document counts only its resource_drift", () => {
    expect(terraformPlanDriftCount(plan)).toBe(1);
  });
});

describe("documents with nothing to read", () => {
  test("a missing or malformed plan has no rows", () => {
    for (const plan of [undefined, null, "plan", [], {}, { resource_drift: "x" }]) {
      expect(terraformPlanDriftRows(plan)).toEqual([]);
      expect(terraformPlanDriftRows(plan, { live: true })).toEqual([]);
      expect(terraformPlanDriftCount(plan)).toBe(driftCount(plan));
    }
  });
});

// ── the whole changes (#4812) ─────────────────────────────────────────────────

describe("whole changes", () => {
  const stock = ["refresh-plan.json", "refresh-plan-module.json"].map(read);
  const live = [read("live-root-plan.json"), readAt("live-plan-depth", "show-plan.json"), readAt("live-plan-depth", "show-plan-sensitive.json")];

  test("a refresh-only plan's drift report plan is byte-identical to terragucci's driftPlan", () => {
    for (const plan of stock) expect(JSON.stringify(terraformDriftPlan(plan))).toBe(JSON.stringify(driftPlan(plan)));
  });

  test("a live root's full plan read as drift is byte-identical to terragucci's liveDrift", () => {
    for (const plan of live) expect(JSON.stringify(terraformLivePlanDrift(plan))).toBe(JSON.stringify(liveDrift(plan)));
    // And then as a drift report's plan, as terragucci's stage reads a live root.
    for (const plan of live) expect(JSON.stringify(terraformDriftPlan(terraformLivePlanDrift(plan)))).toBe(JSON.stringify(driftPlan(liveDrift(plan))));
  });

  test("a stock change keeps module, index, deposed, the provider and the masks as the plan has them", () => {
    const plan = read("refresh-plan-module.json") as { resource_drift: unknown[] };
    const changes = terraformPlanDriftChanges(plan);
    expect(changes).toEqual(plan.resource_drift);
    expect(changes[0]).toMatchObject({ module_address: "module.service", index: "orders", provider_name: "registry.terraform.io/hashicorp/aws" });
    expect(changes[0]!.change).toMatchObject({ before_sensitive: { kms_data_key: true }, after_sensitive: { kms_data_key: true }, after_unknown: {} });
    expect(changes[1]).toMatchObject({ address: "aws_instance.web", deposed: "00000001", change: { actions: ["delete"], after: null } });
    // Code waiting on main is not drift.
    expect((terraformDriftPlan(plan) as { resource_changes: { address: string }[] }).resource_changes.map((c) => c.address)).toEqual([
      'module.service.aws_sqs_queue.jobs["orders"]',
      "aws_instance.web",
    ]);
  });

  test("a live change is seen from the other side: code before, live after, masks swapped, an unknown taking the live value", () => {
    const changes = terraformPlanDriftChanges(read("live-root-plan.json"), { live: true });
    expect(changes.map((c) => [c.address, (c.change as { actions: string[] }).actions])).toEqual([
      ["aws_s3_bucket.assets", ["delete"]],
      ["aws_sqs_queue.stray", ["create"]],
      ["aws_lambda_function.api", ["update"]],
      ["aws_iam_role.deployer", ["update"]],
      ["aws_security_group.edge", ["update"]],
    ]);
    expect(changes[2]!.change).toEqual({
      actions: ["update"],
      before: { function_name: "acme-api", memory_size: 512, version: "7" },
      after: { function_name: "acme-api", memory_size: 256, version: "7" },
      before_sensitive: false,
      after_sensitive: false,
    });
    const sensitive = terraformPlanDriftChanges(readAt("live-plan-depth", "show-plan-sensitive.json"), { live: true });
    const vpc = sensitive.find((c) => c.address === "aws_vpc.main")!.change as Json;
    const source = (readAt("live-plan-depth", "show-plan-sensitive.json") as { resource_changes: { address: string; change: Json }[] }).resource_changes.find((c) => c.address === "aws_vpc.main")!.change;
    expect(vpc.before_sensitive).toEqual(source.after_sensitive);
    expect(vpc.after_sensitive).toEqual(source.before_sensitive);
  });

  test("one row per whole change, the same count either way", () => {
    for (const plan of stock) expect(terraformPlanDriftRows(plan).map((r) => r.address)).toEqual(terraformPlanDriftChanges(plan).map((c) => c.address));
    for (const plan of live) {
      expect(terraformPlanDriftRows(plan, { live: true }).map((r) => r.address)).toEqual(terraformPlanDriftChanges(plan, { live: true }).map((c) => c.address));
      expect(terraformPlanDriftCount(terraformLivePlanDrift(plan))).toBe(terraformPlanDriftCount(plan, { live: true }));
      expect(terraformPlanDriftNames(terraformLivePlanDrift(plan))).toEqual(terraformPlanDriftNames(plan, { live: true }));
    }
  });

  test("a missing or malformed plan is returned as it is, with no changes", () => {
    for (const plan of [undefined, null, "plan", []]) {
      expect(terraformDriftPlan(plan)).toBe(plan);
      expect(terraformLivePlanDrift(plan)).toBe(plan);
      expect(terraformPlanDriftChanges(plan)).toEqual([]);
    }
    for (const plan of [{}, { resource_drift: "x" }]) {
      expect(terraformDriftPlan(plan)).toEqual(driftPlan(plan));
      expect(terraformLivePlanDrift(plan)).toEqual(liveDrift(plan));
    }
  });
});
