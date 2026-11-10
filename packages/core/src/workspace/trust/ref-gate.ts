/**
 * The ref gate (#4867): a ref update is refused when the commit lacks the
 * runner evidence the policy at base requires for that ref.
 *
 * chant judges evidence at the green tick, a land, a gate and a release cut,
 * all after the push. A change that was never going to pass still reached
 * the remote and started CI. The gate judges it at the ref update instead,
 * from three places that all call {@link decideRefUpdate}:
 *
 * - a plain git remote: the `pre-receive` hook `chant workspace ref-gate
 *   install` writes, which refuses the push;
 * - a forge: `chant workspace ref-gate status`, a commit status the forge
 *   requires, so the merge is refused where the push can't be;
 * - the developer's side: the `pre-push` hook, which refuses before the
 *   network and records the request for an override.
 *
 * The rules are `refs` in `.chant/trust.json`, read at base like every other
 * part of the trust policy (./policy.ts): the old tip of the ref, so a change
 * can neither drop a check nor add the runner key that signs its own
 * evidence. Evidence is the runner evidence of ./evidence.ts, kept as git
 * notes on the commit under {@link EVIDENCE_NOTES_REF}, one envelope per
 * line, and verified offline against the runner keys at base. A check has
 * current evidence when an envelope for it verifies and every record it
 * names hashes the same at the pushed commit; an envelope that names no
 * records counts only for a commit with the tree it was signed over.
 *
 * An override is the override gate's (../../override-gate.ts): a person
 * the overriders file at base lists records a reasoned approval of one
 * commit and one check, subject `ref-gate-<sha12>-<check>`, and it is spent
 * by the first ref update it admits. Every decision is a line of the gate's
 * ledger, a JSON-lines file in the git directory ({@link refGateLedgerPath}),
 * since a pre-receive hook may not move a ref.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ReasonCode } from "../reason-codes";
import { verifyEvidence, type EvidenceErrorCode } from "./evidence";
import { policyAtBase, resolveBase } from "./provenance";
import { runnersAt, type RefRule, type TrustPolicy } from "./policy";
import {
  OVERRIDE_APPLIED,
  OVERRIDE_LEDGER,
  OVERRIDERS_PATH,
  decideOverride,
  overrideCommand,
  overridersAt,
  parseAppliedOverrides,
  type AppliedOverrideRecord,
} from "../../override-gate";
import { parseGateLedger } from "../../lifecycle/gate-ledger";
import { gateSignersAt } from "../../gate-decision";
import type { GateSigners } from "../../lifecycle/gate-seal";

/** Where runner evidence for a commit is kept (#4867): a git note on the commit, one DSSE envelope per line. */
export const EVIDENCE_NOTES_REF = "refs/notes/chant/evidence";
/** The ledger branch whose override lines the gate reads. */
export const LIFECYCLE_REF = "refs/heads/chant/lifecycle";
/** The commit status a forge requires when the rule names none. */
export const REF_GATE_STATUS = "chant/ref-gate";
/** git's id for no object, in hook input. */
const ZERO = /^0+$/;

/** Why the gate cannot decide at all. Each is in `reason-codes.ts` and `ref-gate.schema.json`. */
export const REF_GATE_ERROR_CODES = ["not-a-git-repository", "revision-unknown", "trust-policy-unreadable", "ref-update-invalid"] as const satisfies readonly ReasonCode[];
export type RefGateErrorCode = (typeof REF_GATE_ERROR_CODES)[number];

/** Why a required check has no current evidence. The envelope codes are those of `evidence verify`. */
export const REF_GATE_CHECK_CODES = [
  "ref-evidence-missing",
  "ref-evidence-stale",
  "envelope-invalid",
  "envelope-untrusted",
  "evidence-payload-type",
  "evidence-statement-invalid",
  "evidence-runner-mismatch",
] as const satisfies readonly ReasonCode[];
export type RefGateCheckCode = (typeof REF_GATE_CHECK_CODES)[number];

/** One ref update, as a hook reads it. `null` is git's zero id: a ref created (`old`) or deleted (`new`). */
export interface RefUpdate {
  ref: string;
  old: string | null;
  new: string | null;
}

export interface OverrideUsed {
  subject: string;
  by: string;
  at: string;
  reason: string;
  digest: string;
}

