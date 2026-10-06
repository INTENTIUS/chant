/**
 * Reaching a gate that asks a declared decision point (#3170). The shape of
 * the declaration is in `./gate-point.ts`.
 *
 * The run asks the point with the gate's own `gate.*` inputs (those the point
 * declares) and the authored ones, through the `decide` activity's path
 * (`./activities/decide.ts`), so the chain, the model's threshold, the reuse
 * of an answer the same inputs already have and the escalation to people are
 * the decide activity's. Then:
 *
 * - The question is open (escalated to people, or a model's proposal waiting
 *   for a person): the run records a pending fact on the gate ledger that
 *   cites the question, as a plain gate records one, and ends `waiting` on
 *   the question. A person answers it with `chant workspace points answer
 *   <id>` (or through hud), and the next run, or the local operator's next
 *   round, asks again and finds the answer.
 * - It is answered with an answer the gate passes on (`pass`, default yes):
 *   the run appends a resolution to the gate ledger that cites the answer
 *   record, once per answer and plan, and walks through.
 * - It is answered otherwise: the gate step fails, naming the record. `points
 *   retract` takes the answer back and asks people again.
 *
 * `chant approve` does not pass such a gate: only the point's answer does.
 * The answer record names the gate in its `constrains` (`gate:<op>/<gate>`)
 * and, when the point declares them, in its `gate.*` inputs.
 */

import { isPendingGateExpired, latestPendingGate, DEFAULT_GATE_EXPIRY, resolveApprovalUrl, type GateAnswerRef, type GateResolutionRecord, type PendingGateRecord } from "../lifecycle/gate-ledger";
import { samePlanDigest } from "../lifecycle/plan-digest";
import { parseDuration } from "./duration";
import type { GateLedgerPort } from "./gate";
import { DEFAULT_GATE_POINT_PASS, gatePointInputs, gateSubject, type GatePoint, type GatePointFacts } from "./gate-point";
import { isPointWait, type WaitingPoint } from "./steward-points";

/** The question a gate's point was asked, as the gate reads it. */
export interface GatePointQuestion {
  /** The answer record's id: what `points answer` takes. */
  id: string;
  point: string;
  /** The record, from the repository root. */
  path: string;
  state: "escalated" | "proposed" | "answered";
  /** The answer, or null while the question is open. */
  answer: string | boolean | null;
  /** The decider that gave the recorded state: table, model or quorum. */
  decider: string;
  answeredBy: string[];
  subject: string | null;
  /** The steward whose turn asked it, or null. */
  steward: string | null;
}

/** What a gate asks its point with. */
export interface GatePointRequest {
  point: string;
  /** The authored inputs, references resolved. */
  inputs: Record<string, unknown>;
  facts: GatePointFacts;
  /** What the answer record's `constrains` names: {@link gateSubject}. */
  subject: string;
}

/** How a gate asks its point. A test passes a stub; {@link workspaceGatePointAsker} is the real one. */
export interface GatePointAsker {
  ask(request: GatePointRequest): Promise<GatePointQuestion>;
}

/**
 * The real asker: the workspace that holds `cwd`. It reads the point's
 * declared inputs from `points`, adds the `gate.*` ones the point declares,
 * and asks through the decide activity. A point with no model decider is
 * asked with no backends, so the run needs no `decide.backends`.
 */
export function workspaceGatePointAsker(cwd: string): GatePointAsker {
  return {
    async ask(request) {
      const { workspacePoints } = await import("../workspace/points-cli");
      const doc = await workspacePoints({ cwd });
      if ("error" in doc) throw new Error(`decision point ${request.point}: ${doc.error.code}: ${doc.error.message}`);
      const point = doc.points.find((p) => p.name === request.point);
      if (!point) {
        const bad = doc.sources.find((s) => s.reason);
        throw new Error(`gate "${request.facts.name}" asks decision point ${request.point}, and no points file declares it${bad ? ` (${bad.kind}: ${bad.reason!.message})` : ""}`);
      }
      const inputs = gatePointInputs(request.point, point.inputs.map((i) => i.name), request.facts, request.inputs);
      const { runDecide } = await import("./activities/decide");
      const asksModel = point.deciders.some((d) => d.kind === "model");
      try {
        const r = await runDecide({ point: request.point, inputs, subject: request.subject, cwd, ...(asksModel ? {} : { backends: {} }) });
        return { id: r.id, point: request.point, path: r.path, state: r.state, answer: r.answer, decider: r.decider, answeredBy: r.answeredBy, subject: request.subject, steward: null };
      } catch (err) {
        if (!isPointWait(err)) throw err;
        const q = err.question;
        return { id: q.id, point: q.point, path: q.path, state: q.state, answer: null, decider: "quorum", answeredBy: [], subject: q.subject, steward: q.steward };
      }
    },
  };
}

