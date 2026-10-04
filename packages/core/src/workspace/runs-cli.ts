/**
 * `chant workspace runs` (#3033, ws-076): read and write the agent run
 * record.
 *
 * - `runs [--unit <id>] [--decision <id>] [--by <principal>] [--since <rev>]
 *   --json` reads every run in the ledger with the commits it made, and
 *   totals tokens and cost per work item, per decision and per principal,
 *   naming the runs that report no cost instead of counting them as zero
 *   (`runs.schema.json`, a read-contract output).
 * - `runs start --from <file|->`, `runs end <id> --from <file|->` and `runs
 *   record --from <file|->` append a run's start, its end, or both, to
 *   `_agent-runs/<id>.jsonl` on `chant/lifecycle` (`runs-write.schema.json`).
 * - `runs sign <id> --key <runner key.pem> | --envelope <file|->` appends a
 *   statement over an ended run, signed by a runner or steward key the trust
 *   policy at base lists, or signed elsewhere and checked here (#3192).
 *   `runs statement <id> --signer <principal>` prints the statement for a
 *   signer that holds its key elsewhere, and `runs verify [<id>] [--require
 *   signed]` judges every stored statement (`run-statement.schema.json`).
 *
 * chant records runs and never starts one: whatever ran the agent writes the
 * record. Reads never fetch, except a pull request ref `--follow-squash`
 * needs (#3035).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { declaredRecordKinds, readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError } from "./declaration";
import { declaredKindFile } from "./declared-kinds";
import type { ReasonCode } from "./reason-codes";
import { loadRecordKind, RecordReadError } from "./records";
import { queryRecords } from "./records-cli";
import {
  appendRunStatement,
  commitsByRunTrailer,
  endRun,
  foldRun,
  joinPatchIdCommits,
  joinSquashCommits,
  joinTrailerCommits,
  LEDGER_BRANCH,
  readRuns,
  recordRun,
  RunWriteError,
  startRun,
  type RunLedgerWrite,
  type RunView,
  type RunWriteContext,
} from "./runs";
import { RUN_TRAILER } from "./trailers";
import { locateWorkspace } from "./which-chant";
import { idList } from "./work";
import { AGENT_ENV } from "./write-scope";
import { execFileSync } from "node:child_process";
import { IN_TOTO_PAYLOAD_TYPE, loadRunnerKey, type DsseEnvelope } from "./trust/dsse";
import { policyAtBase, resolveBase, type BaseSource } from "./trust/provenance";
import type { TrustPolicy } from "./trust/policy";
import { attestRun, buildRunStatement, runStatementPayload, signRunStatement, verifyRunStatement, type RunAttestation, type RunStatement } from "./trust/run-statement";

/** The version of the `runs` documents this chant writes: read contract 1. */
export const RUNS_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for `runs --json`, shipped beside this file. */
export const RUNS_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/runs/v1/runs.schema.json";

/** `$id` of the JSON Schema for what `runs start|end|record|sign` print. */
export const RUNS_WRITE_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/runs-write/v1/runs-write.schema.json";

/** `$id` of the JSON Schema for what `runs statement` and `runs verify` print (#3192). */
export const RUN_STATEMENT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/run-statement/v1/run-statement.schema.json";

const USAGE = [
  "chant workspace runs [--unit <id>] [--decision <id>] [--by <principal>] [--since <rev>] [--follow-squash] [--json]",
  "chant workspace runs start --from <file|->",
  "chant workspace runs end <run id> [--from <file|->]",
  "chant workspace runs record --from <file|->",
  "chant workspace runs sign <run id> (--key <runner key.pem> | --envelope <file|->) [--base <rev>]",
  "chant workspace runs statement <run id> --signer <principal>",
  "chant workspace runs verify [<run id>] [--require signed] [--base <rev>] [--json]",
].join("\n");

/** Why `runs` read nothing. Closed. */
export const RUNS_ERROR_CODES = [...WORKSPACE_ERROR_CODES] as const satisfies readonly ReasonCode[];
export type RunsErrorCode = (typeof RUNS_ERROR_CODES)[number];

/** Why part of the read is missing. The read still succeeds. Closed. */
export const RUNS_REASON_CODES = ["runs-no-ledger", "runs-ledger-malformed", "kind-unreadable", "squash-unfollowed"] as const satisfies readonly ReasonCode[];
export type RunsReasonCode = (typeof RUNS_REASON_CODES)[number];

