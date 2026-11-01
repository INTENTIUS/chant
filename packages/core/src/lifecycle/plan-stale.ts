/**
 * `chant plan stale <digest> --json` (#4648): whether anything applied to a
 * plan's targets after the plan was recorded, so a platform can ask before it
 * puts the plan in front of a person to approve. chant checks the digest
 * again when the approved run applies; this read answers the same question
 * earlier, and names the applies.
 *
 * The plan is the pending gate facts that record `digest` (`_gates/<op>.jsonl`).
 * It was recorded at the earliest of them. Its targets are each fact's
 * member, op and environment: the fact's own `environment` (a component
 * gate's), else the `env` of the run that reached the gate.
 *
 * An apply touches a target when it was recorded after the plan and:
 *
 * - it is an apply under an approval (`_gates/<op>/applied.jsonl`, the
 *   `applies` table) of the same member and op, for another plan; or
 * - it is a deploy record (`<env>/releases.jsonl`, the `deploys` table) of
 *   the same member and environment, of any component.
 *
 * An apply of this same plan doesn't make it stale. Neither does anything in
 * another member or environment.
 *
 * Pure over the rows `chant query` loads (`./query.ts` {@link loadQueryData}):
 * the caller reads the ledgers, and this reads no git and writes nothing.
 */
import { samePlanDigest } from "./plan-digest";
import type { QueryData, QueryRow } from "./query";

/** The version of the `plan-stale` document this chant writes. */
export const PLAN_STALE_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for `chant plan stale --json`. */
export const PLAN_STALE_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/plan-stale/v1/plan-stale.schema.json";

/** The first chant that answers `chant plan stale` (#4648). */
export const PLAN_STALE_FLOOR = "0.124.63";

/** Why the read stopped. Closed; each code is in `../workspace/reason-codes.ts`. */
export const PLAN_STALE_ERROR_CODES = ["not-a-git-repository", "ledger-unreadable"] as const;

/** One gate the plan waits at, and what it covers. */
export interface PlanStaleTarget {
  member: string | null;
  op: string;
  gate: string;
  /** The environment the plan is for, or null when neither the fact nor its run names one. */
  environment: string | null;
}

/** One apply that touched a target after the plan was recorded. */
export interface PlanStaleApply {
  /** Where it was read: `applies` for an apply under an approval, `deploys` for a deploy record. */
  source: "applies" | "deploys";
  member: string | null;
  /** The op it applied under; null for a deploy record. */
  op: string | null;
  gate: string | null;
  /** The environment; null for an apply under an approval, whose line names none. */
  environment: string | null;
  /** The component a deploy record deployed; null for an apply under an approval. */
  component: string | null;
  /** The plan it applied; null for a deploy record. */
  planDigest: string | null;
  /** When it was recorded. */
  at: string;
  /** Who ran it: a deploy record's `actor`; null for an apply under an approval, which names only its approver. */
  actor: string | null;
  approvedBy: string | null;
  runId: string | null;
  runUrl: string | null;
  gitSha: string | null;
  /** How an apply under an approval ended: `applied`, `failed`, or null while it has no finished line. Null for a deploy record. */
  result: string | null;
}

export type PlanStaleDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      digest: string;
      /** The plan, or null when no pending gate fact records the digest. */
      plan: { recordedAt: string; runId: string | null; gitSha: string | null; targets: PlanStaleTarget[] } | null;
      /** Whether any apply touched a target after the plan was recorded; null when there is no plan. */
      stale: boolean | null;
      /** Those applies, oldest first. */
      applies: PlanStaleApply[];
    }
  | { $schema: string; contract: number; chant: string; error: { code: (typeof PLAN_STALE_ERROR_CODES)[number]; message: string } };

const text = (v: QueryRow[string] | undefined): string | null => (typeof v === "string" ? v : null);
const time = (iso: string): number => new Date(iso).getTime();

/** The document's head: `$schema`, `contract` and `chant`. */
export function planStaleHead(chant: string): { $schema: string; contract: number; chant: string } {
  return { $schema: PLAN_STALE_SCHEMA_ID, contract: PLAN_STALE_CONTRACT_VERSION, chant };
}

/** Whether `digest`'s plan is stale, read from the rows of the `gates`, `runs`, `applies` and `deploys` tables. */
export function planStaleness(data: Pick<QueryData, "gates" | "runs" | "applies" | "deploys">, digest: string, chant: string): PlanStaleDocument {
  const head = planStaleHead(chant);
  const facts = data.gates.filter((g) => g.kind === "pending" && samePlanDigest(text(g.plan_digest) ?? undefined, digest) && typeof g.timestamp === "string");
  if (facts.length === 0) return { ...head, digest, plan: null, stale: null, applies: [] };

  const first = facts.reduce((a, b) => (time(String(b.timestamp)) < time(String(a.timestamp)) ? b : a));
  const recordedAt = String(first.timestamp);
  const since = time(recordedAt);
  const runEnv = (member: string | null, runId: string | null): string | null => {
    if (runId === null) return null;
    const run = data.runs.find((r) => r.member === member && r.id === runId);
    return run ? text(run.env) : null;
  };
  const targets: PlanStaleTarget[] = [];
  for (const f of facts) {
    const member = text(f.member);
    const target = { member, op: String(f.op), gate: String(f.gate), environment: text(f.environment) ?? runEnv(member, text(f.run_id)) };
    if (!targets.some((t) => t.member === target.member && t.op === target.op && t.gate === target.gate && t.environment === target.environment)) targets.push(target);
  }

  const applies: PlanStaleApply[] = [];
  for (const a of data.applies) {
    const at = text(a.timestamp);
    if (at === null || !(time(at) > since)) continue;
    if (samePlanDigest(text(a.plan_digest) ?? undefined, digest)) continue;
    if (!targets.some((t) => t.member === text(a.member) && t.op === a.op)) continue;
    applies.push({
      source: "applies",
      member: text(a.member),
      op: text(a.op),
      gate: text(a.gate),
      environment: null,
      component: null,
      planDigest: text(a.plan_digest),
      at,
      actor: null,
      approvedBy: text(a.approved_by),
      runId: text(a.run_id),
      runUrl: null,
      gitSha: text(a.git_sha),
      result: text(a.result),
    });
  }
  for (const d of data.deploys) {
    const at = text(d.timestamp);
    if (at === null || !(time(at) > since)) continue;
    if (!targets.some((t) => t.environment !== null && t.member === text(d.member) && t.environment === d.env)) continue;
    applies.push({
      source: "deploys",
      member: text(d.member),
      op: null,
      gate: null,
      environment: text(d.env),
      component: text(d.component),
      planDigest: null,
      at,
      actor: text(d.actor),
      approvedBy: text(d.approver),
      runId: text(d.run_id),
      runUrl: text(d.run_url),
      gitSha: text(d.git_sha),
      result: null,
    });
  }
  applies.sort((x, y) => time(x.at) - time(y.at));
  return {
    ...head,
    digest,
    plan: { recordedAt, runId: text(first.run_id), gitSha: text(first.git_sha), targets },
    stale: applies.length > 0,
    applies,
  };
}
