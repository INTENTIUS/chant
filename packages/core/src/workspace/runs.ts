/**
 * The agent run record (#3033, ws-076): what each agent run cost and which
 * changes it made.
 *
 * chant records runs and never starts one (ws-052). Whatever ran the agent,
 * a steward step, a factory, hud's chat or a lobby that proxies model calls,
 * reports the run through `chant workspace runs start|end|record`, and
 * chant appends it to the run ledger on `chant/lifecycle`, beside the work
 * lease histories (ws-068: a ledger entry is a fact about a run, never
 * revised). Nothing is written to the working tree, and no transcript is
 * copied: the record pins one by sha256.
 *
 * ## Storage
 *
 * `_agent-runs/<run id>.jsonl` in the ledger of the workspace root (flat at
 * the root, under `_members/<member>/` for a nested workspace). One file per
 * run, so concurrent runs never contend for one file, with two kinds of line:
 *
 * - `start`: who the run worked for (`by`), the agent session, the harness,
 *   model and provider, the work item and lease it worked under, the records
 *   it worked on, and the instruction pinned by hash.
 * - `end`: the outcome, the turns and tokens, the cost with its currency and
 *   the source of its prices, the transcript pinned by hash, and the commits
 *   the run made, each with its `git patch-id --stable` (#3036) and, when
 *   the writer knows them, the hunks of it the run wrote (#3034).
 *
 * The file name is `_agent-runs`, not `runs`, because an Op run already has
 * `<env>/runs__<op>.jsonl` (`../lifecycle/run-ledger.ts`).
 *
 * ## The join
 *
 * A commit names its run with the `Chant-Run` trailer (#3149, ws-075). The
 * run's end can also list commits, which joins a commit that carries no
 * trailer. `workspace runs` reports both, and `graph --intent` links each
 * commit to its run.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { describeLifecyclePush, fetchLifecycleStatus, type LifecyclePushStatus, pushLifecycleStatus, readBlobBySha, RefCASConflictError, writeLedgerFiles } from "../lifecycle/git";
import { resolveMemberLedger } from "../lifecycle/member-ledger";
import { sortedJsonReplacer } from "../utils";
import { RUN_TRAILER, parseRecordRef, type RecordRef } from "./trailers";

/** The directory on `chant/lifecycle` that holds the agent runs, under the workspace root's ledger prefix. */
export const AGENT_RUNS_DIR = "_agent-runs";

/** The branch the ledger is on. */
export const LEDGER_BRANCH = "chant/lifecycle";

/** A run id: one file name and one trailer value. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{4,64}$/;
const CURRENCY = /^[A-Z]{3}$/;

// ── The ledger lines ─────────────────────────────────────────────────────────

/** The tokens a run used. Every count is optional, since a harness may report only some. */
export interface RunUsage {
  turns: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
}

/** A sum of money, with where its prices came from: a harness's own report, a proxy's price table, a provider's bill. */
export interface RunCost {
  amount: number;
  /** ISO 4217, such as USD. */
  currency: string;
  /** What priced it, such as `harness:claude-code`, `lobby:list-2026-09` or `provider:billed`. */
  source: string;
}

/** One model's share of a run, when the harness reports a breakdown. */
export interface RunModelUsage {
  model: string;
  provider: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  cost: RunCost | null;
}

/** A file pinned by hash and never copied: the transcript, or the instruction the run was given. */
export interface RunPin {
  sha256: string;
  /** Its size in bytes, when chant hashed the file itself. */
  bytes: number | null;
  /** Where the caller keeps it, as the caller names it: a path on a box, a URL. chant never reads it back. */
  ref: string | null;
  /**
   * For the instruction only: a short excerpt the writer chose to show beside
   * the hash, such as its first line (#3034). The hash pins the whole
   * instruction; the excerpt is never checked against it. Absent when none was given.
   */
  excerpt?: string;
}

/** Lines of one file that a run wrote in a commit: new-side line numbers in the commit's own version of the file. */
export interface RunHunk {
  /** From the repository root, as git names it in the commit's diff. */
  path: string;
  start: number;
  end: number;
}

/** A commit a run's end lists. */
export interface RunCommit {
  sha: string;
  /** `git patch-id --stable` of the commit, or null for a commit with no patch, such as a merge. */
  patchId: string | null;
  /**
   * The hunks of the commit this run wrote, when the writer knows them, such
   * as when several runs share one commit (#3034). Absent when not given: the
   * run is then taken to have made the whole commit.
   */
  hunks?: RunHunk[];
}