/** Why a run write was refused or could not run. Closed. */
export const RUNS_WRITE_ERROR_CODES = [
  ...WORKSPACE_ERROR_CODES,
  "write-usage-invalid",
  "write-input-invalid",
  "run-exists",
  "run-unknown",
  "run-ended",
  // runs sign (#3192)
  "run-not-ended",
  "trust-policy-unreadable",
  "runner-key-invalid",
  "runner-key-is-signer",
  "runner-key-unlisted",
  "envelope-unreadable",
  "envelope-invalid",
  "envelope-untrusted",
  "run-statement-invalid",
  "run-statement-signer-mismatch",
  "run-statement-mismatch",
] as const satisfies readonly ReasonCode[];
export type RunsWriteErrorCode = (typeof RUNS_WRITE_ERROR_CODES)[number];

/** Why `runs statement` or `runs verify` printed nothing to judge. Closed. */
export const RUN_STATEMENT_ERROR_CODES = [...WORKSPACE_ERROR_CODES, "write-usage-invalid", "run-unknown", "run-not-ended"] as const satisfies readonly ReasonCode[];
export type RunStatementErrorCode = (typeof RUN_STATEMENT_ERROR_CODES)[number];

// ── Totals ───────────────────────────────────────────────────────────────────

/** Tokens and cost summed over some runs. */
export interface RunTotals {
  runs: number;
  /** Runs with no end recorded yet. */
  running: number;
  /** Summed over the runs that report usage; a count a run leaves out adds nothing. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** One sum per currency, since amounts in two currencies don't add. */
  cost: { currency: string; amount: number }[];
  /** The runs that report no cost, running ones included: left out of `cost`, never counted as zero. */
  unpriced: string[];
  /** The runs that report no usage: left out of `tokens`. */
  unreported: string[];
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function totalRuns(runs: RunView[]): RunTotals {
  const t: RunTotals = { runs: runs.length, running: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: [], unpriced: [], unreported: [] };
  for (const r of runs) {
    if (r.state === "running") t.running++;
    if (r.usage) {
      t.tokens.input += r.usage.inputTokens ?? 0;
      t.tokens.output += r.usage.outputTokens ?? 0;
      t.tokens.cacheRead += r.usage.cacheReadTokens ?? 0;
      t.tokens.cacheWrite += r.usage.cacheWriteTokens ?? 0;
    } else t.unreported.push(r.id);
    if (r.cost) {
      const sum = t.cost.find((c) => c.currency === r.cost!.currency);
      if (sum) sum.amount = round(sum.amount + r.cost.amount);
      else t.cost.push({ currency: r.cost.currency, amount: round(r.cost.amount) });
    } else t.unpriced.push(r.id);
  }
  t.cost.sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
  return t;
}

/** Group runs by a key each run gives zero or more of, in first-seen order. */
function groupBy<K extends string | null>(runs: RunView[], keys: (r: RunView) => K[]): Map<K, RunView[]> {
  const out = new Map<K, RunView[]>();
  for (const r of runs) for (const k of keys(r)) (out.get(k) ?? out.set(k, []).get(k)!).push(r);
  return out;
}

// ── The read ─────────────────────────────────────────────────────────────────

export interface RunsQuery {
  cwd: string;
  /** Only the runs on this work item. */
  unit?: string;
  /** Only the runs that carried out this decision: its id, or `<kind>/<id>`. */
  decision?: string;
  /** Only the runs made for this principal. */
  by?: string;
  /** Only the runs that made a commit after `since` on HEAD, or started after its commit date. */
  since?: string;
  /** The revision whose trust policy judges the run statements (#3192). Default: origin/HEAD, then main, then master. */
  base?: string;
  /** Follow squash merges on HEAD to their pull requests' original commits, fetching missing pull request refs (#3035). */
  followSquash?: boolean;
}

export interface RunsReason {
  code: RunsReasonCode;
  message: string;
}

/** The trust policy at base, as far as run statements need it (#3192). */
export interface RunsTrust {
  base: string | null;
  baseFrom: BaseSource | null;
  /** The runner and steward keys at base, by principal and class. */
  runners: { principal: string; class: "runner" | "service" }[];
  /** Why the policy at base can't be read. Nothing verifies then. */
  problems: string[];
}

/** The policy at base for run statements, and its summary. */
export function runsTrust(top: string, base?: string): { policy: TrustPolicy; trust: RunsTrust } {
  const resolved = resolveBase(top, base);
  const policy = policyAtBase(top, resolved);
  return {
    policy,
    trust: { base: resolved.commit, baseFrom: resolved.from, runners: policy.runners.map((r) => ({ principal: r.principal, class: r.class })), problems: policy.problems },
  };
}

/** Judge each run's statements in place against the runners at base. */
export function attestRuns(runs: Iterable<RunView>, policy: TrustPolicy): void {
  for (const r of runs) r.attestation = attestRun(r, policy.problems.length > 0 ? [] : policy.runners);
}

/** What `runs --json` prints. */
export type RunsDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      workspace: { name: string; root: string };
      ledger: { branch: string; dir: string; commit: string | null };
      /** The options given. `followSquash` was added within contract 1 (#3035). */
      filter: { unit: string | null; decision: string | null; by: string | null; since: string | null; followSquash?: boolean };
      /** The trust policy the run statements are judged by (#3192). */
      trust: RunsTrust;
      /** Newest first, by when each started. Each carries its `attestation`. */
      runs: RunView[];
      totals: {
        all: RunTotals;
        byUnit: (RunTotals & { unit: string | null })[];
        byDecision: (RunTotals & { decision: string })[];
        byPrincipal: (RunTotals & { principal: string | null })[];
      };
      malformed: number;
      reasons: RunsReason[];
    }
  | { $schema: string; contract: number; chant: string; error: { code: RunsErrorCode; message: string } };