/** A required check, judged. */
export interface CheckVerdict {
  check: string;
  action: "block" | "warn";
  /** The command that produces the evidence. */
  command: string;
  status: "current" | "stale" | "missing" | "overridden";
  /** Why it has no current evidence. Absent when it has. */
  code?: RefGateCheckCode;
  reason: string;
  /** The runner whose evidence counted. */
  runner?: string;
  /** The override it was let through under. */
  override?: OverrideUsed;
  /** The subject an override of this check names. */
  subject: string;
}

export interface RefDecision {
  ref: string;
  old: string | null;
  new: string | null;
  /** The commit the policy was read at, or null when there is none. */
  base: string | null;
  decision: "admit" | "refuse";
  /** The commit status a forge requires for this ref, when a rule matched. */
  status: string | null;
  checks: CheckVerdict[];
  /** Set when the gate could not decide; the update is then refused. */
  error?: { code: RefGateErrorCode; message: string };
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
}

function tryGit(repo: string, args: string[]): string | undefined {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : undefined;
}

/** The commit `rev` names, peeled, or undefined. */
export function commitOf(repo: string, rev: string): string | undefined {
  return tryGit(repo, ["rev-parse", "--verify", "-q", `${rev}^{commit}`])?.trim() || undefined;
}

/** A ref pattern as a RegExp: `**` matches across `/`, `*` within one segment. */
export function refPatternRegExp(pattern: string): RegExp {
  const body = pattern
    .split("**")
    .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

/**
 * The checks the policy requires for `ref`: every matching rule's, each check
 * once. A check two rules name is `block` when either blocks it; the first
 * rule that names a status or an override mode gives it.
 */
export function rulesFor(policy: Pick<TrustPolicy, "refs">, ref: string): { matched: boolean; checks: RefRule["checks"]; status: string; overrides?: "ledger" | "sealed" } {
  const matching = (policy.refs ?? []).filter((r) => refPatternRegExp(r.ref).test(ref));
  const checks = new Map<string, RefRule["checks"][number]>();
  for (const r of matching) {
    for (const c of r.checks) {
      const before = checks.get(c.check);
      if (!before) checks.set(c.check, { ...c });
      else if (c.action === "block") before.action = "block";
    }
  }
  const overrides = matching.find((r) => r.overrides)?.overrides;
  return {
    matched: matching.length > 0,
    checks: [...checks.values()],
    status: matching.find((r) => r.status)?.status ?? REF_GATE_STATUS,
    ...(overrides ? { overrides } : {}),
  };
}

/** The ref gate's rules for one ref, read at base, as a product reads them (#4913). */
export interface RefGateRules {
  ref: string;
  /** The commit the policy was read at, or null when there is none. */
  base: string | null;
  /** A rule of the policy at base matches the ref. */
  matched: boolean;
  /** The commit status the ref gate's status job sets for the ref, which the forge should require; null when no rule matches. */
  status: string | null;
  /** The checks an update of the ref needs current evidence for, each once, as {@link rulesFor} merges them. */
  checks: RefRule["checks"];
  overrides?: "ledger" | "sealed";
  /**
   * Why the policy at base cannot be read. The gate then refuses every
   * update of the ref and sets no status, so a product should refuse too.
   */
  problems: string[];
}

/**
 * The ref gate's rules for `ref` from the policy at `base` (#4913), the same
 * read {@link decideRefUpdate} makes, for a product that acts on them
 * without deciding an update: an apply that waits for the status the gate
 * sets (`@intentius/chant/ref-gate-rules`), or a forge check that requires
 * it. `base` defaults as `check` and `status` default it: `origin/HEAD`,
 * then `main`, then `master`. A base that names no commit is a problem; no
 * base at all is no policy, so nothing is required.
 */
export function refGateRulesAt(repo: string, opts: { ref: string; base?: string }): RefGateRules {
  const resolved = resolveBase(repo, opts.base);
  const none = { ref: opts.ref, base: resolved.commit, matched: false, status: null, checks: [] };
  if (!resolved.commit) return { ...none, problems: opts.base !== undefined && resolved.problem ? [resolved.problem] : [] };
  const policy = policyAtBase(repo, resolved);
  if (policy.problems.length > 0) return { ...none, problems: [...policy.problems] };
  const rules = rulesFor(policy, opts.ref);
  if (!rules.matched) return { ...none, problems: [] };
  return { ref: opts.ref, base: resolved.commit, matched: true, status: rules.status, checks: rules.checks, ...(rules.overrides ? { overrides: rules.overrides } : {}), problems: [] };
}

/**
 * The status a forge's default branch should require for the ref gate
 * (#4913), for a forge check whose pipeline renders the `ref-gate` job: the
 * policy's status for `refs/heads/<defaultBranch>`, read at
 * `origin/<defaultBranch>` when the checkout has it, else at `HEAD`. With
 * no rule for the branch the job sets no status, so none is required and
 * `note` says so; a policy that can't be read is a `problem`.
 */
export function refGateStatusFor(repo: string, defaultBranch: string): { status?: string; note?: string; problem?: string } {
  const remote = `refs/remotes/origin/${defaultBranch}`;
  const rules = refGateRulesAt(repo, { ref: `refs/heads/${defaultBranch}`, base: commitOf(repo, remote) ? remote : "HEAD" });
  if (rules.problems.length > 0) return { problem: `the trust policy can't be read, so the ref gate sets no status to require: ${rules.problems.join("; ")}` };
  if (!rules.matched || !rules.status) {
    return { note: `no refs rule in .chant/trust.json${rules.base ? ` at ${rules.base.slice(0, 8)}` : ""} matches refs/heads/${defaultBranch}, so the ref-gate job sets no status there and none is required` };
  }
  return { status: rules.status };
}

// ── evidence notes ───────────────────────────────────────────────────────

/** The envelopes in a note's text: one per line, or the whole note as one envelope or an array of them. */
export function parseEvidenceNote(text: string): unknown[] {
  try {
    const whole = JSON.parse(text) as unknown;
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    const out: unknown[] = [];
    for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
      try {
        out.push(JSON.parse(line));
      } catch {
        out.push(line);
      }
    }
    return out;
  }
}

