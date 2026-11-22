/**
 * What waits for approval in an environment (#5480): every standing pending
 * fact on a member's gate ledgers that an approval in `env` answers, with
 * its op, its gate, the digest it binds and what kind of wait it is.
 *
 * A change waits in several places. An op wave waits at `<gate>-wave-<k>`
 * on its set digest. A pipeline stage waits at gate `<stage>` under the
 * pipeline's op, on the release digest under a release. A component's own
 * gate waits under the component (or the release gate op), per environment.
 * An Op's gate step waits under the Op. A product's `approve <env> --plan
 * <digest>` used to search a list of these it kept itself; it reads this
 * instead, and `chant approve --env <env>` does the same.
 *
 * A fact belongs to `env` when:
 *
 * - its `environment` is `env`: a pipeline stage's fact (kind `stage`, when
 *   its op is the pipeline's) or a component or release fact (`component`);
 * - its `wave.environment` is `env`, or its op is the stage's op waves
 *   (`<pipeline>-<env>`, `stageWavesName`): a wave's own fact or a hold on
 *   a wave (`wave`);
 * - it names no environment and its op is one of `ops`: an Op's gate, such
 *   as a migrate op run with `--env` (`op`), or a wave's fact written before
 *   {@link PENDING_APPROVALS_FLOOR} (`wave`, by its gate name).
 *
 * A fact stands by {@link standingPending}'s rule. A policy override's fact
 * (`chant approve policy-override`) and a decision point's (answered with
 * `chant workspace points answer`) are not approvals of a plan and are left
 * out.
 */

import { NEXT_RELEASE } from "../release-floors";
import { samePlanDigest } from "./plan-digest";
import { standingPending } from "./gate-pending-by-plan";
import type { GateResolutionRecord, PendingGateHeldBy, PendingGateRecord, PendingGateWave } from "./gate-ledger";
import type { LedgerLocation } from "./git";

/**
 * The first chant with `pendingApprovals` and `pendingApprovalsIn` in
 * `@intentius/chant/lifecycle/pending-approvals` and `@intentius/chant/ci-product`
 * (#5480), `chant approve --env <env> [--plan <digest>]` with no op or gate,
 * and `wave.environment` on an op wave's pending facts. A product's approve
 * verb feature-detects on this name before it drops its own list of gates.
 */
export const PENDING_APPROVALS_FLOOR = NEXT_RELEASE;

/** The policy override's op (`OVERRIDE_GATE_OP`, ../op/gate-name.ts), copied so this module imports no op code. */
const OVERRIDE_OP = "policy-override";

/** What kind of wait a fact is. */
export type PendingApprovalKind =
  /** An op wave's gate on its set digest, or a hook's hold on a wave. */
  | "wave"
  /** A pipeline stage's gate (`<stage>`, `<stage>-skip`, `<stage>-soak` ...) under the pipeline's op. */
  | "stage"
  /** A component's gate step, or a release gate, in this environment. */
  | "component"
  /** An Op's gate step, on a ledger the caller named in `ops`. */
  | "op";

/** One standing fact waiting in the environment. */
export interface PendingApproval {
  kind: PendingApprovalKind;
  op: string;
  gate: string;
  /** The plan digest the fact binds, the value an approval records. Absent on a gate that binds no plan. */
  digest?: string;
  /** The fact's own environment. `chant approve` takes it as `--env`. */
  environment?: string;
  /** The release the fact waits for, on a release gate. */
  releaseDigest?: string;
  /** The change set the fact cites. */
  changeSet?: string;
  wave?: PendingGateWave;
  heldBy?: PendingGateHeldBy;
  /** With `plan`: which of the fact's digests matched it. */
  matched?: "planDigest" | "changeSet" | "releaseDigest";
  description?: string;
  timestamp: string;
  expiresAt: string;
  url?: string;
  /** The `chant approve` argv that records an approval of this fact. */
  approve: string[];
}

/** What {@link pendingApprovalsIn} selects by. */
export interface PendingApprovalsSelect {
  /** The environment, or the pipeline stage, to read. */
  env: string;
  /** Keep only the facts bound to this digest: their plan, change set or release digest. */
  plan?: string;
  /** Op ledgers whose facts name no environment and belong to `env`, such as a migrate op run with `--env`. */
  ops?: readonly string[];
  /** The pipeline's op, `spec.name` of `.chant/pipeline.ts`. Null or absent: the member has none. */
  pipeline?: string | null;
  /** The time a fact's expiry is measured at. */
  now: string;
}

/** One op's ledger, as {@link pendingApprovalsIn} reads it. */
export interface PendingApprovalsLedger {
  op: string;
  pending: readonly PendingGateRecord[];
  resolutions: readonly GateResolutionRecord[];
}

const WAVE_GATE = /-wave-\d+(?:-soak)?$/;