/**
 * The decisions each run carried out, as `<kind>/<id>`: the ones its work
 * item implements, read through the declared work kinds, and the records it
 * names of a kind a work kind calls its decision kind. Fills `decisions` in
 * place.
 */
export async function resolveRunDecisions(runs: RunView[], rootOnDisk: string, declared: string[], reasons: RunsReason[]): Promise<void> {
  const implementsOf = new Map<string, Set<string>>();
  const decisionKinds = new Set<string>();
  for (const file of declared) {
    try {
      const loaded = await loadRecordKind(file, rootOnDisk);
      const work = loaded.kind.work;
      if (!work) continue;
      const decisionKind = (await loadRecordKind(resolve(dirname(loaded.file), work.decisions), rootOnDisk)).kind.name;
      decisionKinds.add(decisionKind);
      const doc = await queryRecords({ kind: loaded.file, cwd: rootOnDisk, workGaps: false });
      if ("error" in doc) throw new RecordReadError(doc.error.code as never, doc.error.message);
      for (const v of doc.records) {
        if (v.id === null) continue;
        const set = implementsOf.get(v.id) ?? implementsOf.set(v.id, new Set()).get(v.id)!;
        for (const d of idList(v.data, work.implements)) set.add(`${decisionKind}/${d}`);
      }
    } catch (err) {
      if (!(err instanceof RecordReadError)) throw err;
      reasons.push({ code: "kind-unreadable", message: `${file}: ${err.message}; the decisions its work items implement are left out` });
    }
  }
  if (decisionKinds.size === 0) decisionKinds.add("decision");
  for (const r of runs) {
    const out = new Set<string>(r.unit ? (implementsOf.get(r.unit.id) ?? []) : []);
    for (const ref of r.records) if (decisionKinds.has(ref.kind)) out.add(`${ref.kind}/${ref.id}`);
    r.decisions = [...out].sort();
  }
}

