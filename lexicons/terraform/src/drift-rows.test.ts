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
import { terraformPlanDriftCount, terraformPlanDriftNames, terraformPlanDriftRows } from "./drift-rows";

const FIX = join(import.meta.dirname, "__fixtures__", "drift-rows");
const read = (name: string): unknown => JSON.parse(readFileSync(join(FIX, name), "utf-8"));

// ── terragucci's rules, copied as they are, for the parity checks ─────────────

type Json = Record<string, unknown>;
const FLIP: Record<string, string> = { create: "delete", delete: "create" };

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