/** The note on `commit` in the notes commit `notes`, which may fan its paths out. */
function noteText(repo: string, notes: string, commit: string): string | undefined {
  const list = tryGit(repo, ["ls-tree", "-r", "--full-tree", notes]);
  if (!list) return undefined;
  for (const line of list.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    if (line.slice(tab + 1).replace(/\//g, "") !== commit) continue;
    const blob = line.slice(0, tab).split(" ")[2];
    return tryGit(repo, ["cat-file", "blob", blob]);
  }
  return undefined;
}

/** The envelopes attached to `commit`, read from the notes commit `notes` (default: {@link EVIDENCE_NOTES_REF}'s tip). */
export function evidenceFor(repo: string, commit: string, notes?: string | null): unknown[] {
  const tip = notes === undefined ? commitOf(repo, EVIDENCE_NOTES_REF) : notes;
  if (!tip) return [];
  const text = noteText(repo, tip, commit);
  return text === undefined ? [] : parseEvidenceNote(text);
}

/**
 * Attach `envelope` to `commit` as one line of its evidence note. Pushing `refs/notes/chant/evidence` is the caller's.
 * `notesRef` is another notes ref, for local evidence (#4868), which the ref gate never reads.
 */
export function attachEvidence(repo: string, commit: string, envelope: unknown, notesRef: string = EVIDENCE_NOTES_REF): void {
  git(repo, [...notesIdentity(repo), "notes", `--ref=${notesRef}`, "append", "-m", JSON.stringify(envelope), commit]);
}

/**
 * A notes commit needs an author and a committer, and a CI job often has no
 * git identity configured, so `git notes append` failed there ("Author
 * identity unknown"). Where the repository names none, the evidence notes
 * are written as chant's. The envelope's signature, not the notes commit's
 * author, says who signed the evidence.
 */
function notesIdentity(repo: string): string[] {
  const named = (key: string) => !!tryGit(repo, ["config", "--get", key])?.trim();
  return [
    ...(named("user.name") || process.env.GIT_AUTHOR_NAME ? [] : ["-c", "user.name=chant evidence"]),
    ...(named("user.email") || process.env.GIT_AUTHOR_EMAIL ? [] : ["-c", "user.email=chant-evidence@localhost"]),
  ];
}

/** The check an envelope claims to be for, read without verifying, so a refusal can say which check a bad envelope was meant for. */
function claimedCheck(envelope: unknown): string | undefined {
  try {
    const payload = (envelope as { payload?: unknown }).payload;
    if (typeof payload !== "string") return undefined;
    const check = (JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { predicate?: { check?: unknown } }).predicate?.check;
    return typeof check === "string" ? check : undefined;
  } catch {
    return undefined;
  }
}

type Judged = { status: "current"; runner: string } | { status: "stale" | "missing"; code: RefGateCheckCode; reason: string };

/** The best evidence among `envelopes` for `check` at `commit`: current beats stale beats an envelope that does not verify beats none. */
function judgeCheck(repo: string, policy: TrustPolicy, envelopes: readonly unknown[], check: string, commit: string, tree: string): Judged {
  let stale: string | undefined;
  let bad: { code: EvidenceErrorCode; reason: string } | undefined;
  for (const env of envelopes) {
    // #4869: keys and keyless identities; under keyless.since, keys only for a commit before it.
    const v = verifyEvidence(env, runnersAt(policy, { repo, commit }), repo, commit);
    if (!v.ok) {
      if (claimedCheck(env) === check && !bad) bad = { code: v.code, reason: v.reason };
      continue;
    }
    if (v.statement.predicate.check !== check) continue;
    const signedAt = v.statement.predicate.commit.slice(0, 8);
    if (v.subjects.length === 0 && v.statement.predicate.tree !== tree) {
      stale ??= `the evidence from ${v.runner} names no records and was signed over another tree, at ${signedAt}`;
      continue;
    }
    if (v.status === "current") return { status: "current", runner: v.runner };
    const changed = v.subjects.filter((s) => !s.matches).map((s) => (s.now === null ? `${s.name} is gone` : `${s.name} changed`));
    stale ??= `the evidence from ${v.runner} was signed at ${signedAt}, and since then ${changed.join(", ")}`;
  }
  if (stale) return { status: "stale", code: "ref-evidence-stale", reason: stale };
  if (bad) return { status: "missing", code: bad.code as RefGateCheckCode, reason: `an envelope for ${check} does not count: ${bad.reason}` };
  return { status: "missing", code: "ref-evidence-missing", reason: `no evidence for ${check} is attached to ${commit.slice(0, 8)} under ${EVIDENCE_NOTES_REF}` };
}

// ── overrides ────────────────────────────────────────────────────────────

/** The subject an override of `check` for `commit` names. */
export function refGateSubject(commit: string, check: string): string {
  return `ref-gate-${commit.slice(0, 12)}-${check}`;
}

function blobAt(repo: string, rev: string, path: string): string | undefined {
  return tryGit(repo, ["cat-file", "blob", `${rev}:${path}`]);
}

// ── the decision ─────────────────────────────────────────────────────────

export interface RefGateInput {
  /** The repository, bare or not. */
  repo: string;
  update: RefUpdate;
  /** The commit the policy is read at: the ref's old tip, or the default branch for a new ref. Null: no policy, nothing required. */
  base: string | null;
  /** The notes commit evidence is read from. Default: {@link EVIDENCE_NOTES_REF}'s tip. */
  notes?: string | null;
  /** The `chant/lifecycle` commit override lines are read from. Default: {@link LIFECYCLE_REF}'s tip. */
  lifecycle?: string | null;
  /** Overrides already spent, from the gate's own ledger ({@link spentOverrides}). */
  spent?: readonly AppliedOverrideRecord[];
  /** ISO-8601 now. */
  now?: string;
}

/** Decide one ref update against the policy at base. Never throws for a policy or an envelope it can't read: it refuses. */
export function decideRefUpdate(input: RefGateInput): RefDecision {
  const { repo, update } = input;
  const head = { ref: update.ref, old: update.old, new: update.new, base: input.base };
  const refuse = (code: RefGateErrorCode, message: string): RefDecision => ({ ...head, decision: "refuse", status: null, checks: [], error: { code, message } });
  if (input.base === null) return { ...head, decision: "admit", status: null, checks: [] };
  const policy = policyAtBase(repo, { commit: input.base, from: "flag" });
  if (policy.problems.length > 0) return refuse("trust-policy-unreadable", `the policy at base ${input.base.slice(0, 8)} cannot be read, so the gate refuses every update: ${policy.problems.join("; ")}`);
  const rules = rulesFor(policy, update.ref);
  if (!rules.matched) return { ...head, decision: "admit", status: null, checks: [] };
  // A deletion carries no commit to judge; a forge or the remote protects deletions on its own.
  if (update.new === null) return { ...head, decision: "admit", status: rules.status, checks: [] };
  const commit = commitOf(repo, update.new);
  if (!commit) return refuse("revision-unknown", `${update.new} is not a commit this repository holds`);
  const tree = git(repo, ["rev-parse", `${commit}^{tree}`]).trim();
  const envelopes = evidenceFor(repo, commit, input.notes);

  const lifecycle = input.lifecycle === undefined ? commitOf(repo, LIFECYCLE_REF) : input.lifecycle;
  const ledgerText = lifecycle ? blobAt(repo, lifecycle, OVERRIDE_LEDGER) : undefined;
  const appliedText = lifecycle ? blobAt(repo, lifecycle, OVERRIDE_APPLIED) : undefined;
  const ledger = ledgerText ? parseGateLedger(ledgerText) : { resolutions: [], pending: [] };
  const applied = [...(appliedText ? parseAppliedOverrides(appliedText) : []), ...(input.spent ?? [])];
  const overriders = overridersAt(repo, input.base);
  const mode = rules.overrides ?? (policy.active ? "sealed" : "ledger");
  let signers: GateSigners | undefined;

  const checks: CheckVerdict[] = rules.checks.map((c) => {
    const subject = refGateSubject(commit, c.check);
    const judged = judgeCheck(repo, policy, envelopes, c.check, commit, tree);
    const base = { check: c.check, action: c.action, command: c.command, subject };
    if (judged.status === "current") return { ...base, status: "current", reason: `current evidence from ${judged.runner}`, runner: judged.runner };
    if (c.action === "block") {
      if (mode === "sealed" && !signers) signers = gateSignersAt(repo, input.base!);
      const verdict = decideOverride({
        ledger,
        applied,
        subject,
        planDigest: commit,
        rules: [c.check],
        overriders: overriders.principals,
        overridersPath: OVERRIDERS_PATH,
        mode,
        ...(signers ? { signers } : {}),
        ...(input.now ? { now: input.now } : {}),
      });
      if (verdict.status === "overridden") {
        const o = verdict.override;
        return { ...base, status: "overridden", code: judged.code, reason: `${judged.reason}; let through under ${o.by}'s override: ${o.reason}`, override: { subject, by: o.by, at: o.at, reason: o.reason, digest: o.digest } };
      }
      const why = verdict.refusals.length ? `; ${verdict.refusals.join("; ")}` : "";
      return { ...base, status: judged.status, code: judged.code, reason: `${judged.reason}${why}` };
    }
    return { ...base, status: judged.status, code: judged.code, reason: judged.reason };
  });
  const refused = checks.some((c) => c.action === "block" && (c.status === "missing" || c.status === "stale"));
  return { ...head, decision: refused ? "refuse" : "admit", status: rules.status, checks };
}

// ── the ledger ───────────────────────────────────────────────────────────

/** Where a decision is made: the remote's hook, the developer's hook, a forge status job or a plain check. */
export type RefGateSite = "pre-receive" | "pre-push" | "status" | "check";

/** A line of the gate's ledger. */
export interface RefGateLedgerLine extends RefDecision {
  version: 1;
  kind: "ref-update";
  site: RefGateSite;
  timestamp: string;
  /** Set on every line of a push the remote refused as a whole: an override it would have spent stays unspent. */
  push?: "refused";
}

/** The gate's ledger file in the git directory of `repo`, `<git dir>/chant/ref-gate.jsonl`. */
export function refGateLedgerPath(repo: string): string {
  const dir = git(repo, ["rev-parse", "--git-common-dir"]).trim();
  return join(isAbsolute(dir) ? dir : join(repo, dir), "chant", "ref-gate.jsonl");
}

export function appendRefGateLedger(path: string, lines: readonly RefGateLedgerLine[]): void {
  if (lines.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

export function readRefGateLedger(path: string): RefGateLedgerLine[] {
  if (!existsSync(path)) return [];
  const out: RefGateLedgerLine[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n").filter((l) => l.trim())) {
    try {
      const r = JSON.parse(line) as RefGateLedgerLine;
      if (r.version === 1 && r.kind === "ref-update") out.push(r);
    } catch {
      continue;
    }
  }
  return out;
}

/** The overrides the ledger's admitted updates spent: an update the remote took, or a status that passed, under an override. A pre-push or a plain check spends nothing. */
export function spentOverrides(lines: readonly RefGateLedgerLine[]): AppliedOverrideRecord[] {
  const out: AppliedOverrideRecord[] = [];
  for (const l of lines) {
    if (l.decision !== "admit" || l.push === "refused" || (l.site !== "pre-receive" && l.site !== "status")) continue;
    for (const c of l.checks) {
      if (!c.override) continue;
      out.push({ version: 1, kind: "applied", op: "policy-override", gate: c.override.subject, planDigest: c.override.digest, approvedAt: c.override.at, approvedBy: c.override.by, timestamp: l.timestamp, ...(l.new ? { commit: l.new } : {}) });
    }
  }
  return out;
}

// ── hook input ───────────────────────────────────────────────────────────

const OBJECT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const oid = (s: string): string | null => (ZERO.test(s) ? null : s);

/** pre-receive's stdin: `<old> <new> <ref>` per line. */
export function parsePreReceive(text: string): RefUpdate[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [old, nu, ref, ...rest] = line.split(/\s+/);
      if (rest.length || !old || !nu || !ref || !OBJECT_ID.test(old) || !OBJECT_ID.test(nu)) throw new RefUpdateInputError(`not a pre-receive line: ${JSON.stringify(line)}`);
      return { ref, old: oid(old), new: oid(nu) };
    });
}

/** pre-push's stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line, as updates of the remote ref. */
export function parsePrePush(text: string): RefUpdate[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [, local, ref, remote, ...rest] = line.split(/\s+/);
      if (rest.length || !local || !ref || !remote || !OBJECT_ID.test(local) || !OBJECT_ID.test(remote)) throw new RefUpdateInputError(`not a pre-push line: ${JSON.stringify(line)}`);
      return { ref, old: oid(remote), new: oid(local) };
    });
}

