/**
 * A gate's decision for a plan digest, and the seal check it needs, for a
 * tool that runs from one bundled file (#3763, decision #3756).
 *
 * `@intentius/chant/gate-decision` holds what a tool needs to decide a
 * plan-bound gate the way chant's own wave gate does (`chant run wave`,
 * `./op/op-waves-run.ts`) under each approval mode:
 *
 * - `ledger`: an approval of this digest on `chant/lifecycle`, newer than the
 *   gate's newest pending fact ({@link decideGateApproval}).
 * - `sealed`: the same, counting only an approval whose seal verifies for its
 *   approver against the signers file at base ({@link gateSignersAt},
 *   {@link gateSealRefusal}). The seal is checked with node:crypto, so the job
 *   needs no ssh-keygen.
 * - `pr-review`: the same as `ledger`, or else the merged pull request's
 *   approving review, when its head planned this digest
 *   ({@link reviewApproval}).
 *
 * The module reads the ledger lines and the review it is handed; reading
 * them is the caller's. It imports no TypeScript, esbuild, zod, lint, fold or
 * codegen module, and none of chant's git ledger code, which
 * `gate-decision-bundle.test.ts` holds it to. Its rules are chant's own:
 * `./lifecycle/gate-ledger-select.ts` is what `evaluateGate` decides by, and
 * `gate-decision.test.ts` decides the same ledgers both ways.
 */

import { spawnSync } from "node:child_process";
import {
  isPendingGateExpired,
  latestPendingGate,
  latestResolutionForPlan,
} from "./lifecycle/gate-ledger-select";
import { samePlanDigest } from "./lifecycle/plan-digest";
import { gateSealRefusal, type GateSigners } from "./workspace/trust/gate-seal";
import {
  DEFAULT_SIGNERS_PATH,
  TRUST_CONFIG_PATH,
  parseAllowedSigners,
  trustConfigProblems,
} from "./workspace/trust/trust-files";
import { parseJsonText } from "./workspace/jsonc";
import type { GateResolutionRecord, PendingGateRecord } from "./lifecycle/gate-ledger";
import type { MergedReview } from "./op/gate-review";
import type { GateApprovalSource } from "./op/op-waves";

export { GATE_APPROVAL_SOURCES, type GateApprovalSource } from "./op/op-waves";
export {
  isPendingGateExpired,
  latestPendingGate,
  latestResolutionForPlan,
  latestResolutionSince,
  type PlanBoundResolution,
} from "./lifecycle/gate-ledger-select";
export {
  GATE_SEAL_NAMESPACE,
  gateSealPayload,
  gateSealRefusal,
  sshKeyFingerprint,
  verifySshSignatureWith,
  type GateSigners,
  type SealedGateApproval,
  type SshSignatureCheck,
} from "./workspace/trust/gate-seal";
export {
  DEFAULT_SIGNERS_PATH,
  TRUST_CONFIG_PATH,
  parseAllowedSigners,
  trustConfigProblems,
  type Signer,
  type SignerSet,
} from "./workspace/trust/trust-files";
export type { GateResolutionRecord, PendingGateRecord } from "./lifecycle/gate-ledger";
export type { MergedReview } from "./op/gate-review";

// ── reading at base ──────────────────────────────────────────────────────

function git(repo: string, args: string[]) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf-8" });
}

/** A file's text at `base`, or undefined when `base` holds no file at `path`. */
function showAt(repo: string, base: string, path: string): string | undefined {
  const r = git(repo, ["cat-file", "blob", `${base}:${path}`]);
  return r.status === 0 ? r.stdout : undefined;
}

/**
 * The commit a gate's rule is read at when the default branch applies its
 * own commit: the first parent of HEAD, the branch as it stood before the
 * merge, so a merge that adds a signer or drops a gate does not judge its own
 * apply. A shallow checkout fetches that one commit from `origin`. A root
 * commit has no parent and is its own base. Throws when it cannot be read.
 */