function tryGit(top: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** Read the run ledger and build the document. Never throws a {@link WorkspaceReadError}. */
export async function workspaceRuns(query: RunsQuery): Promise<RunsDocument> {
  const head = { $schema: RUNS_OUTPUT_SCHEMA_ID, contract: RUNS_CONTRACT_VERSION, chant: readerVersion() };
  try {
    const located = locateWorkspace(query.cwd);
    const declaration = readDeclaration(located.tree, "", { rootChant: true });
    const top = located.top;
    if (!top) throw new WorkspaceReadError("not-a-git-repository", "agent runs are kept on the chant/lifecycle branch, and this directory is not in a git repository");
    const reasons: RunsReason[] = [];
    const { tip, dir, runs, malformed } = await readRuns(top, located.rootOnDisk);
    if (!tip) reasons.push({ code: "runs-no-ledger", message: `this checkout has no ${LEDGER_BRANCH} branch, so there are no agent runs to read; fetch it first if the remote has one` });
    if (malformed > 0) reasons.push({ code: "runs-ledger-malformed", message: `${malformed} ${malformed === 1 ? "line" : "lines"} of ${dir} on ${LEDGER_BRANCH} ${malformed === 1 ? "is" : "are"} not a run event and ${malformed === 1 ? "was" : "were"} left out` });
    const byTrailer = commitsByRunTrailer(top);
    joinTrailerCommits(runs, byTrailer, top);
    // A commit that lost its trailer joins by content (#3036).
    joinPatchIdCommits(runs, byTrailer, top);
    // A squash merge joins the runs its pull request's commits join, when asked (#3035).
    if (query.followSquash) {
      for (const f of joinSquashCommits(runs, top)) {
        if (f.problem) reasons.push({ code: "squash-unfollowed", message: `${f.sha.slice(0, 8)} squashes pull request #${f.pullRequest}, and ${f.problem}, so the runs of its original commits are not joined to it` });
      }
    }
    const { policy, trust } = runsTrust(top, query.base);
    attestRuns(runs.values(), policy);
    const all = [...runs.values()];
    await resolveRunDecisions(all, located.rootOnDisk, declaredRecordKinds(declaration).map((d) => declaredKindFile(d, located.rootOnDisk)), reasons);

    let since: { commits: Set<string>; date: number } | undefined;
    if (query.since !== undefined) {
      const sha = tryGit(top, ["rev-parse", "--verify", "--quiet", `${query.since}^{commit}`])?.trim();
      if (!sha) throw new WorkspaceReadError("revision-unknown", `--since ${query.since} names no commit in this repository`);
      const commits = new Set((tryGit(top, ["rev-list", `${sha}..HEAD`]) ?? "").split("\n").map((s) => s.trim()).filter(Boolean));
      since = { commits, date: Number(tryGit(top, ["show", "-s", "--format=%ct", sha])?.trim() ?? "0") * 1000 };
    }
    const wantDecision = query.decision;
    const selected = all
      .filter((r) => query.unit === undefined || r.unit?.id === query.unit)
      .filter((r) => wantDecision === undefined || r.decisions.some((d) => d === wantDecision || d.slice(d.indexOf("/") + 1) === wantDecision))
      .filter((r) => query.by === undefined || r.by === query.by)
      .filter((r) => !since || r.commits.some((c) => since!.commits.has(c.sha)) || Date.parse(r.startedAt) > since.date)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.id < b.id ? 1 : -1));

    const byUnit = [...groupBy(selected, (r) => [r.unit?.id ?? null])].map(([unit, rs]) => ({ unit, ...totalRuns(rs) }));
    const byDecision = [...groupBy(selected, (r) => r.decisions)].map(([decision, rs]) => ({ decision: decision as string, ...totalRuns(rs) }));
    const byPrincipal = [...groupBy(selected, (r) => [r.by])].map(([principal, rs]) => ({ principal, ...totalRuns(rs) }));
    return {
      ...head,
      workspace: { name: declaration.name, root: located.root },
      ledger: { branch: LEDGER_BRANCH, dir, commit: tip },
      filter: { unit: query.unit ?? null, decision: query.decision ?? null, by: query.by ?? null, since: query.since ?? null, followSquash: query.followSquash === true },
      trust,
      runs: selected,
      totals: { all: totalRuns(selected), byUnit, byDecision, byPrincipal },
      malformed,
      reasons,
    };
  } catch (err) {
    if (err instanceof WorkspaceReadError) return { ...head, error: { code: err.code as RunsErrorCode, message: err.describe() } };
    throw err;
  }
}

// ── The writes ───────────────────────────────────────────────────────────────

export type RunsVerb = "start" | "end" | "record" | "sign";

/** What `runs start|end|record` print. */
export type RunsWriteDocument =
  | {
      $schema: string;
      contract: number;
      verb: RunsVerb;
      /** The run as the ledger now holds it. */
      run: RunView;
      /** The line a commit the run makes carries, `Chant-Run: <id>` (#3149). */
      trailer: string;
      ledger: RunLedgerWrite;
      /** For `sign`: who signed the statement it stored, and the envelope (#3192). */
      statement?: { signer: string; class: "runner" | "service"; keyid: string; envelope: DsseEnvelope };
    }
  | { $schema: string; contract: number; verb: RunsVerb | null; error: { code: RunsWriteErrorCode; message: string } };

export interface RunsWriteRequest {
  verb: RunsVerb;
  /** The run id, for `end`. */
  id?: string;
  /** The JSON fields, as text. */
  fields: string;
  cwd: string;
  /** The agent session in `CHANT_AGENT`, the default for `agent`. */
  agent?: string;
  now?: () => Date;
}