/** What the run needs to decide a gate that asks a point. */
export interface PointGateInput {
  op: string;
  gate: string;
  point: GatePoint;
  /** The authored inputs, references resolved. */
  inputs?: Record<string, unknown>;
  description?: string;
  timeout?: string;
  runId?: string;
  planDigest?: string;
  /** The environment the run was started for: the `gate.env` input. Op gate facts on the ledger record none. */
  env?: string;
  now?: string;
}

/** What reaching a gate that asks a point decided. */
export type PointGateCheck =
  | {
      satisfied: true;
      /** The resolution that cites the answer: this run's, or one an earlier run wrote for the same answer and plan. */
      resolution: GateResolutionRecord;
      answer: GateAnswerRef;
      /** Whether this run appended the resolution. */
      recorded: boolean;
      pushed?: boolean;
      pushWarning?: string;
    }
  | {
      satisfied: false;
      /** The question is answered, with an answer the gate does not pass on. */
      refused: string;
      answer: GateAnswerRef;
    }
  | {
      satisfied: false;
      /** The open question the run waits on. */
      waiting: WaitingPoint;
      /** The pending fact that cites it. */
      pending: PendingGateRecord;
      recorded: boolean;
      pushed?: boolean;
      pushWarning?: string;
    };

/** Who a resolution written for an answer is by: the people who answered, or the decider that did. */
function resolvedByOf(q: GatePointQuestion): string {
  return q.answeredBy.length > 0 ? q.answeredBy.join(", ") : q.decider;
}

/** Decide a gate that asks a point: ask it, then record the pending fact or the resolution that cites the answer. */
export async function evaluatePointGate(port: GateLedgerPort, asker: GatePointAsker, input: PointGateInput): Promise<PointGateCheck> {
  const now = input.now ?? new Date().toISOString();
  const facts: GatePointFacts = { component: input.op, name: input.gate, env: input.env ?? null, planDigest: input.planDigest ?? null };
  const q = await asker.ask({ point: input.point.name, inputs: input.inputs ?? {}, facts, subject: gateSubject(input.op, input.gate, input.env) });
  const ref: GateAnswerRef = { point: q.point, id: q.id, path: q.path };

  if (q.state === "answered" && q.answer !== null) {
    const answer: GateAnswerRef = { ...ref, answer: q.answer, decider: q.decider, ...(q.answeredBy.length > 0 ? { answeredBy: q.answeredBy } : {}) };
    const pass = input.point.pass ?? DEFAULT_GATE_POINT_PASS;
    if (!pass.includes(q.answer)) {
      return {
        satisfied: false,
        answer,
        refused:
          `decision point ${q.point} answered ${JSON.stringify(q.answer)} (${q.id}, by ${resolvedByOf(q)}), and gate "${input.gate}" passes only on ${pass.map((a) => JSON.stringify(a)).join(" or ")}. ` +
          `To ask again, take the answer back: chant workspace points retract ${q.id} --by <name>`,
      };
    }
    const ledger = await port.read(input.op);
    const standing = ledger.resolutions.find(
      (r) => r.gate === input.gate && r.answer?.id === q.id && r.environment === undefined && samePlanDigest(r.planDigest, input.planDigest),
    );
    if (standing) return { satisfied: true, resolution: standing, answer, recorded: false };
    if (!port.appendResolution) throw new Error(`gate "${input.gate}" asks decision point ${q.point}, and this gate ledger cannot record the resolution that cites its answer`);
    const { record, pushed, pushWarning } = await port.appendResolution({
      op: input.op,
      gate: input.gate,
      resolvedBy: resolvedByOf(q),
      timestamp: now,
      note: `answered through decision point ${q.point} (${q.id})`,
      ...(input.planDigest !== undefined ? { planDigest: input.planDigest } : {}),
      approver: { kind: q.decider === "quorum" || q.answeredBy.length > 0 ? "human" : "agent" },
      answer,
    });
    return { satisfied: true, resolution: record, answer, recorded: true, pushed, ...(pushWarning ? { pushWarning } : {}) };
  }

  const waiting: WaitingPoint = { id: q.id, point: q.point, state: q.state === "proposed" ? "proposed" : "escalated", path: q.path, subject: q.subject, steward: q.steward };
  const ledger = await port.read(input.op);
  const standing = latestPendingGate(ledger.pending.filter((p) => p.environment === undefined), input.gate);
  if (standing && !isPendingGateExpired(standing, now) && samePlanDigest(standing.planDigest, input.planDigest) && standing.answer?.id === q.id) {
    return { satisfied: false, waiting, pending: standing, recorded: false };
  }
  const url = resolveApprovalUrl();
  const { record, pushed, pushWarning } = await port.appendPending({
    op: input.op,
    gate: input.gate,
    timestamp: now,
    expiresAt: new Date(new Date(now).getTime() + parseDuration(input.timeout ?? DEFAULT_GATE_EXPIRY)).toISOString(),
    ...(input.description ? { description: input.description } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(url ? { url } : {}),
    ...(input.planDigest !== undefined ? { planDigest: input.planDigest } : {}),
    answer: ref,
  });
  return { satisfied: false, waiting, pending: record, recorded: true, pushed, ...(pushWarning ? { pushWarning } : {}) };
}