export function baseCommit(repo: string): string {
  const head = git(repo, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  const sha = head.stdout.trim();
  if (head.status !== 0 || !sha) throw new Error(`${repo} has no commit checked out, so the gate cannot be decided`);
  // The commit object's first `parent` line: a shallow clone keeps it even when it lacks the parent itself.
  const header = git(repo, ["cat-file", "commit", sha]).stdout.split("\n\n")[0] ?? "";
  const parent = /^parent ([0-9a-f]{40,64})$/m.exec(header)?.[1];
  if (!parent) return sha;
  const has = () => git(repo, ["cat-file", "-e", `${parent}^{commit}`]).status === 0;
  if (!has()) git(repo, ["fetch", "-q", "--depth=1", "origin", parent]);
  if (!has()) throw new Error(`cannot fetch ${parent.slice(0, 12)}, the commit before this one, so the gate cannot be decided`);
  return parent;
}

/**
 * The signers at `base`: the file `.chant/trust.json` names there, else
 * `.chant/allowed_signers`, read as chant's trust policy reads it. A
 * trust.json that is not valid (`trustConfigProblems`) turns attestation
 * off, as it does in chant, so a sealed gate passes nothing. `base` is a
 * commit the repository holds, such as {@link baseCommit}'s answer.
 */
export function gateSignersAt(repo: string, base: string): GateSigners {
  const off = (problems: string[]): GateSigners => ({ base, signersPath: DEFAULT_SIGNERS_PATH, active: false, signers: [], problems });
  const configText = showAt(repo, base, TRUST_CONFIG_PATH);
  let signersPath = DEFAULT_SIGNERS_PATH;
  if (configText !== undefined) {
    let raw: unknown;
    try {
      raw = JSON.parse(configText);
    } catch (err) {
      return off([`${TRUST_CONFIG_PATH} is not JSON: ${err instanceof Error ? err.message : String(err)}`]);
    }
    const problems = trustConfigProblems(raw);
    if (problems.length > 0) return off([`${TRUST_CONFIG_PATH} is invalid: ${problems.join("; ")}`]);
    signersPath = (raw as { signers?: string }).signers ?? DEFAULT_SIGNERS_PATH;
  }
  const text = showAt(repo, base, signersPath);
  return { base, signersPath, active: text !== undefined, signers: text === undefined ? [] : parseAllowedSigners(text).signers, problems: [] };
}

/** A gate the declaration at base names under `identity.gates`, and the principal class its signer must be in, if any. */
export interface IdentityGate {
  gate: string;
  class: string | null;
}

/**
 * The gates `chant.workspace.json` (or `.jsonc`) at `base` names under
 * `identity.gates`: each counts only a sealed approval, from its class when
 * it names one. chant checks the class against the role grants at base; this
 * reads the names. Empty when there is no declaration at base. Throws when
 * the declaration there cannot be parsed, since the gate cannot be decided.
 */
export function identityGatesAt(repo: string, base: string): IdentityGate[] {
  for (const file of ["chant.workspace.json", "chant.workspace.jsonc"]) {
    const text = showAt(repo, base, file);
    if (text === undefined) continue;
    const parsed = parseJsonText(text, { jsonc: file.endsWith(".jsonc") });
    if (!parsed.ok) throw new Error(`${file} at base is not valid JSON (${parsed.message}), so the gate cannot be decided`);
    const gates = (parsed.value as { identity?: { gates?: Record<string, { class?: unknown } | null> } } | null)?.identity?.gates ?? {};
    return Object.entries(gates).map(([gate, entry]) => ({ gate, class: typeof entry?.class === "string" ? entry.class : null }));
  }
  return [];
}

// ── pr-review ────────────────────────────────────────────────────────────

/** What a pull request's review says about a wave, under `pr-review`. */
export interface ReviewApproval {
  approved: boolean;
  review: { pr?: number; head?: string; approvers?: string[]; url?: string; reason?: string };
}

/**
 * Whether the merged pull request's review approves `digest` (#3684): a
 * writer other than its author approved its head, and the head planned this
 * digest (`headDigest`, from the plans `chant run wave --record-plans`
 * recorded for the head; undefined when none were). Reading the review and
 * the plans is the caller's; under `pr-review` the caller records the
 * approval on the ledger when this approves.
 */
export function reviewApproval(merged: MergedReview, headDigest: string | undefined, digest: string): ReviewApproval {
  const seen = { pr: merged.pr, head: merged.head, ...(merged.url ? { url: merged.url } : {}) };
  if (merged.approvers.length === 0) {
    const why = merged.refused.length > 0 ? merged.refused.join("; ") : "nobody approved it";
    return { approved: false, review: { ...seen, reason: `no writer other than its author approved the head of #${merged.pr}: ${why}` } };
  }
  if (headDigest === undefined) {
    return {
      approved: false,
      review: { ...seen, approvers: merged.approvers, reason: `no plans are recorded for the head ${merged.head.slice(0, 12)} of #${merged.pr} (its pipeline runs \`chant run wave --record-plans\`)` },
    };
  }
  if (headDigest !== digest) {
    return {
      approved: false,
      review: { ...seen, approvers: merged.approvers, reason: `the plan moved after the review: the head planned ${headDigest}, and the merge plans ${digest}` },
    };
  }
  return { approved: true, review: { ...seen, approvers: merged.approvers } };
}

// ── the decision ─────────────────────────────────────────────────────────

/** The gate ledger lines of one op, as `chant/lifecycle` holds them in `_gates/<op>.jsonl`. */
export interface GateLedgerLines {
  resolutions: GateResolutionRecord[];
  pending: PendingGateRecord[];
}

export interface GateApprovalInput {
  ledger: GateLedgerLines;
  gate: string;
  /** The digest the gate binds: the plan, or a wave's set digest. */
  planDigest: string;
  /** On a component gate, the environment: only its pending facts and approvals count. */
  environment?: string;
  /** Which approvals count. Default `ledger`. */
  mode?: GateApprovalSource;
  /** The signers at base, which a `sealed` gate checks seals against ({@link gateSignersAt}). Absent under `sealed`, nothing counts. */
  signers?: GateSigners;
  /** Another rule an approval must pass, such as chant's `identity.gates` rule: why it does not count, or null. */
  refuses?: (approval: GateResolutionRecord) => string | null;
  /** Under `pr-review`, what the merged pull request's review says ({@link reviewApproval}); consulted only when no approval on the ledger counts. */
  review?: ReviewApproval;
  /** ISO-8601 now, for whether the standing pending fact has expired. */
  now?: string;
}

/** An approval of this gate and digest that a rule did not count, and why. */
export interface UncountedApproval {
  resolution: GateResolutionRecord;
  reason: string;
}

export type GateApprovalDecision =
  | { status: "approved"; via: "ledger"; resolution: GateResolutionRecord }
  | { status: "approved"; via: "pr-review"; review: ReviewApproval["review"] }
  | {
      status: "waiting";
      /** The pending fact that still stands for this digest, unexpired: a caller that records one need not record another. */
      standing?: PendingGateRecord;
      /** The newest counted approval of this gate for another digest, or for none: the plan moved since it. */
      mismatched?: GateResolutionRecord;
      /** Approvals of this digest the mode or `refuses` did not count, newest last. */
      uncounted: UncountedApproval[];
      /** Under `pr-review`, why the review did not approve. */
      review?: ReviewApproval["review"];
    };

const EPOCH = new Date(0).toISOString();

/**
 * Decide a plan-bound gate against its ledger lines, as chant's wave gate
 * does: an approval counts when it names this gate and digest (and
 * environment, when set), is newer than the gate's newest pending fact, and
 * passes the mode's rule: any under `ledger` and `pr-review`, a verified seal
 * under `sealed`. With none, `pr-review` takes the review's answer. Writes
 * nothing: recording a pending fact, or the review's approval, is the
 * caller's.
 */
export function decideGateApproval(input: GateApprovalInput): GateApprovalDecision {
  const { gate, planDigest, environment: env } = input;
  const mode = input.mode ?? "ledger";
  const pending = env === undefined ? input.ledger.pending : input.ledger.pending.filter((p) => p.environment === env);
  const mine = (env === undefined ? input.ledger.resolutions : input.ledger.resolutions.filter((r) => r.environment === undefined || r.environment === env)).filter(
    (r) => r.gate === gate,
  );
  const sealed = mode === "sealed";
  const noSigners: GateSigners = { base: null, signersPath: DEFAULT_SIGNERS_PATH, active: false, signers: [], problems: ["no signers were read for this sealed gate"] };
  const why = (r: GateResolutionRecord): string | null =>
    input.refuses?.(r) ?? (sealed ? gateSealRefusal(input.signers ?? noSigners, r) : null);

  const standingFact = latestPendingGate(pending, gate);
  const since = standingFact?.timestamp ?? EPOCH;
  const counted: GateResolutionRecord[] = [];
  const uncounted: UncountedApproval[] = [];
  for (const r of mine) {
    const reason = why(r);
    if (reason === null) counted.push(r);
    else if (samePlanDigest(r.planDigest, planDigest) && new Date(r.timestamp).getTime() >= new Date(since).getTime()) uncounted.push({ resolution: r, reason });
  }
  const found = latestResolutionForPlan(counted, gate, since, planDigest);
  if (found.resolution) return { status: "approved", via: "ledger", resolution: found.resolution };
  if (mode === "pr-review" && input.review?.approved) return { status: "approved", via: "pr-review", review: input.review.review };

  const now = input.now ?? new Date().toISOString();
  const standing = standingFact && !isPendingGateExpired(standingFact, now) && samePlanDigest(standingFact.planDigest, planDigest) ? standingFact : undefined;
  return {
    status: "waiting",
    ...(standing ? { standing } : {}),
    ...(found.mismatched ? { mismatched: found.mismatched } : {}),
    uncounted: uncounted.sort((a, b) => new Date(a.resolution.timestamp).getTime() - new Date(b.resolution.timestamp).getTime()),
    ...(mode === "pr-review" && input.review ? { review: input.review.review } : {}),
  };
}
