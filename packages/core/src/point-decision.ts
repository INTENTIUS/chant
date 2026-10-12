/**
 * The decision for a gate that asks a decision point (#3170), for a tool that
 * runs from one bundled file (#3816).
 *
 * `@intentius/chant/point-decision` holds chant's rule for such a gate: ask
 * the point with the gate's `gate.*` facts ({@link gatePointInputs}, under
 * {@link gateSubject}), then
 *
 * - the question is open: record a pending fact that cites it, once per
 *   question and plan, and wait;
 * - it is answered with an answer the gate passes on (`pass`, default yes):
 *   record a resolution that cites the answer, once per answer and plan, and
 *   go through;
 * - it is answered otherwise: refuse, naming the record.
 *
 * Both halves are injected. A {@link GatePointAsker} asks the point (chant's
 * own, `workspaceGatePointAsker` in `@intentius/chant/op`, reads the
 * workspace; {@link chantGatePointAsker} runs the chant bin instead), and a
 * {@link PointGateLedgerPort} reads and appends the gate ledger. So this module imports no workspace, CLI,
 * TypeScript, zod or git code, which `point-decision-bundle.test.ts` holds
 * it to. `./op/gate-point-run.ts` re-exports it, and chant's own runs decide
 * by it.
 */

import { execFile } from "node:child_process";
import { isPendingGateExpired, latestPendingGate } from "./lifecycle/gate-ledger-select";
import { DEFAULT_GATE_EXPIRY, resolveApprovalUrl } from "./lifecycle/gate-pending";
import { samePlanDigest } from "./lifecycle/plan-digest";
import type { GateAnswerRef, GateResolutionRecord, PendingGateRecord } from "./lifecycle/gate-ledger";
import { parseDuration } from "./op/duration";
import type { GateLedgerPort } from "./op/gate";
import { DEFAULT_GATE_POINT_PASS, defaultGatePointStore, gatePointInputs, gateSubject, type GatePoint, type GatePointFacts, type GatePointStore } from "./op/gate-point";
import type { WaitingPoint } from "./op/steward-points";

export {
  DEFAULT_GATE_POINT_PASS,
  GATE_POINT_INPUTS,
  defaultGatePointStore,
  gatePointInputs,
  gatePointOf,
  gatePointProblems,
  gateSubject,
  type GatePoint,
  type GatePointFacts,
  type GatePointStore,
} from "./op/gate-point";
export type { GateAnswerRef, GateResolutionRecord, GateResolutionInput, PendingGateInput, PendingGateRecord } from "./lifecycle/gate-ledger";
export type { WaitingPoint } from "./op/steward-points";

/**
 * The gate ledger as {@link evaluatePointGate} uses it: read an op's facts,
 * append a pending fact, append a resolution. chant's own is
 * `gitGateLedgerPort` (`@intentius/chant/op`), on `chant/lifecycle`.
 */
export type PointGateLedgerPort = Pick<GateLedgerPort, "read" | "appendPending" | "appendResolution">;

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
  /** Where the question goes, as the gate's `point.store` declares it (#3815). Undefined leaves it to the asker. */
  store?: GatePointStore;
}

/**
 * How a gate asks its point. A test passes a stub; `workspaceGatePointAsker`
 * (`@intentius/chant/op`) is chant's, which asks through the workspace. A tool
 * built into one file passes its own, such as one that runs the chant bin.
 */
export interface GatePointAsker {
  ask(request: GatePointRequest): Promise<GatePointQuestion>;
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
export async function evaluatePointGate(port: PointGateLedgerPort, asker: GatePointAsker, input: PointGateInput): Promise<PointGateCheck> {
  const now = input.now ?? new Date().toISOString();
  const facts: GatePointFacts = { component: input.op, name: input.gate, env: input.env ?? null, planDigest: input.planDigest ?? null };
  const q = await asker.ask({ point: input.point.name, inputs: input.inputs ?? {}, facts, subject: gateSubject(input.op, input.gate, input.env), ...(input.point.store ? { store: input.point.store } : {}) });
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

/** How {@link chantGatePointAsker} runs chant. */
export interface ChantGatePointAskerOptions {
  /** The chant command and its leading arguments, such as `["npx", "chant"]` or `[process.execPath, "/path/to/chant"]`. */
  command: string[];
  /** Where the workspace is found. Defaults to the working directory. */
  cwd?: string;
}

/** Run chant with `args` and parse the JSON document it prints. A refusal is a document too, and exits 1. */
function runChantJson(opts: ChantGatePointAskerOptions, args: string[]): Promise<Record<string, unknown>> {
  const [bin, ...lead] = opts.command;
  return new Promise((resolve, reject) => {
    execFile(bin, [...lead, ...args], { cwd: opts.cwd, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout) as Record<string, unknown>);
      } catch {
        reject(new Error(`chant ${args.slice(0, 3).join(" ")} printed no JSON document${err ? `: ${err.message}` : ""}${stderr ? `\n${stderr.trim()}` : ""}`));
      }
    });
  });
}

function refusal(what: string, doc: Record<string, unknown>): Error | undefined {
  const e = doc.error as { code?: string; message?: string } | undefined;
  return e ? new Error(`${what}: ${e.code}: ${e.message}`) : undefined;
}

/**
 * A {@link GatePointAsker} that runs the chant bin, for a tool that bundles
 * this module and not the workspace code (#3816). It reads the point's
 * declared inputs with `chant workspace points --json`, passes the gate's
 * `gate.*` ones ({@link gatePointInputs}), and asks with `chant workspace
 * points ask <point> --inputs <json> --subject <gate> --json`, with `--store`
 * from the gate's `point.store` or, naming none, the ledger in a CI job
 * ({@link defaultGatePointStore}). chant calls no model here, so a point's
 * model decider is not asked and its question goes to people; a table and a
 * quorum decide as in chant's own runs.
 */
export function chantGatePointAsker(opts: ChantGatePointAskerOptions): GatePointAsker {
  return {
    async ask(request) {
      const listed = await runChantJson(opts, ["workspace", "points", "--json"]);
      const bad = refusal(`decision point ${request.point}`, listed);
      if (bad) throw bad;
      const point = (listed.points as { name: string; inputs: { name: string }[] }[] | undefined)?.find((p) => p.name === request.point);
      if (!point) throw new Error(`gate "${request.facts.name}" asks decision point ${request.point}, and no points file declares it`);
      const inputs = gatePointInputs(request.point, point.inputs.map((i) => i.name), request.facts, request.inputs);
      const store = request.store ?? defaultGatePointStore();
      const doc = await runChantJson(opts, ["workspace", "points", "ask", request.point, "--inputs", JSON.stringify(inputs), "--subject", request.subject, ...(store ? ["--store", store] : [])]);
      const failed = refusal(`decision point ${request.point}`, doc);
      if (failed) throw failed;
      const q = doc.question as {
        id: string;
        point: string;
        path: string;
        state: GatePointQuestion["state"];
        answer: string | boolean | null;
        decider: { kind?: unknown };
        answeredBy: string[];
        subject: string | null;
        askedBy: { steward: string } | null;
      };
      return {
        id: q.id,
        point: q.point,
        path: q.path,
        state: q.state,
        answer: q.state === "answered" ? q.answer : null,
        decider: typeof q.decider?.kind === "string" ? q.decider.kind : "quorum",
        answeredBy: q.answeredBy ?? [],
        subject: q.subject,
        steward: q.askedBy?.steward ?? null,
      };
    },
  };
}