export class RefUpdateInputError extends Error {}

// ── the sites ────────────────────────────────────────────────────────────

export interface SiteResult {
  ok: boolean;
  decisions: RefDecision[];
  ledger: string;
}

/**
 * The remote's pre-receive hook: decide every update of the push, with the
 * notes and the `chant/lifecycle` tip the push itself brings when it brings
 * them, and write one ledger line per update. git refuses the whole push when
 * the hook fails, so overrides are spent only when every update is admitted.
 */
export function runPreReceive(repo: string, stdin: string, opts: { ledger?: string; now?: string } = {}): SiteResult {
  const updates = parsePreReceive(stdin);
  const pushed = (ref: string): string | null | undefined => {
    const u = updates.find((x) => x.ref === ref);
    return u ? (u.new ? commitOf(repo, u.new) ?? null : null) : undefined;
  };
  const notes = pushed(EVIDENCE_NOTES_REF);
  const lifecycle = pushed(LIFECYCLE_REF);
  const ledger = opts.ledger ?? refGateLedgerPath(repo);
  const spent = spentOverrides(readRefGateLedger(ledger));
  const now = opts.now ?? new Date().toISOString();
  const decisions: RefDecision[] = [];
  for (const u of updates) {
    const base = u.old ? commitOf(repo, u.old) ?? null : commitOf(repo, "HEAD") ?? null;
    const d = decideRefUpdate({ repo, update: u, base, ...(notes !== undefined ? { notes } : {}), ...(lifecycle !== undefined ? { lifecycle } : {}), spent, now });
    decisions.push(d);
    // Two refs of one push may not spend one override twice.
    spent.push(...spentOverrides([{ ...d, version: 1, kind: "ref-update", site: "pre-receive", timestamp: now }]));
  }
  const ok = decisions.every((d) => d.decision === "admit");
  appendRefGateLedger(ledger, decisions.map((d) => ({ ...d, version: 1, kind: "ref-update", site: "pre-receive", timestamp: now, ...(ok ? {} : { push: "refused" as const }) })));
  return { ok, decisions, ledger };
}