/** The `start` line of `_agent-runs/<id>.jsonl`. */
export interface RunStartLine {
  version: 1;
  event: "start";
  run: string;
  at: string;
  /** The principal the run worked for: the person who prompted it, or the service that asked. */
  by: string | null;
  /** The agent session it ran as (ws-067), the value its commits carry in Chant-Agent. */
  agent: string | null;
  harness: { name: string; version: string | null };
  model: string | null;
  provider: string | null;
  /** The work item it worked on, and the work kind's name when the caller gives it. */
  unit: { id: string; kind: string | null } | null;
  /** The work lease's fencing token. */
  lease: string | null;
  /** Other records it worked on, such as the decision a decide call answered or the review a chat turn replied to. */
  records: RecordRef[];
  instruction: RunPin | null;
}

/** The `end` line of `_agent-runs/<id>.jsonl`. */
export interface RunEndLine {
  version: 1;
  event: "end";
  run: string;
  at: string;
  /** How the run ended, free text such as done, not_done, failed or cancelled. */
  outcome: string | null;
  usage: RunUsage | null;
  models: RunModelUsage[];
  cost: RunCost | null;
  transcript: RunPin | null;
  commits: RunCommit[];
}

export type RunLine = RunStartLine | RunEndLine;

// ── The caller's fields ──────────────────────────────────────────────────────

const count = z.number().int().nonnegative();
const nonEmpty = z.string().trim().min(1).refine((s) => !/[\r\n]/.test(s), "one line of text");
const iso = z.string().refine((s) => !Number.isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s), "an ISO 8601 date and time");
const costSchema = z.object({ amount: z.number().nonnegative().finite(), currency: z.string().regex(CURRENCY, "an ISO 4217 code such as USD"), source: nonEmpty }).strict();
const usageSchema = z.object({ turns: count.optional(), inputTokens: count.optional(), outputTokens: count.optional(), cacheReadTokens: count.optional(), cacheWriteTokens: count.optional() }).strict();
const pinSchema = z
  .object({ sha256: z.string().regex(SHA256, "64 lower-case hex digits").optional(), path: nonEmpty.optional(), ref: nonEmpty.optional() })
  .strict()
  .refine((p) => (p.sha256 === undefined) !== (p.path === undefined), "give sha256, or a path for chant to hash, not both");
/** The longest instruction excerpt kept, in characters. */
export const INSTRUCTION_EXCERPT_MAX = 500;
const instructionSchema = z
  .object({
    sha256: z.string().regex(SHA256, "64 lower-case hex digits").optional(),
    path: nonEmpty.optional(),
    ref: nonEmpty.optional(),
    excerpt: z.string().trim().min(1).max(INSTRUCTION_EXCERPT_MAX).optional(),
  })
  .strict()
  .refine((p) => (p.sha256 === undefined) !== (p.path === undefined), "give sha256, or a path for chant to hash, not both");
const lineNumber = z.number().int().positive();
const hunkSchema = z
  .object({ path: nonEmpty, start: lineNumber, end: lineNumber })
  .strict()
  .refine((h) => h.end >= h.start, "end is not before start")
  .refine((h) => !h.path.startsWith("/") && !h.path.split("/").includes(".."), "a path from the repository root");
const commitSchema = z.union([z.string().regex(COMMIT, "a commit id"), z.object({ sha: z.string().regex(COMMIT, "a commit id"), hunks: z.array(hunkSchema).min(1) }).strict()]);

const startFields = {
  id: z.string().regex(RUN_ID_PATTERN, "letters, digits, '.', '_' and '-', starting with a letter or digit").optional(),
  startedAt: iso.optional(),
  by: nonEmpty.optional(),
  agent: nonEmpty.optional(),
  harness: z.union([nonEmpty, z.object({ name: nonEmpty, version: nonEmpty.optional() }).strict()]),
  model: nonEmpty.optional(),
  provider: nonEmpty.optional(),
  unit: z.union([nonEmpty, z.object({ id: nonEmpty, kind: nonEmpty.optional() }).strict()]).optional(),
  lease: nonEmpty.optional(),
  records: z.array(z.string().refine((s) => parseRecordRef(s) !== undefined, "<kind>:<id>")).optional(),
  instruction: instructionSchema.optional(),
};
const endFields = {
  endedAt: iso.optional(),
  outcome: nonEmpty.optional(),
  usage: usageSchema.optional(),
  models: z.array(z.object({ model: nonEmpty, provider: nonEmpty.optional(), inputTokens: count.optional(), outputTokens: count.optional(), cacheReadTokens: count.optional(), cacheWriteTokens: count.optional(), cost: costSchema.optional() }).strict()).optional(),
  cost: costSchema.optional(),
  transcript: pinSchema.optional(),
  commits: z.array(commitSchema).optional(),
};