function kindOf(op: string, p: PendingGateRecord, select: PendingApprovalsSelect): PendingApprovalKind | undefined {
  const { env, pipeline } = select;
  if (p.environment !== undefined) {
    if (p.environment !== env) return undefined;
    return pipeline && op === pipeline ? "stage" : "component";
  }
  if (p.wave?.environment !== undefined) return p.wave.environment === env ? "wave" : undefined;
  if (pipeline && op === `${pipeline}-${env}`) return "wave";
  if (select.ops?.includes(op)) return p.wave || WAVE_GATE.test(p.gate) ? "wave" : "op";
  return undefined;
}

function matchOf(p: PendingGateRecord, plan: string): PendingApproval["matched"] {
  if (samePlanDigest(p.planDigest, plan)) return "planDigest";
  if (samePlanDigest(p.changeSet, plan)) return "changeSet";
  if (samePlanDigest(p.releaseDigest, plan)) return "releaseDigest";
  return undefined;
}

/** The `chant approve` argv for a fact. */
export function approveArgv(p: Pick<PendingApproval, "op" | "gate" | "digest" | "environment">): string[] {
  return ["chant", "approve", p.op, p.gate, ...(p.digest ? ["--plan", p.digest] : []), ...(p.environment ? ["--env", p.environment] : [])];
}

/**
 * {@link pendingApprovals} over ledgers a caller read itself: the standing
 * facts of `ledgers` that wait in `select.env`, matched to `select.plan`
 * when it is given, newest first. Reads no git.
 */
export function pendingApprovalsIn(ledgers: readonly PendingApprovalsLedger[], select: PendingApprovalsSelect): PendingApproval[] {
  const out: PendingApproval[] = [];
  for (const ledger of ledgers) {
    if (ledger.op === OVERRIDE_OP) continue;
    for (const p of standingPending(ledger, select.now)) {
      if (p.answer) continue;
      const kind = kindOf(ledger.op, p, select);
      if (!kind) continue;
      const matched = select.plan !== undefined ? matchOf(p, select.plan) : undefined;
      if (select.plan !== undefined && !matched) continue;
      const found: PendingApproval = {
        kind,
        op: p.op,
        gate: p.gate,
        ...(p.planDigest ? { digest: p.planDigest } : {}),
        ...(p.environment !== undefined ? { environment: p.environment } : {}),
        ...(p.releaseDigest ? { releaseDigest: p.releaseDigest } : {}),
        ...(p.changeSet ? { changeSet: p.changeSet } : {}),
        ...(p.wave ? { wave: p.wave } : {}),
        ...(p.heldBy ? { heldBy: p.heldBy } : {}),
        ...(matched ? { matched } : {}),
        ...(p.description ? { description: p.description } : {}),
        timestamp: p.timestamp,
        expiresAt: p.expiresAt,
        ...(p.url ? { url: p.url } : {}),
        approve: [],
      };
      found.approve = approveArgv(found);
      out.push(found);
    }
  }
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/** What {@link pendingApprovals} reads. */
export interface PendingApprovalsInput extends LedgerLocation, Omit<PendingApprovalsSelect, "now" | "pipeline"> {
  /** The pipeline's op. Absent: read from `.chant/pipeline.ts` at the default branch's tip of the checkout at `cwd`. Null: the member has none. */
  pipeline?: string | null;
  /** Default now. */
  now?: string;
}

/**
 * Every standing pending fact waiting for approval in `input.env` (#5480),
 * newest first: op waves, pipeline stages, components and the Op ledgers
 * named in `ops`, each with the digest it binds and its `chant approve`
 * line. With `plan`, only the facts bound to that digest. Reads every
 * `_gates/<op>.jsonl` of the local `chant/lifecycle` (the member's own in a
 * workspace member's checkout); a caller in CI fetches it first. Returns
 * `[]` when nothing waits, and never throws for a missing ledger.
 */
export async function pendingApprovals(input: PendingApprovalsInput): Promise<PendingApproval[]> {
  const { env, plan, ops, pipeline, now: at, ...where } = input;
  const now = at ?? new Date().toISOString();
  const { GATES_DIR, readGateLedger } = await import("./gate-ledger");
  const { listFilesInDir } = await import("./git");
  const names = (await listFilesInDir(GATES_DIR, where).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
  const ledgers: PendingApprovalsLedger[] = [];
  for (const op of names) ledgers.push({ op, ...(await readGateLedger(op, where)) });
  return pendingApprovalsIn(ledgers, {
    env,
    ...(plan !== undefined ? { plan } : {}),
    ...(ops ? { ops } : {}),
    pipeline: pipeline !== undefined ? pipeline : await pipelineOpAtBase(where.cwd ?? process.cwd()),
    now,
  });
}

/** The pipeline's op (`spec.name`) as `.chant/pipeline.ts` folds at the default branch's tip, or null. */
async function pipelineOpAtBase(cwd: string): Promise<string | null> {
  try {
    const { promoteBase, readPipelineAt } = await import("../pipeline/read");
    const base = promoteBase(cwd);
    if (!base) return null;
    const read = readPipelineAt(base, cwd);
    return read.status === "folded" ? read.spec.name : null;
  } catch {
    return null;
  }
}