/**
 * The developer's pre-push hook: the same decision against the local
 * repository, before the network. The policy is read at the remote's tip
 * when the repository holds it, else at the default base. It spends nothing.
 */
export function runPrePush(repo: string, stdin: string, opts: { ledger?: string; now?: string; base?: (repo: string) => string | null } = {}): SiteResult {
  const updates = parsePrePush(stdin);
  const ledger = opts.ledger ?? refGateLedgerPath(repo);
  const now = opts.now ?? new Date().toISOString();
  const decisions = updates.map((u) => {
    const base = (u.old ? commitOf(repo, u.old) : undefined) ?? opts.base?.(repo) ?? null;
    return decideRefUpdate({ repo, update: u, base, now });
  });
  appendRefGateLedger(ledger, decisions.map((d) => ({ ...d, version: 1, kind: "ref-update", site: "pre-push", timestamp: now })));
  return { ok: decisions.every((d) => d.decision === "admit"), decisions, ledger };
}

// ── words ────────────────────────────────────────────────────────────────

const short = (s: string | null): string => (s ? s.slice(0, 8) : "(none)");

/**
 * The command that records the request for an override of `d`'s blocked
 * checks from a checkout (#4913): `check` for the same ref, commit and base
 * the remote decided, so it reaches the same decision and records the
 * request on `chant/lifecycle`, which a pre-receive hook can't move.
 */