/** The fields `runs start --from` takes. */
export const runStartInputSchema = z.object(startFields).strict();
/** The fields `runs end <id> --from` takes. */
export const runEndInputSchema = z.object(endFields).strict();
/** The fields `runs record --from` takes: a start and an end in one. */
export const runRecordInputSchema = z.object({ ...startFields, ...endFields }).strict();

export type RunStartInput = z.infer<typeof runStartInputSchema>;
export type RunEndInput = z.infer<typeof runEndInputSchema>;
export type RunRecordInput = z.infer<typeof runRecordInputSchema>;

// ── Errors ───────────────────────────────────────────────────────────────────

/** Why a run write was refused. */
export type RunWriteRefusal = "run-exists" | "run-unknown" | "run-ended" | "write-input-invalid" | "not-a-git-repository";

export class RunWriteError extends Error {
  constructor(
    readonly code: RunWriteRefusal,
    message: string,
  ) {
    super(message);
    this.name = "RunWriteError";
  }
}

// ── Git ──────────────────────────────────────────────────────────────────────

function git(top: string, args: string[], input?: string): string | undefined {
  try {
    return execFileSync("git", args, { cwd: top, encoding: "utf-8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
  } catch {
    return undefined;
  }
}

/** The full id of `rev` as a commit, or undefined. */
function commitId(top: string, rev: string): string | undefined {
  return git(top, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`])?.trim() || undefined;
}

/** `git patch-id --stable` of one commit, or null when it has no patch, such as a merge. */
export function patchIdOf(top: string, sha: string): string | null {
  const patch = git(top, ["show", "--format=", "--patch", "--no-color", "--no-ext-diff", sha]);
  if (!patch || patch.trim() === "") return null;
  const out = git(top, ["patch-id", "--stable"], patch);
  return out?.trim().split(/\s+/)[0] || null;
}

function hashFile(path: string): RunPin {
  const bytes = readFileSync(path);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: statSync(path).size, ref: null };
}

function pinOf(p: (z.infer<typeof pinSchema> & { excerpt?: string }) | undefined, cwd: string, what: string): RunPin | null {
  if (!p) return null;
  const excerpt = p.excerpt === undefined ? {} : { excerpt: p.excerpt };
  if (p.sha256) return { sha256: p.sha256, bytes: null, ref: p.ref ?? null, ...excerpt };
  const path = resolve(cwd, p.path!);
  let pin: RunPin;
  try {
    pin = hashFile(path);
  } catch (err) {
    throw new RunWriteError("write-input-invalid", `${what}.path ${p.path} can't be read to hash it: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { ...pin, ref: p.ref ?? p.path!, ...excerpt };
}

// ── Building the lines ───────────────────────────────────────────────────────

/** A new run id: the start time to the second, and eight random hex digits. */
export function newRunId(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomBytes(4).toString("hex")}`;
}

function parseInput<T>(schema: z.ZodType<T>, value: unknown, verb: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RunWriteError("write-input-invalid", `runs ${verb}: ${parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "the fields"}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

function startLine(input: RunStartInput, id: string, at: string, cwd: string): RunStartLine {
  const harness = typeof input.harness === "string" ? { name: input.harness, version: null } : { name: input.harness.name, version: input.harness.version ?? null };
  const unit = input.unit === undefined ? null : typeof input.unit === "string" ? { id: input.unit, kind: null } : { id: input.unit.id, kind: input.unit.kind ?? null };
  return {
    version: 1,
    event: "start",
    run: id,
    at,
    by: input.by ?? null,
    agent: input.agent ?? null,
    harness,
    model: input.model ?? null,
    provider: input.provider ?? null,
    unit,
    lease: input.lease ?? null,
    records: (input.records ?? []).map((r) => parseRecordRef(r)!),
    instruction: pinOf(input.instruction, cwd, "instruction"),
  };
}

function endLine(input: RunEndInput, id: string, at: string, top: string, cwd: string): RunEndLine {
  const commits: RunCommit[] = [];
  for (const entry of input.commits ?? []) {
    const c = typeof entry === "string" ? entry : entry.sha;
    const sha = commitId(top, c);
    if (!sha) throw new RunWriteError("write-input-invalid", `commits: ${c} names no commit in this repository`);
    const hunks = typeof entry === "string" ? undefined : entry.hunks.map((h) => ({ path: h.path, start: h.start, end: h.end }));
    const listed = commits.find((x) => x.sha === sha);
    if (listed) {
      if (hunks) listed.hunks = [...(listed.hunks ?? []), ...hunks];
    } else commits.push({ sha, patchId: patchIdOf(top, sha), ...(hunks ? { hunks } : {}) });
  }
  const usage = input.usage
    ? { turns: input.usage.turns ?? null, inputTokens: input.usage.inputTokens ?? null, outputTokens: input.usage.outputTokens ?? null, cacheReadTokens: input.usage.cacheReadTokens ?? null, cacheWriteTokens: input.usage.cacheWriteTokens ?? null }
    : null;
  return {
    version: 1,
    event: "end",
    run: id,
    at,
    outcome: input.outcome ?? null,
    usage,
    models: (input.models ?? []).map((m) => ({
      model: m.model,
      provider: m.provider ?? null,
      inputTokens: m.inputTokens ?? null,
      outputTokens: m.outputTokens ?? null,
      cacheReadTokens: m.cacheReadTokens ?? null,
      cacheWriteTokens: m.cacheWriteTokens ?? null,
      cost: m.cost ?? null,
    })),
    cost: input.cost ?? null,
    transcript: pinOf(input.transcript, cwd, "transcript"),
    commits,
  };
}

// ── Reading the ledger ───────────────────────────────────────────────────────

/** Parse one run file, oldest line first. Lines that aren't run events are counted and skipped. */
export function parseRunFile(content: string, id: string): { lines: RunLine[]; malformed: number } {
  const lines: RunLine[] = [];
  let malformed = 0;
  for (const raw of content.split("\n").map((l) => l.trim()).filter(Boolean)) {
    try {
      const v = JSON.parse(raw) as Partial<RunLine>;
      const ok = v.version === 1 && (v.event === "start" || v.event === "end") && v.run === id && typeof v.at === "string";
      if (ok) lines.push(v as RunLine);
      else malformed++;
    } catch {
      malformed++;
    }
  }
  return { lines, malformed };
}

/** The ledger directory of the workspace whose root is `rootOnDisk`, on the branch. */
export async function runsDir(rootOnDisk: string): Promise<string> {
  const { prefix } = await resolveMemberLedger(rootOnDisk);
  return `${prefix}${AGENT_RUNS_DIR}`;
}

/** Every run file in `dir` on the local branch, by run id, and the branch tip read. Never fetches. */
export function readRunFiles(top: string, dir: string): { tip: string | null; files: Map<string, { path: string; content: string }> } {
  const files = new Map<string, { path: string; content: string }>();
  const tip = commitId(top, `refs/heads/${LEDGER_BRANCH}`) ?? null;
  if (!tip) return { tip, files };
  const listing = git(top, ["ls-tree", "-z", `${tip}:${dir}`]);
  if (!listing) return { tip, files };
  const entries: { id: string; sha: string }[] = [];
  for (const entry of listing.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [, type, sha] = entry.slice(0, tab).split(" ");
    const name = entry.slice(tab + 1);
    const m = name.match(/^(.+)\.jsonl$/);
    if (type === "blob" && m && RUN_ID_PATTERN.test(m[1])) entries.push({ id: m[1], sha });
  }
  if (entries.length === 0) return { tip, files };
  const batch = git(top, ["cat-file", "--batch"], `${entries.map((e) => e.sha).join("\n")}\n`) ?? "";
  // Each object: "<sha> blob <size>\n<content>\n".
  let pos = 0;
  for (const e of entries) {
    const nl = batch.indexOf("\n", pos);
    if (nl < 0) break;
    const size = Number(batch.slice(pos, nl).split(" ")[2]);
    const start = nl + 1;
    const content = Buffer.from(batch.slice(start)).subarray(0, size).toString("utf-8");
    files.set(e.id, { path: `${dir}/${e.id}.jsonl`, content });
    pos = start + content.length + 1;
  }
  return { tip, files };
}

// ── Writing ──────────────────────────────────────────────────────────────────

/** Where a write went. */
export interface RunLedgerWrite {
  branch: string;
  path: string;
  commit: string;
  /** Whether chant/lifecycle reached the remote; false with no remote too. */
  pushed: boolean;
  /** Why it did not, when `pushed` is false (#3391): no remote, a remote that moved on, or git's refusal. */
  notPushed?: string;
}

export interface RunWriteResult {
  id: string;
  /** Every line of the run's file after the write. */
  lines: RunLine[];
  ledger: RunLedgerWrite;
}

const APPEND_RETRY_ATTEMPTS = 5;

/**
 * Append `make(existing)`'s lines to run `id`'s file, with the read-then-CAS
 * retry the lease history uses, then push `chant/lifecycle` best-effort.
 */
async function appendRun(top: string, rootOnDisk: string, id: string, make: (existing: RunLine[]) => RunLine[], message: string): Promise<RunWriteResult> {
  await fetchLifecycleStatus({ cwd: top }).catch(() => undefined);
  const dir = await runsDir(rootOnDisk);
  const path = `${dir}/${id}.jsonl`;
  let commit: string | undefined;
  let written: RunLine[] = [];
  let lastErr: unknown;
  for (let attempt = 1; attempt <= APPEND_RETRY_ATTEMPTS && commit === undefined; attempt++) {
    const prior = git(top, ["rev-parse", "--verify", "--quiet", `refs/heads/${LEDGER_BRANCH}:${path}`])?.trim() || null;
    const text = prior ? ((await readBlobBySha(prior, { cwd: top })) ?? "") : "";
    const existing = parseRunFile(text, id).lines;
    const lines = make(existing);
    const content = [text.replace(/\n$/, ""), ...lines.map((l) => JSON.stringify(l, sortedJsonReplacer))].filter(Boolean).join("\n");
    try {
      commit = await writeLedgerFiles([{ path, content, expectPriorSha: prior }], message, { cwd: top });
      written = [...existing, ...lines];
    } catch (err) {
      if (!(err instanceof RefCASConflictError)) throw err;
      lastErr = err;
    }
  }
  if (commit === undefined) throw lastErr;
  const push: LifecyclePushStatus = await pushLifecycleStatus({ cwd: top }).catch((err) => ({ status: "failed" as const, remote: "(unknown)", stderr: err instanceof Error ? err.message : String(err) }));
  const notPushed = describeLifecyclePush(push);
  return { id, lines: written, ledger: { branch: LEDGER_BRANCH, path, commit, pushed: push.status === "pushed", ...(notPushed ? { notPushed } : {}) } };
}

export interface RunWriteContext {
  /** The git top. */
  top: string;
  /** The workspace root on disk, whose ledger holds the runs. */
  rootOnDisk: string;
  /** What relative paths in the fields resolve against. */
  cwd: string;
  now?: () => Date;
}

/** `runs start`: a run's start, with a new id unless the fields give one. Refused with `run-exists` for an id in use. */
export async function startRun(fields: unknown, ctx: RunWriteContext): Promise<RunWriteResult> {
  const input = parseInput(runStartInputSchema, fields, "start");
  const startedAt = input.startedAt ?? (ctx.now?.() ?? new Date()).toISOString();
  const id = input.id ?? newRunId(new Date(startedAt));
  const line = startLine(input, id, startedAt, ctx.cwd);
  return appendRun(
    ctx.top,
    ctx.rootOnDisk,
    id,
    (existing) => {
      if (existing.length > 0) throw new RunWriteError("run-exists", `the ledger already has an agent run ${id}`);
      return [line];
    },
    `Agent run start: ${id}`,
  );
}

/** `runs end <id>`: a started run's end. Refused with `run-unknown` when it never started and `run-ended` when it already ended. */
export async function endRun(id: string, fields: unknown, ctx: RunWriteContext): Promise<RunWriteResult> {
  if (!RUN_ID_PATTERN.test(id)) throw new RunWriteError("run-unknown", `${JSON.stringify(id)} is not a run id`);
  const input = parseInput(runEndInputSchema, fields, "end");
  const now = ctx.now?.() ?? new Date();
  const line = endLine(input, id, input.endedAt ?? now.toISOString(), ctx.top, ctx.cwd);
  return appendRun(
    ctx.top,
    ctx.rootOnDisk,
    id,
    (existing) => {
      const start = existing.find((l): l is RunStartLine => l.event === "start");
      if (!start) throw new RunWriteError("run-unknown", `the ledger has no agent run ${id}; start it with runs start, or report a finished run with runs record`);
      if (existing.some((l) => l.event === "end")) throw new RunWriteError("run-ended", `agent run ${id} has already ended`);
      if (Date.parse(line.at) < Date.parse(start.at)) throw new RunWriteError("write-input-invalid", `endedAt ${line.at} is before the run started at ${start.at}`);
      return [line];
    },
    `Agent run end: ${id}`,
  );
}

/** `runs record`: a run that has finished, its start and end in one write. */
export async function recordRun(fields: unknown, ctx: RunWriteContext): Promise<RunWriteResult> {
  const input = parseInput(runRecordInputSchema, fields, "record");
  const now = ctx.now?.() ?? new Date();
  const endedAt = input.endedAt ?? now.toISOString();
  const startedAt = input.startedAt ?? endedAt;
  if (Date.parse(endedAt) < Date.parse(startedAt)) throw new RunWriteError("write-input-invalid", `endedAt ${endedAt} is before startedAt ${startedAt}`);
  const id = input.id ?? newRunId(new Date(startedAt));
  const start = startLine(input, id, startedAt, ctx.cwd);
  const end = endLine(input, id, endedAt, ctx.top, ctx.cwd);
  return appendRun(
    ctx.top,
    ctx.rootOnDisk,
    id,
    (existing) => {
      if (existing.length > 0) throw new RunWriteError("run-exists", `the ledger already has an agent run ${id}`);
      return [start, end];
    },
    `Agent run: ${id}`,
  );
}

// ── Folding a run ────────────────────────────────────────────────────────────

/** A commit a run made, as the read reports it. */
export interface RunCommitView {
  sha: string;
  patchId: string | null;
  /** How the commit joins the run: `trailer` when it carries `Chant-Run`, `record` when the run's end lists it. */
  joinedBy: ("trailer" | "record")[];
  /** The hunks of the commit the run's end says it wrote, or null when it gives none (#3034). */
  hunks: RunHunk[] | null;
}

/** One run, its start and end folded together, as `runs --json` and `graph --intent` report it. */
export interface RunView {
  id: string;
  /** `running` until its end is recorded. */
  state: "running" | "ended";
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  by: string | null;
  agent: string | null;
  harness: { name: string; version: string | null };
  model: string | null;
  provider: string | null;
  unit: { id: string; kind: string | null } | null;
  lease: string | null;
  records: RecordRef[];
  instruction: RunPin | null;
  usage: RunUsage | null;
  models: RunModelUsage[];
  cost: RunCost | null;
  transcript: RunPin | null;
  commits: RunCommitView[];
  /** The decisions the run carried out, as `<kind>/<id>`: the ones its work item implements, and the decision records it names. */
  decisions: string[];
  /** Its file on the branch. */
  ledger: string;
}

/** Fold a run's lines into one view, or undefined when it has no start. */
export function foldRun(id: string, path: string, lines: RunLine[]): RunView | undefined {
  const start = lines.find((l): l is RunStartLine => l.event === "start");
  if (!start) return undefined;
  const end = lines.find((l): l is RunEndLine => l.event === "end");
  return {
    id,
    state: end ? "ended" : "running",
    startedAt: start.at,
    endedAt: end?.at ?? null,
    outcome: end?.outcome ?? null,
    by: start.by,
    agent: start.agent,
    harness: start.harness,
    model: start.model,
    provider: start.provider,
    unit: start.unit,
    lease: start.lease,
    records: start.records ?? [],
    instruction: start.instruction ?? null,
    usage: end?.usage ?? null,
    models: end?.models ?? [],
    cost: end?.cost ?? null,
    transcript: end?.transcript ?? null,
    commits: (end?.commits ?? []).map((c) => ({ sha: c.sha, patchId: c.patchId, joinedBy: ["record" as const], hunks: Array.isArray(c.hunks) && c.hunks.length > 0 ? c.hunks : null })),
    decisions: [],
    ledger: path,
  };
}

/** Every run in the ledger of the workspace at `rootOnDisk`, by id, with the malformed line count. Never fetches. */
export async function readRuns(top: string, rootOnDisk: string): Promise<{ tip: string | null; dir: string; runs: Map<string, RunView>; malformed: number }> {
  const dir = await runsDir(rootOnDisk);
  const { tip, files } = readRunFiles(top, dir);
  const runs = new Map<string, RunView>();
  let malformed = 0;
  for (const [id, f] of files) {
    const parsed = parseRunFile(f.content, id);
    malformed += parsed.malformed;
    const view = foldRun(id, f.path, parsed.lines);
    if (view) runs.set(id, view);
    else malformed += parsed.lines.length;
  }
  return { tip, dir, runs, malformed };
}

/**
 * The commits reachable from `rev` that carry a `Chant-Run` trailer, by run
 * id, newest first. One `git log` over the history; nothing is fetched.
 */
export function commitsByRunTrailer(top: string, rev = "HEAD"): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!commitId(top, rev)) return out;
  const text = git(top, ["log", rev, `--format=%x00%H%x1f%(trailers:key=${RUN_TRAILER},valueonly,separator=%x1e)`]) ?? "";
  for (const record of text.split("\0")) {
    if (!record.trim()) continue;
    const [sha, values] = record.split("\x1f");
    for (const v of (values ?? "").split("\x1e").map((x) => x.trim()).filter(Boolean)) (out.get(v) ?? out.set(v, []).get(v)!).push(sha.trim());
  }
  return out;
}

/** Add the commits that name each run by trailer to its `commits`, after the ones its end lists. */
export function joinTrailerCommits(runs: Map<string, RunView>, byTrailer: Map<string, string[]>, top: string): void {
  for (const [id, shas] of byTrailer) {
    const run = runs.get(id);
    if (!run) continue;
    for (const sha of shas) {
      const listed = run.commits.find((c) => c.sha === sha);
      if (listed) {
        if (!listed.joinedBy.includes("trailer")) listed.joinedBy.push("trailer");
      } else run.commits.push({ sha, patchId: patchIdOf(top, sha), joinedBy: ["trailer"], hunks: null });
    }
  }
}

// ── Joining commits to runs, for the intent walks ────────────────────────────

/** A run as a commit in the intent walks names it: enough to say which model and harness made the change, and for whom. */
export interface RunRef {
  id: string;
  /** Whether the ledger has the run. A trailer can name a run whose record is missing or not fetched. */
  recorded: boolean;
  state: "running" | "ended" | null;
  harness: string | null;
  model: string | null;
  provider: string | null;
  by: string | null;
  agent: string | null;
  unit: string | null;
  /** `trailer`: the commit carries `Chant-Run` with the id. `record`: the run's end lists the commit. */
  joinedBy: ("trailer" | "record")[];
}

/**
 * For each commit, the runs that made it: the run its `Chant-Run` trailer
 * names, and every run whose end lists it. Reads the run ledger once from the
 * local branch; never fetches.
 */
export async function runsForCommits(top: string, rootOnDisk: string, commits: { sha: string; run: string | null }[]): Promise<{ refs: Map<string, RunRef[]>; runs: Map<string, RunView> }> {
  let runs = new Map<string, RunView>();
  try {
    runs = (await readRuns(top, rootOnDisk)).runs;
  } catch {
    // A ledger that can't be located leaves every run unrecorded; the trailers still say which.
  }
  const listing = new Map<string, string[]>();
  for (const r of runs.values()) for (const c of r.commits) (listing.get(c.sha) ?? listing.set(c.sha, []).get(c.sha)!).push(r.id);
  const refs = new Map<string, RunRef[]>();
  for (const c of commits) {
    const ids = [...new Set([...(c.run ? [c.run] : []), ...(listing.get(c.sha) ?? [])])];
    refs.set(
      c.sha,
      ids.map((id) => {
        const r = runs.get(id);
        const joinedBy: ("trailer" | "record")[] = [...(c.run === id ? ["trailer" as const] : []), ...((listing.get(c.sha) ?? []).includes(id) ? ["record" as const] : [])];
        return {
          id,
          recorded: r !== undefined,
          state: r?.state ?? null,
          harness: r?.harness.name ?? null,
          model: r?.model ?? null,
          provider: r?.provider ?? null,
          by: r?.by ?? null,
          agent: r?.agent ?? null,
          unit: r?.unit?.id ?? null,
          joinedBy,
        };
      }),
    );
  }
  return { refs, runs };
}