/** Run one write and build the document it prints. */
export async function runsWrite(req: RunsWriteRequest): Promise<RunsWriteDocument> {
  const head = { $schema: RUNS_WRITE_SCHEMA_ID, contract: RUNS_CONTRACT_VERSION };
  const fail = (code: RunsWriteErrorCode, message: string): RunsWriteDocument => ({ ...head, verb: req.verb, error: { code, message } });
  let fields: unknown;
  try {
    fields = req.fields.trim() === "" ? {} : JSON.parse(req.fields);
  } catch (err) {
    return fail("write-input-invalid", `the fields are not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return fail("write-input-invalid", "the fields are a JSON object");
  if (req.verb !== "end" && req.agent && (fields as Record<string, unknown>).agent === undefined) fields = { ...(fields as object), agent: req.agent };
  try {
    const located = locateWorkspace(req.cwd);
    const declaration = readDeclaration(located.tree, "", { rootChant: true });
    if (!located.top) return fail("not-a-git-repository", "agent runs are kept on the chant/lifecycle branch, and this directory is not in a git repository");
    const ctx: RunWriteContext = { top: located.top, rootOnDisk: located.rootOnDisk, cwd: req.cwd, now: req.now };
    const result = req.verb === "start" ? await startRun(fields, ctx) : req.verb === "end" ? await endRun(req.id ?? "", fields, ctx) : await recordRun(fields, ctx);
    const run = foldRun(result.id, result.ledger.path, result.lines)!;
    await resolveRunDecisions([run], located.rootOnDisk, declaredRecordKinds(declaration).map((d) => declaredKindFile(d, located.rootOnDisk)), []);
    return { ...head, verb: req.verb, run, trailer: `${RUN_TRAILER}: ${run.id}`, ledger: result.ledger };
  } catch (err) {
    if (err instanceof RunWriteError) return fail(err.code, err.message);
    if (err instanceof WorkspaceReadError) return fail(err.code as RunsWriteErrorCode, err.describe());
    throw err;
  }
}

// ── Run statements (#3192) ──────────────────────────────────────────────────

/** A run as the ledger holds it now, with the commits its trailer joins. */
async function currentRun(top: string, rootOnDisk: string, id: string): Promise<RunView | undefined> {
  const { runs } = await readRuns(top, rootOnDisk);
  joinTrailerCommits(runs, commitsByRunTrailer(top), top);
  return runs.get(id);
}

export interface RunsSignRequest {
  id: string;
  cwd: string;
  /** A runner key in PEM: chant builds the statement and signs it. */
  keyPem?: string;
  /** An envelope signed elsewhere, as text: chant checks it and stores it. */
  envelope?: string;
  base?: string;
  now?: () => Date;
}

/**
 * `runs sign <id>`: store a statement over an ended run, signed here with
 * `keyPem` or signed elsewhere and given as `envelope`. Either way it must
 * verify against a runner key at base and agree with the run's record before
 * anything is written.
 */
export async function runsSign(req: RunsSignRequest): Promise<RunsWriteDocument> {
  const head = { $schema: RUNS_WRITE_SCHEMA_ID, contract: RUNS_CONTRACT_VERSION };
  const fail = (code: RunsWriteErrorCode, message: string): RunsWriteDocument => ({ ...head, verb: "sign", error: { code, message } });
  try {
    const located = locateWorkspace(req.cwd);
    const declaration = readDeclaration(located.tree, "", { rootChant: true });
    const top = located.top;
    if (!top) return fail("not-a-git-repository", "agent runs are kept on the chant/lifecycle branch, and this directory is not in a git repository");
    const run = await currentRun(top, located.rootOnDisk, req.id);
    if (!run) return fail("run-unknown", `the ledger has no agent run ${req.id}`);
    if (!run.record) return fail("run-not-ended", `agent run ${req.id} has not ended; a statement is signed over a run's whole record, so record its end first`);
    const { policy } = runsTrust(top, req.base);
    if (policy.problems.length > 0) return fail("trust-policy-unreadable", `the policy at base cannot be read: ${policy.problems.join("; ")}`);

    let envelope: DsseEnvelope;
    if (req.keyPem !== undefined) {
      let runner;
      try {
        runner = loadRunnerKey(req.keyPem);
      } catch (err) {
        return fail("runner-key-invalid", `the key is not an Ed25519 private key in PEM: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (policy.signers.some((s) => s.key === runner.publicKey)) {
        return fail("runner-key-is-signer", `this is a signer's key in ${policy.signersPath}. A run statement is signed by a runner or steward identity, never by a person's key`);
      }
      const listed = policy.runners.find((r) => r.key === runner.publicKey);
      if (!listed) return fail("runner-key-unlisted", `the policy at base lists no runner with this key. Add it to .chant/trust.json "runners" first:\n  ${runner.publicKey}`);
      envelope = signRunStatement(buildRunStatement(run, listed.principal), runner.key, runner.publicKey);
    } else {
      try {
        envelope = JSON.parse(req.envelope ?? "") as DsseEnvelope;
      } catch (err) {
        return fail("envelope-unreadable", `--envelope could not be read as JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const verdict = verifyRunStatement(envelope, policy.runners, run);
    if (verdict.status !== "verified") return fail(verdict.code, verdict.reason);

    const ctx: RunWriteContext = { top, rootOnDisk: located.rootOnDisk, cwd: req.cwd, now: req.now };
    const result = await appendRunStatement(run.id, envelope, run.record.sha256, ctx);
    const view = foldRun(result.id, result.ledger.path, result.lines)!;
    const joined = new Map([[view.id, view]]);
    joinTrailerCommits(joined, commitsByRunTrailer(top), top);
    await resolveRunDecisions([view], located.rootOnDisk, declaredRecordKinds(declaration).map((d) => declaredKindFile(d, located.rootOnDisk)), []);
    attestRuns([view], policy);
    return {
      ...head,
      verb: "sign",
      run: view,
      trailer: `${RUN_TRAILER}: ${view.id}`,
      ledger: result.ledger,
      statement: { signer: verdict.signer, class: verdict.class, keyid: verdict.keyid, envelope },
    };
  } catch (err) {
    if (err instanceof RunWriteError) return fail(err.code, err.message);
    if (err instanceof WorkspaceReadError) return fail(err.code as RunsWriteErrorCode, err.describe());
    throw err;
  }
}

/** What `runs statement` and `runs verify` print. */
export type RunStatementDocument =
  | {
      $schema: string;
      contract: number;
      chant: string;
      verb: "statement";
      run: string;
      /** The DSSE payload type to sign under. */
      payloadType: string;
      /** Base64 of the payload bytes to sign: the statement's canonical JSON. */
      payload: string;
      statement: RunStatement;
    }
  | {
      $schema: string;
      contract: number;
      chant: string;
      verb: "verify";
      trust: RunsTrust;
      require: "signed" | null;
      runs: { id: string; state: "running" | "ended"; record: { sha256: string } | null; attestation: RunAttestation }[];
      summary: { runs: number; signed: number; unsigned: number; failed: number; running: number };
      /** Why `--require signed` fails. Empty without it: the report alone never fails (studio-035 d). */
      failures: string[];
      ok: boolean;
    }
  | { $schema: string; contract: number; chant: string; verb: "statement" | "verify" | null; error: { code: RunStatementErrorCode; message: string } };

function statementHead() {
  return { $schema: RUN_STATEMENT_SCHEMA_ID, contract: RUNS_CONTRACT_VERSION, chant: readerVersion() };
}

/** `runs statement <id> --signer <principal>`: the statement a signer holding its key elsewhere signs. */
export async function runStatement(id: string, signer: string, cwd: string): Promise<RunStatementDocument> {
  const fail = (code: RunStatementErrorCode, message: string): RunStatementDocument => ({ ...statementHead(), verb: "statement", error: { code, message } });
  try {
    const located = locateWorkspace(cwd);
    readDeclaration(located.tree, "", { rootChant: true });
    if (!located.top) return fail("not-a-git-repository", "agent runs are kept on the chant/lifecycle branch, and this directory is not in a git repository");
    const run = await currentRun(located.top, located.rootOnDisk, id);
    if (!run) return fail("run-unknown", `the ledger has no agent run ${id}`);
    if (!run.record) return fail("run-not-ended", `agent run ${id} has not ended; a statement is signed over a run's whole record`);
    const statement = buildRunStatement(run, signer);
    return { ...statementHead(), verb: "statement", run: id, payloadType: IN_TOTO_PAYLOAD_TYPE, payload: runStatementPayload(statement).toString("base64"), statement };
  } catch (err) {
    if (err instanceof WorkspaceReadError) return fail(err.code as RunStatementErrorCode, err.describe());
    throw err;
  }
}

/**
 * `runs verify [<id>] [--require signed]`: judge each run's statements
 * against the runner keys at base. Report only unless `--require signed`
 * asks every ended run, or the one named, to be signed.
 */
export async function runsVerify(query: { cwd: string; id?: string; require?: "signed"; base?: string }): Promise<RunStatementDocument> {
  const fail = (code: RunStatementErrorCode, message: string): RunStatementDocument => ({ ...statementHead(), verb: "verify", error: { code, message } });
  try {
    const located = locateWorkspace(query.cwd);
    readDeclaration(located.tree, "", { rootChant: true });
    const top = located.top;
    if (!top) return fail("not-a-git-repository", "agent runs are kept on the chant/lifecycle branch, and this directory is not in a git repository");
    const { runs } = await readRuns(top, located.rootOnDisk);
    joinTrailerCommits(runs, commitsByRunTrailer(top), top);
    if (query.id !== undefined && !runs.has(query.id)) return fail("run-unknown", `the ledger has no agent run ${query.id}`);
    const { policy, trust } = runsTrust(top, query.base);
    const selected = [...runs.values()]
      .filter((r) => query.id === undefined || r.id === query.id)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.id < b.id ? 1 : -1));
    attestRuns(selected, policy);
    const out = selected.map((r) => ({ id: r.id, state: r.state, record: r.record, attestation: r.attestation! }));
    const failures: string[] = [];
    if (query.require === "signed") {
      for (const r of out) {
        if (r.state === "running" || r.attestation.status === "signed") continue;
        failures.push(`${r.id} is ${r.attestation.status}, and --require signed was given: ${r.attestation.reason}`);
      }
    }
    const count = (f: (r: (typeof out)[number]) => boolean) => out.filter(f).length;
    return {
      ...statementHead(),
      verb: "verify",
      trust,
      require: query.require ?? null,
      runs: out,
      summary: {
        runs: out.length,
        signed: count((r) => r.attestation.status === "signed"),
        unsigned: count((r) => r.attestation.status === "unsigned"),
        failed: count((r) => r.attestation.status !== "signed" && r.attestation.status !== "unsigned"),
        running: count((r) => r.state === "running"),
      },
      failures,
      ok: failures.length === 0,
    };
  } catch (err) {
    if (err instanceof WorkspaceReadError) return fail(err.code as RunStatementErrorCode, err.describe());
    throw err;
  }
}

// ── Text ─────────────────────────────────────────────────────────────────────

function money(t: RunTotals): string {
  const priced = t.cost.map((c) => `${c.amount} ${c.currency}`).join(" + ") || "no cost reported";
  return `${priced}${t.unpriced.length > 0 ? `, ${t.unpriced.length} unpriced` : ""}`;
}

/** The read as lines for a person. */
export function formatRuns(doc: Extract<RunsDocument, { runs: unknown }>): string {
  const out: string[] = [];
  for (const r of doc.runs) {
    const model = [r.harness.name, r.model].filter(Boolean).join("/");
    const tokens = r.usage ? `${r.usage.inputTokens ?? "?"} in, ${r.usage.outputTokens ?? "?"} out` : "no usage";
    const cost = r.cost ? `${r.cost.amount} ${r.cost.currency} (${r.cost.source})` : "unpriced";
    const signed = r.attestation ? (r.attestation.status === "signed" ? `  signed by ${r.attestation.signer}` : r.attestation.status === "unsigned" ? "" : `  statement ${r.attestation.status}`) : "";
    out.push(`${r.id}  ${r.state}${r.outcome ? ` ${r.outcome}` : ""}  ${r.startedAt}  ${model}${r.by ? ` for ${r.by}` : ""}${r.unit ? `  on ${r.unit.id}` : ""}  ${tokens}  ${cost}  ${r.commits.length} commit${r.commits.length === 1 ? "" : "s"}${signed}`);
  }
  if (doc.runs.length === 0) out.push("no agent runs");
  const t = doc.totals.all;
  out.push(`${t.runs} run${t.runs === 1 ? "" : "s"} (${t.running} running): ${t.tokens.input} tokens in, ${t.tokens.output} out; ${money(t)}`);
  for (const r of doc.reasons) out.push(`reason  ${r.code}: ${r.message}`);
  return out.join("\n");
}

// ── The command ──────────────────────────────────────────────────────────────

function readFields(value: string | undefined, cwd: string): string {
  if (value === undefined) return "";
  return readFileSync(value === "-" ? 0 : resolve(cwd, value), "utf-8");
}

export async function runWorkspaceRuns(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const cwd = process.cwd();
  const verb = args.extraPositional;
  if (verb === "sign" || verb === "statement" || verb === "verify") return runStatementVerb(ctx, verb, cwd);
  if (verb === "start" || verb === "end" || verb === "record") {
    const print = (doc: RunsWriteDocument): number => {
      console.log(JSON.stringify(doc, null, 2));
      return "error" in doc ? 1 : 0;
    };
    const usage = (message: string) => print({ $schema: RUNS_WRITE_SCHEMA_ID, contract: RUNS_CONTRACT_VERSION, verb, error: { code: "write-usage-invalid", message } });
    for (const [flag, v] of [["--unit", args.unit], ["--decision", args.decision], ["--by", args.by], ["--since", args.since], ["--follow-squash", args.followSquash]] as const) {
      if (v !== undefined) return usage(`runs ${verb} takes its fields with --from, not ${flag}`);
    }
    if (verb === "end" && !args.extraPositional2) return usage("runs end needs the run id: runs end <run id>");
    if (verb !== "end" && args.extraPositional2) return usage(`runs ${verb} takes no run id; put an id in the fields to choose one`);
    if (verb !== "end" && args.migrateFrom === undefined) return usage(`runs ${verb} needs --from <file|->: the run's fields as JSON`);
    let fields: string;
    try {
      fields = readFields(args.migrateFrom, cwd);
    } catch (err) {
      return print({ $schema: RUNS_WRITE_SCHEMA_ID, contract: RUNS_CONTRACT_VERSION, verb, error: { code: "write-input-invalid", message: `--from ${args.migrateFrom} could not be read: ${err instanceof Error ? err.message : String(err)}` } });
    }
    return print(await runsWrite({ verb, id: args.extraPositional2, fields, cwd, agent: process.env[AGENT_ENV] || undefined }));
  }
  if (verb !== undefined) {
    console.error(formatError({ message: `chant workspace runs takes start, end, record, sign, statement or verify, or no verb to read, not ${verb}`, hint: USAGE }));
    return 1;
  }
  if (args.migrateFrom !== undefined) {
    console.error(formatError({ message: "runs is a read and takes no --from; write with runs start, end or record", hint: USAGE }));
    return 1;
  }
  const doc = await workspaceRuns({ cwd, unit: args.unit, decision: args.decision, by: args.by, since: args.since, base: args.base, followSquash: args.followSquash });
  if (args.json) console.log(JSON.stringify(doc, null, 2));
  else if ("error" in doc) console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
  else console.log(formatRuns(doc));
  return "error" in doc ? 1 : 0;
}

async function runStatementVerb(ctx: CommandContext, verb: "sign" | "statement" | "verify", cwd: string): Promise<number> {
  const { args } = ctx;
  const id = args.extraPositional2;
  if (verb === "sign") {
    const print = (doc: RunsWriteDocument): number => {
      console.log(JSON.stringify(doc, null, 2));
      return "error" in doc ? 1 : 0;
    };
    const usage = (message: string) => print({ $schema: RUNS_WRITE_SCHEMA_ID, contract: RUNS_CONTRACT_VERSION, verb, error: { code: "write-usage-invalid", message } });
    if (!id) return usage("runs sign needs the run id: runs sign <run id> --key <runner key.pem>");
    if ((args.key === undefined) === (args.envelope === undefined)) return usage("runs sign takes --key <runner key.pem> to sign here, or --envelope <file|-> for a statement signed elsewhere, not both");
    let keyPem: string | undefined;
    let envelope: string | undefined;
    try {
      if (args.key !== undefined) keyPem = readFileSync(resolve(cwd, args.key), "utf-8");
      else envelope = readFields(args.envelope, cwd);
    } catch (err) {
      const which = args.key !== undefined ? "runner-key-invalid" : "envelope-unreadable";
      return print({ $schema: RUNS_WRITE_SCHEMA_ID, contract: RUNS_CONTRACT_VERSION, verb, error: { code: which, message: `${args.key ?? args.envelope} could not be read: ${err instanceof Error ? err.message : String(err)}` } });
    }
    return print(await runsSign({ id, cwd, keyPem, envelope, base: args.base }));
  }
  const print = (doc: RunStatementDocument): number => {
    if (args.json || verb === "statement" || "error" in doc) console.log(JSON.stringify(doc, null, 2));
    else console.log(formatRunsVerify(doc as Extract<RunStatementDocument, { verb: "verify"; runs: unknown }>));
    return "error" in doc || ("ok" in doc && !doc.ok) ? 1 : 0;
  };
  const usage = (message: string) => print({ ...statementHead(), verb, error: { code: "write-usage-invalid", message } });
  if (verb === "statement") {
    if (!id) return usage("runs statement needs the run id: runs statement <run id> --signer <principal>");
    if (!args.signer) return usage("runs statement needs --signer <principal>: the runner principal whose key will sign it, as .chant/trust.json lists it");
    return print(await runStatement(id, args.signer, cwd));
  }
  if (args.require !== undefined && args.require !== "signed") return usage(`runs verify --require takes one level, signed, not ${JSON.stringify(args.require)}`);
  return print(await runsVerify({ cwd, id, require: args.require === "signed" ? "signed" : undefined, base: args.base }));
}

/** `runs verify` as lines for a person. */
export function formatRunsVerify(doc: Extract<RunStatementDocument, { verb: "verify"; runs: unknown }>): string {
  const out: string[] = [];
  const t = doc.trust;
  out.push(`trust at base ${t.base?.slice(0, 8) ?? "none"}: ${t.runners.length} runner key${t.runners.length === 1 ? "" : "s"}${t.runners.length ? ` (${t.runners.map((r) => `${r.principal} ${r.class}`).join(", ")})` : ""}`);
  for (const p of t.problems) out.push(`  ${p}`);
  for (const r of doc.runs) out.push(`  ${r.id}  ${r.state === "running" ? "running" : r.attestation.status}${r.attestation.signer ? ` by ${r.attestation.signer}` : ""}  ${r.attestation.reason}`);
  const s = doc.summary;
  out.push(`${s.runs} run${s.runs === 1 ? "" : "s"}: ${s.signed} signed, ${s.unsigned} unsigned, ${s.failed} with a statement that does not verify, ${s.running} running`);
  for (const f of doc.failures) out.push(`failure  ${f}`);
  return out.join("\n");
}
