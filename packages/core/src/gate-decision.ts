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
 * A gate the declaration at base names under `identity.gates` counts only a
 * sealed approval from its class: {@link identityGateAdmissionAt} reads that
 * rule from a bare clone at base, with the principal classes the pinned
 * packages supply read as data (#3888), and judges by `admitApprover`, the
 * function chant's `gateAdmission` judges by (#3862); pass its `refuses` to
 * {@link decideGateApproval}.
 *
 * With `spend` (#3784), an approval a wave already applied under is spent and
 * counts for nothing, as terragucci's wave gate has it: the caller hands in
 * the lines of `_gates/<op>/applied.jsonl` ({@link parseAppliedGateLines}).
 *
 * The module reads the ledger lines and the review it is handed; reading
 * them is the caller's. It imports no TypeScript, esbuild, zod, ajv, lint,
 * fold or codegen module, no package's code, and none of chant's git ledger
 * code, which
 * `gate-decision-bundle.test.ts` holds it to. Its rules are chant's own:
 * `./lifecycle/gate-ledger-select.ts` is what `evaluateGate` decides by, and
 * `gate-decision.test.ts` decides the same ledgers both ways.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import {
  isPendingGateExpired,
  latestPendingGate,
  latestResolutionForPlan,
} from "./lifecycle/gate-ledger-select";
import { samePlanDigest } from "./lifecycle/plan-digest";
import { isApprovalSpent, type AppliedGateRecord } from "./lifecycle/gate-applied";
import { gateSealRefusal, type GateSigners, type SealedGateApproval } from "./workspace/trust/gate-seal";
import {
  DEFAULT_SIGNERS_PATH,
  TRUST_CONFIG_PATH,
  parseAllowedSigners,
  trustConfigProblems,
} from "./workspace/trust/trust-files";
import { parseJsonText } from "./workspace/jsonc";
import { CORE_CLASSES, admitApprover, type ClassGrant, type GateAdmissionRule, type PrincipalClass } from "./workspace/identity-gate-rule";
import { diskFiles, findInstalledPackage, mergePinClasses, parseClassDataByHand, readClassFiles, type PinClassRead } from "./workspace/class-data";
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
export {
  CORE_CLASSES,
  admitApprover,
  grantedClasses,
  type ClassGrant,
  type GateAdmissionRule,
  type PrincipalClass,
} from "./workspace/identity-gate-rule";
export {
  appliedGateApplies,
  appliedGatePath,
  isApprovalSpent,
  parseAppliedGateLines,
  type AppliedGateRecord,
} from "./lifecycle/gate-applied";
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

/** The signers and role grants at `base`, as chant's trust policy reads them. */
function trustAt(repo: string, base: string): { signers: GateSigners; roles: Record<string, string[]> } {
  const off = (problems: string[]) => ({ signers: { base, signersPath: DEFAULT_SIGNERS_PATH, active: false, signers: [], problems }, roles: {} });
  const configText = showAt(repo, base, TRUST_CONFIG_PATH);
  let signersPath = DEFAULT_SIGNERS_PATH;
  let roles: Record<string, string[]> = {};
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
    roles = (raw as { roles?: Record<string, string[]> }).roles ?? {};
  }
  const text = showAt(repo, base, signersPath);
  return { signers: { base, signersPath, active: text !== undefined, signers: text === undefined ? [] : parseAllowedSigners(text).signers, problems: [] }, roles };
}

/**
 * The signers at `base`: the file `.chant/trust.json` names there, else
 * `.chant/allowed_signers`, read as chant's trust policy reads it. A
 * trust.json that is not valid (`trustConfigProblems`) turns attestation
 * off, as it does in chant, so a sealed gate passes nothing. `base` is a
 * commit the repository holds, such as {@link baseCommit}'s answer.
 */
export function gateSignersAt(repo: string, base: string): GateSigners {
  return trustAt(repo, base).signers;
}

/** A gate the declaration at base names under `identity.gates`, and the principal class its signer must be in, if any. */
export interface IdentityGate {
  gate: string;
  class: string | null;
}

/** The declaration at `base`, parsed, or null when there is none. Throws when it cannot be parsed. */
function declarationAt(repo: string, base: string): { file: string; value: unknown } | null {
  for (const file of ["chant.workspace.json", "chant.workspace.jsonc"]) {
    const text = showAt(repo, base, file);
    if (text === undefined) continue;
    const parsed = parseJsonText(text, { jsonc: file.endsWith(".jsonc") });
    if (!parsed.ok) throw new Error(`${file} at base is not valid JSON (${parsed.message}), so the gate cannot be decided`);
    return { file, value: parsed.value };
  }
  return null;
}

function identityGatesOf(declaration: unknown): IdentityGate[] {
  const gates = (declaration as { identity?: { gates?: Record<string, { class?: unknown } | null> } } | null)?.identity?.gates ?? {};
  return Object.entries(gates).map(([gate, entry]) => ({ gate, class: typeof entry?.class === "string" ? entry.class : null }));
}

/**
 * The gates `chant.workspace.json` (or `.jsonc`) at `base` names under
 * `identity.gates`: each counts only a sealed approval, from its class when
 * it names one. {@link identityGateAdmissionAt} judges an approval by one.
 * Empty when there is no declaration at base. Throws when the declaration
 * there cannot be parsed, since the gate cannot be decided.
 */
export function identityGatesAt(repo: string, base: string): IdentityGate[] {
  const declaration = declarationAt(repo, base);
  return declaration === null ? [] : identityGatesOf(declaration.value);
}

/** An `identity.gates` gate at base, and the judge for its approvals. */
export interface IdentityGateAdmission {
  requirement: IdentityGate;
  /** Why `approval` does not count toward the gate, or null when it does. Pass it to {@link decideGateApproval} as `refuses`. */
  refuses(approval: SealedGateApproval): string | null;
}

/** The domain classes the pins of the declaration at base supply, as chant's `loadClassRegistry` reads them, and the pins that could not be read. */
interface PinnedClasses {
  classes: PrincipalClass[];
  /** Pins whose classes are not known, one line each: a package pin that is not installed, or not at its pinned version. */
  unread: string[];
}

/**
 * Read the classes each pin supplies, as chant's `gateAdmission(cwd, gate,
 * base)` reads them: a path pin's `./workspace-principals` file from `base`
 * itself, so a change can't remap a class by editing its own copy of the
 * plugin; a package pin's from the package installed under `packages` (its
 * `node_modules` or a parent's), which must be at the pinned version. Reads
 * data only and imports no package.
 */
function pinnedClassesAt(repo: string, base: string, pins: unknown, packages: string): PinnedClasses {
  const reads: PinClassRead[] = [];
  const unread: string[] = [];
  (Array.isArray(pins) ? pins : []).forEach((raw: unknown, i) => {
    const pin = (raw !== null && typeof raw === "object" ? raw : {}) as { package?: unknown; version?: unknown; path?: unknown };
    if (typeof pin.path === "string" && pin.path) {
      const dir = posix.normalize(pin.path);
      const files = (path: string) => showAt(repo, base, dir === "." ? path : posix.join(dir, path));
      reads.push({ pin: i, source: pin.path, read: readClassFiles(files, pin.path, parseClassDataByHand) });
      return;
    }
    if (typeof pin.package !== "string" || !pin.package) return;
    const dir = findInstalledPackage(pin.package, packages);
    if (!dir) {
      unread.push(`${pin.package} is not installed under ${packages}`);
      return;
    }
    let installed: unknown;
    try {
      installed = (JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as { version?: unknown }).version;
    } catch {
      installed = undefined;
    }
    if (typeof pin.version === "string" && pin.version && installed !== pin.version) {
      unread.push(`${pin.package} is pinned at ${pin.version}, and ${String(installed ?? "an unknown version")} is installed under ${packages}`);
      return;
    }
    reads.push({ pin: i, source: pin.package, read: readClassFiles(diskFiles(dir), pin.package, parseClassDataByHand) });
  });
  return { classes: mergePinClasses(reads).classes, unread };
}

/** The core classes whose members no domain class can change: every one but `human`, which is the principals in no other class. */
const PIN_FREE = new Set(CORE_CLASSES.filter((c) => c.role !== null).map((c) => c.name));

/**
 * The `identity.gates` rule for `gate` at `base`, or null when the
 * declaration there names none: what chant's `gateAdmission(cwd, gate, base)`
 * answers, read from a bare clone. An approval counts when its seal verifies
 * for its approver against the signers at base and, when the gate names a
 * class, the role grants in `.chant/trust.json` at base put the approver in
 * it. Both judge with the same function ({@link admitApprover}).
 *
 * The classes are the four core ones, then the domain classes the
 * declaration's pins supply, in pin order (#3888), read as chant reads them:
 * a path pin's `./workspace-principals` file at `base`, and a package pin's
 * from the package installed under `packages` (default `repo`) at the
 * pinned version. A bare clone has no `node_modules`, so a caller that reads
 * one passes the directory its packages are installed under. Only data is
 * read; no package is imported. `classes`, when given, stands for every
 * domain class instead and no pin is read.
 *
 * When a pin can't be read (its package is not installed, or not at the
 * pinned version), a gate whose class it could change (a domain class, or
 * `human`) refuses every approval and says which pins were not read; a gate
 * naming `agent`, `runner` or `service`, or no class, is judged as usual.
 * Throws when the declaration at base cannot be parsed.
 */
export function identityGateAdmissionAt(
  repo: string,
  base: string,
  gate: string,
  opts: { classes?: readonly ClassGrant[]; packages?: string } = {},
): IdentityGateAdmission | null {
  const declaration = declarationAt(repo, base);
  const requirement = declaration === null ? undefined : identityGatesOf(declaration.value).find((g) => g.gate === gate);
  if (!requirement) return null;
  const { signers, roles } = trustAt(repo, base);
  const pins = (declaration!.value as { pins?: unknown }).pins;
  const pinned = opts.classes ? { classes: opts.classes, unread: [] } : pinnedClassesAt(repo, base, pins, opts.packages ?? repo);
  const want = requirement.class;
  if (want !== null && !PIN_FREE.has(want) && pinned.unread.length > 0) {
    const reason = `identity.gates.${gate} names the class ${want}, and the pins in ${declaration!.file} at base could not all be read, so no approval can show it is in that class: ${pinned.unread.join("; ")}`;
    return { requirement, refuses: () => reason };
  }
  const rule: GateAdmissionRule = { gate, class: want, signers, roles, classes: [...CORE_CLASSES, ...pinned.classes] };
  return { requirement, refuses: (a) => admitApprover(rule, a) };
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
  /** The approvals a wave applied under, from `_gates/<op>/applied.jsonl`. Read only with `spend`. */
  applied?: AppliedGateRecord[];
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
  /**
   * An approval a wave applied under is spent (#3784): it neither passes the
   * digest again nor stands as the approval of another. Default false.
   */
  spend?: boolean;
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
      /** With `spend`, the newest approval of this gate a wave already applied under, which therefore counted for nothing. */
      spent?: GateResolutionRecord;
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
  let spent: GateResolutionRecord | undefined;
  for (const r of mine) {
    if (input.spend && isApprovalSpent(input.ledger.applied ?? [], r)) {
      if (new Date(r.timestamp).getTime() >= new Date(since).getTime() && (!spent || new Date(r.timestamp).getTime() >= new Date(spent.timestamp).getTime())) spent = r;
      continue;
    }
    const reason = why(r);
    if (reason === null) counted.push(r);
    else if (samePlanDigest(r.planDigest, planDigest) && new Date(r.timestamp).getTime() >= new Date(since).getTime()) uncounted.push({ resolution: r, reason });
  }
  const found = latestResolutionForPlan(counted, gate, since, planDigest);
  if (found.resolution) return { status: "approved", via: "ledger", resolution: found.resolution };
  const reviewSpent =
    input.spend === true && input.review?.approved === true &&
    isApprovalSpent(input.ledger.applied ?? [], { gate, planDigest, review: { ...(input.review.review.head ? { head: input.review.review.head } : {}) } });
  if (mode === "pr-review" && input.review?.approved && !reviewSpent) return { status: "approved", via: "pr-review", review: input.review.review };

  const now = input.now ?? new Date().toISOString();
  const standing = standingFact && !isPendingGateExpired(standingFact, now) && samePlanDigest(standingFact.planDigest, planDigest) ? standingFact : undefined;
  return {
    status: "waiting",
    ...(standing ? { standing } : {}),
    ...(found.mismatched ? { mismatched: found.mismatched } : {}),
    uncounted: uncounted.sort((a, b) => new Date(a.resolution.timestamp).getTime() - new Date(b.resolution.timestamp).getTime()),
    ...(mode === "pr-review" && input.review
      ? { review: reviewSpent ? { ...input.review.review, reason: `a wave already applied this digest under the review of ${input.review.review.head?.slice(0, 12) ?? "its head"}, so the review is spent` } : input.review.review }
      : {}),
    ...(spent ? { spent } : {}),
  };
}