export function requestCommand(d: Pick<RefDecision, "ref" | "new" | "base">): string {
  return `chant workspace ref-gate check --ref ${d.ref} --at ${d.new ?? "HEAD"}${d.base ? ` --base ${d.base}` : ""}`;
}

/**
 * What the gate says about one decision: each missing check and its command,
 * and how to override a blocked one. At `pre-receive` (#4913) the request
 * can't be recorded where the decision is made, so the refusal prints the
 * exact command that records it from the checkout, then the override and
 * the push that spends it.
 */
export function describeDecision(d: RefDecision, opts: { site?: RefGateSite } = {}): string[] {
  const out: string[] = [];
  const verb = d.decision === "admit" ? "admitted" : "refused";
  out.push(`chant ref gate: ${verb} ${d.ref} ${short(d.old)}..${short(d.new)}`);
  if (d.error) {
    out.push(`  ${d.error.message} (${d.error.code})`);
    return out;
  }
  for (const c of d.checks) {
    if (c.status === "current") {
      out.push(`  ${c.check}: ${c.reason}`);
      continue;
    }
    const what = c.status === "overridden" ? "overridden" : c.action === "warn" ? "warning" : "missing";
    out.push(`  ${c.check} (${what}): ${c.reason}${c.code ? ` (${c.code})` : ""}`);
    if (c.status !== "overridden") out.push(`    run: ${c.command}`);
  }
  const blocked = d.checks.filter((c) => c.action === "block" && (c.status === "missing" || c.status === "stale"));
  if (blocked.length > 0) {
    out.push(`  Attach each check's evidence to ${short(d.new)} (chant workspace ref-gate attach --envelope <file> --at ${short(d.new)}) and push ${EVIDENCE_NOTES_REF} with the ref.`);
    if (opts.site === "pre-receive") {
      out.push(`  To let ${short(d.new)} through without a check, record the request for an override in your checkout (this remote can't):`);
      out.push(`    ${requestCommand(d)}`);
      out.push(`  then a person listed in ${OVERRIDERS_PATH} at base overrides each check:`);
      for (const c of blocked) out.push(`    ${overrideCommand(c.subject, [c.check])}`);
      out.push(`  and the push goes again with chant/lifecycle: git push origin chant/lifecycle ${d.new ?? "HEAD"}:${d.ref}`);
    } else {
      out.push(`  To let ${short(d.new)} through without a check, a person listed in ${OVERRIDERS_PATH} at base can override it once the request is recorded`);
      out.push(`  (the pre-push hook records it, or ${requestCommand(d)}):`);
      for (const c of blocked) out.push(`    ${overrideCommand(c.subject, [c.check])}`);
    }
  }
  return out;
}
