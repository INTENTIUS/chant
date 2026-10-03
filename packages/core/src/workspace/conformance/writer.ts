/**
 * Workspace writer conformance (#3159, ws-074).
 *
 * The repo is the database (ws-074): every durable fact about a workspace is
 * a file in the repository or a line on its ledger branch, written only
 * through chant's write contract, and a tool keeps nothing but secrets,
 * telemetry, caches and its substrate's runtime state outside it. The reader
 * suite beside this module holds a reader to the read contract. This one
 * holds a writer, such as hud or studio's factory, to the write contract:
 *
 *   1. Writes go through chant. The suite drives a script of writes
 *      ({@link WRITER_SCRIPT}) through the writer's `write(step)`. Each step
 *      must make exactly one chant call, the step's write-contract command
 *      with its arguments (and its JSON flag, where the command has one),
 *      giving chant the step's fields on stdin. The document the writer
 *      returns is the one chant printed, it validates against the command's
 *      output schema, and it is not a refusal.
 *   2. Every change is chant's. The workspace's files (outside `.git`) and its
 *      git refs are read before and after each step. A file may change only
 *      when it is the path the command reports writing, and a ref only when
 *      it is the lease ref or the `chant/lifecycle` commit the command
 *      reports.
 *   3. Amnesia. The writer is given a state directory of its own, outside
 *      the workspace, and declares what it keeps there (`privateState`). After
 *      the script the suite asks the writer for the facts it shows
 *      (`facts()`), closes it, deletes everything in the state directory,
 *      builds the writer again and asks again: the two answers must be equal.
 *      The suite also reads every fact the script produced back through the
 *      read contract, the uncommitted records included.
 *   4. No facts outside the repo. A file left in the state directory that
 *      `privateState` does not declare is a problem, and so is an entry of
 *      the writer's optional `holds()` that names a record, run or lease the
 *      repository does not have, unless it names itself one of the four
 *      exceptions.
 *
 *   5. Concurrent writes (#3173, ws-089). When the writer performs `records
 *      amend`, the suite has it make three amendments of the script's
 *      decision at once, each from the digest the suite read
 *      (`--expect <digest>`), as two people and an agent would. Exactly one
 *      must be written; the other two must come back as chant's
 *      record-conflict refusal, naming the winner's digest, returned to the
 *      suite unchanged rather than retried blindly or hidden. The suite then
 *      has the writer retry each from the digest its refusal named, and each
 *      retry must be written. See {@link CONCURRENT_AMENDS}.
 *
 * `facts()` may only read: every chant call it makes must be a read-contract
 * command, and it must leave the workspace as it was.
 *
 * The workspace is generated for each run, from the reader suite's fixture
 * and the `__writer_fixture__/` overlay this package ships beside this module:
 * the reference workspace's work, answer and session kinds, its decision
 * points, and one open work item, W-001. Nothing is written anywhere else.
 *
 * Actions a writer does not list in `actions` are not applicable to it. The
 * suite still performs those steps itself, directly through chant, so a later
 * step that depends on one (an amend on the decision a `records new` made,
 * an evidence entry under a claimed lease) has what it needs.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createConformanceWorkspace, defaultChantCommand, runChant, treeChanges, type ChantRun, type ChantTransport } from "./index";

// Nothing at the top level of this module may use a binding imported from
// ./index: index re-exports this module, so this module is evaluated first.

/** The write-contract commands a writer performs, as the suite names them. */
export const WRITE_CONTRACT_ACTIONS = [
  "records new",
  "records amend",
  "records review",
  "records close",
  "points ask",
  "points answer",
  "work claim",
  "work renew",
  "work evidence",
  "work release",
  "runs start",
  "runs end",
  "runs record",
  "box listing set",
] as const;
export type WriteContractAction = (typeof WRITE_CONTRACT_ACTIONS)[number];

/** Each action's output schema, in `src/workspace/` beside this module's directory. */
export const WRITE_CONTRACT_SCHEMAS: Record<WriteContractAction, string> = {
  "records new": "records-new.schema.json",
  "records amend": "records-amend.schema.json",
  "records review": "records-review.schema.json",
  "records close": "records-close.schema.json",
  "points ask": "points-write.schema.json",
  "points answer": "points-write.schema.json",
  "work claim": "work-lease.schema.json",
  "work renew": "work-lease.schema.json",
  "work evidence": "work-evidence.schema.json",
  "work release": "work-lease.schema.json",
  "runs start": "runs-write.schema.json",
  "runs end": "runs-write.schema.json",
  "runs record": "runs-write.schema.json",
  "box listing set": "box-listing-write.schema.json",
};

/**
 * The flags a writer may add to each command. The record, points, evidence,
 * run and listing writes always print their document, so a writer adds
 * nothing or `--json`; a lease prints its document only with `--json`.
 */
export const WRITE_CONTRACT_JSON_FLAGS: Record<WriteContractAction, readonly (readonly string[])[]> = {
  "records new": [[], ["--json"]],
  "records amend": [[], ["--json"]],
  "records review": [[], ["--json"]],
  "records close": [[], ["--json"]],
  "points ask": [[], ["--json"]],
  "points answer": [[], ["--json"]],
  "work claim": [["--json"]],
  "work renew": [["--json"]],
  "work evidence": [[], ["--json"]],
  "work release": [["--json"]],
  "runs start": [[], ["--json"]],
  "runs end": [[], ["--json"]],
  "runs record": [[], ["--json"]],
  "box listing set": [[], ["--json"]],
};

/** What each action is given. Field documents are JSON values; the command reads them from stdin. */
export interface WriteParams {
  "records new": { kind: string; fields: Record<string, unknown> };
  /** `expect` (#3173): the record's digest the write builds on, passed as `--expect`. */
  "records amend": { id: string; kind: string; fields: Record<string, unknown>; expect?: string };
  "records review": { id: string; kind: string; verdict: "agree" | "dissent" | "abstain"; by: string; note?: string };
  "records close": { id: string; kind: string };
  "points ask": { point: string; kind: string; inputs: Record<string, unknown>; subject?: string };
  "points answer": { id: string; kind: string; answer: string; by: string };
  "work claim": { id: string; kind: string; holder: string };
  "work renew": { id: string; kind: string; holder: string; token: string };
  "work evidence": { id: string; kind: string; holder: string; token: string; entry: Record<string, unknown> };
  "work release": { id: string; kind: string; holder: string; token: string; outcome: string };
  "runs start": { run: Record<string, unknown> };
  "runs end": { id: string; fields: Record<string, unknown> };
  "runs record": { run: Record<string, unknown> };
  /** A box's listing (#3308): the member, the listing fields, and an image to copy in as its cover. */
  "box listing set": { member: string; fields: Record<string, unknown>; cover?: string };
}

/** One write the suite asks of the writer: the action, what it is given, and the command that performs it. */
export type WriteStep = {
  [A in WriteContractAction]: {
    /** The step's name in the script, such as `review`. */
    id: string;
    action: A;
    params: WriteParams[A];
    /** The arguments after `chant workspace <action>`, as {@link writeArgv} builds them from `params`. */
    args: string[];
    /** What the command reads on stdin (`--from -`, `--set -`, `--inputs -`), when it reads anything. */
    input?: string;
  };
}[WriteContractAction];

/**
 * The arguments that perform `action` with `params`, after `chant workspace
 * <action>`, and the JSON the command reads on stdin. A writer can build its
 * calls with this, or with its own code that makes the same call.
 */
export function writeArgv<A extends WriteContractAction>(action: A, params: WriteParams[A]): { args: string[]; input?: string } {
  const p = params as WriteParams[WriteContractAction] & Record<string, unknown>;
  const json = (v: unknown) => JSON.stringify(v);
  switch (action) {
    case "records new": {
      const q = p as WriteParams["records new"];
      return { args: [q.kind, "--from", "-"], input: json(q.fields) };
    }
    case "records amend": {
      const q = p as WriteParams["records amend"];
      return { args: [q.id, "--kind", q.kind, "--set", "-", ...(q.expect !== undefined ? ["--expect", q.expect] : [])], input: json(q.fields) };
    }
    case "records review": {
      const q = p as WriteParams["records review"];
      return { args: [q.id, "--kind", q.kind, "--verdict", q.verdict, "--by", q.by, ...(q.note !== undefined ? ["--note", q.note] : [])] };
    }
    case "records close": {
      const q = p as WriteParams["records close"];
      return { args: [q.id, "--kind", q.kind] };
    }
    case "points ask": {
      const q = p as WriteParams["points ask"];
      return { args: [q.point, "--inputs", "-", ...(q.subject !== undefined ? ["--subject", q.subject] : []), "--kind", q.kind], input: json(q.inputs) };
    }
    case "points answer": {
      const q = p as WriteParams["points answer"];
      return { args: [q.id, "--answer", q.answer, "--by", q.by, "--kind", q.kind] };
    }
    case "work claim": {
      const q = p as WriteParams["work claim"];
      return { args: [q.id, "--holder", q.holder, "--kind", q.kind] };
    }
    case "work renew": {
      const q = p as WriteParams["work renew"];
      return { args: [q.id, "--holder", q.holder, "--token", q.token, "--kind", q.kind] };
    }
    case "work evidence": {
      const q = p as WriteParams["work evidence"];
      return { args: [q.id, "--holder", q.holder, "--token", q.token, "--from", "-", "--kind", q.kind], input: json(q.entry) };
    }
    case "work release": {
      const q = p as WriteParams["work release"];
      return { args: [q.id, "--holder", q.holder, "--token", q.token, "--outcome", q.outcome, "--kind", q.kind] };
    }
    case "runs start":
    case "runs record": {
      const q = p as WriteParams["runs start"];
      return { args: ["--from", "-"], input: json(q.run) };
    }
    case "runs end": {
      const q = p as WriteParams["runs end"];
      return { args: [q.id, "--from", "-"], input: json(q.fields) };
    }
    case "box listing set": {
      const q = p as WriteParams["box listing set"];
      return { args: [q.member, "--from", "-", ...(q.cover !== undefined ? ["--cover", q.cover] : [])], input: json(q.fields) };
    }
    default:
      throw new Error(`not a write-contract action: ${String(action)}`);
  }
}

/** The kind files of the writer workspace, from its root. */
export const WRITER_KINDS = {
  decision: "decisions/decision.kind.mjs",
  session: "sessions/session.kind.mjs",
  answer: "answers/answer.kind.mjs",
  work: "work/work.kind.mjs",
} as const;

/** The member of the writer workspace whose box block the script lists (#3308). */
export const WRITER_BOX = "app";

/**
 * The files the suite makes for a run outside the workspace, for a step to
 * hand chant: the cover image the listing step copies in (#3308), a PNG.
 */
export const WRITER_INPUTS = {
  cover: {
    name: "cover.png",
    bytes: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
  },
} as const;

/** Where the suite put {@link WRITER_INPUTS} for this run. */
export interface WriterInputs {
  dir: string;
}

/** Write {@link WRITER_INPUTS} into `dir`. */
export function writeWriterInputs(dir: string): WriterInputs {
  mkdirSync(dir, { recursive: true });
  for (const f of Object.values(WRITER_INPUTS)) writeFileSync(join(dir, f.name), f.bytes);
  return { dir };
}

/** The principals the script writes as. */
export const WRITER_PRINCIPALS = { holder: "conformance-writer", reviewer: "conformance-reviewer", by: "conformance" } as const;

/** One step of the script: its name, its action, and its params from the documents of the steps before it. */
export interface WriterScriptStep<A extends WriteContractAction = WriteContractAction> {
  id: string;
  action: A;
  /** `inputs` is where the suite put {@link WRITER_INPUTS}; a step that hands chant one of them leaves it out without. */
  params(done: Record<string, Record<string, unknown>>, inputs?: WriterInputs): WriteParams[A];
}

const step = <A extends WriteContractAction>(id: string, action: A, params: (done: Record<string, Record<string, unknown>>, inputs?: WriterInputs) => WriteParams[A]): WriterScriptStep => ({ id, action, params }) as WriterScriptStep;

const leaseToken = (done: Record<string, Record<string, unknown>>): string => String((done.claim?.lease as { token?: unknown } | undefined)?.token ?? "");
const RUN_STARTED = { harness: { name: "conformance", version: "1" }, model: "none", provider: "none", by: WRITER_PRINCIPALS.by, unit: "W-001" };

/**
 * The writes the suite drives, in order, each action at least once: a
 * decision made, amended and reviewed; a review session opened and closed; a
 * decision point asked and answered; the work item's lease claimed, renewed,
 * evidence attached under it and released; one run started and ended, and one
 * recorded whole; and the box's listing set, with a cover image copied in.
 */
export const WRITER_SCRIPT: readonly WriterScriptStep[] = [
  step("decision", "records new", () => ({
    kind: WRITER_KINDS.decision,
    fields: {
      schema: 1,
      title: "How a writer writes the workspace",
      state: "proposed",
      area: "delivery",
      source: { kind: "workspace", member: "delivery" },
      question: "How does a tool write a fact about this workspace?",
      options: [{ id: "a", label: "through chant's write contract", how: "Each fact is one chant write command.", tradeoff: "One chant call per fact." }],
      choice: null,
      rejected: [],
      supersedes: [],
      evidence: [{ title: "INTENTIUS/chant#3159, the writer conformance suite", url: "https://github.com/INTENTIUS/chant/issues/3159" }],
      decided_by: null,
      decided_on: null,
      reviews: [],
      constrains: ["member:delivery"],
    },
  })),
  step("amend", "records amend", (d) => ({ id: String(d.decision.id), kind: WRITER_KINDS.decision, fields: { title: "How a writer writes the workspace, through chant" } })),
  step("review", "records review", (d) => ({ id: String(d.decision.id), kind: WRITER_KINDS.decision, verdict: "agree", by: WRITER_PRINCIPALS.reviewer, note: "Written through chant, read back after amnesia." })),
  step("session", "records new", (d) => ({
    kind: WRITER_KINDS.session,
    fields: {
      schema: 1,
      id: "S-0001",
      title: "The writer suite walks its decision",
      state: "open",
      agenda: [{ record: String(d.decision.id) }],
      attendance: [{ principal: WRITER_PRINCIPALS.reviewer, class: "person" }],
      opened: "2026-01-01T00:00:00Z",
      closed: null,
      verdicts: [],
    },
  })),
  step("close", "records close", (d) => ({ id: String(d.session.id), kind: WRITER_KINDS.session })),
  step("ask", "points ask", () => ({
    point: "slice-tier",
    kind: WRITER_KINDS.answer,
    subject: "W-001",
    inputs: { "work-item.criteria": 1, "work-item.files": 1, "work-item.words": 40, "work-item.fits_small": false, "work-item.fits_medium": false },
  })),
  step("answer", "points answer", (d) => ({ id: String(d.ask.id), kind: WRITER_KINDS.answer, answer: "medium", by: WRITER_PRINCIPALS.reviewer })),
  step("claim", "work claim", () => ({ id: "W-001", kind: WRITER_KINDS.work, holder: WRITER_PRINCIPALS.holder })),
  step("renew", "work renew", (d) => ({ id: "W-001", kind: WRITER_KINDS.work, holder: WRITER_PRINCIPALS.holder, token: leaseToken(d) })),
  step("evidence", "work evidence", (d) => ({
    id: "W-001",
    kind: WRITER_KINDS.work,
    holder: WRITER_PRINCIPALS.holder,
    token: leaseToken(d),
    entry: { criterion: "AC-1", result: "pass", title: "The writer conformance suite's evidence step", url: "https://github.com/INTENTIUS/chant/issues/3159" },
  })),
  step("release", "work release", (d) => ({ id: "W-001", kind: WRITER_KINDS.work, holder: WRITER_PRINCIPALS.holder, token: leaseToken(d), outcome: "done" })),
  step("run-start", "runs start", () => ({ run: { id: "writer-run-1", startedAt: "2026-01-01T00:00:00Z", ...RUN_STARTED } })),
  step("run-end", "runs end", (d) => ({
    id: String((d["run-start"].run as { id?: unknown }).id),
    fields: { endedAt: "2026-01-01T00:05:00Z", outcome: "done", usage: { turns: 2, inputTokens: 100, outputTokens: 50 }, cost: { amount: 0.02, currency: "USD", source: "conformance" }, commits: [] },
  })),
  step("run-record", "runs record", () => ({
    run: {
      id: "writer-run-2",
      startedAt: "2026-01-01T01:00:00Z",
      endedAt: "2026-01-01T01:01:00Z",
      outcome: "done",
      usage: { turns: 1, inputTokens: 10, outputTokens: 5 },
      cost: { amount: 0.01, currency: "USD", source: "conformance" },
      commits: [],
      ...RUN_STARTED,
    },
  })),
  step("listing", "box listing set", (_d, inputs) => ({
    member: WRITER_BOX,
    fields: { published: true, title: "The writer suite's box", line: "Listed through chant, read back after amnesia." },
    ...(inputs ? { cover: join(inputs.dir, WRITER_INPUTS.cover.name) } : {}),
  })),
];

/**
 * The concurrent case (#3173): three amendments of the script's decision the
 * writer makes at once, each setting its question, as two people and an
 * agent answering the same record would. The suite gives each the digest it
 * read as `expect`.
 */
export const CONCURRENT_AMENDS: readonly { id: string; fields: Record<string, unknown> }[] = [
  { id: "concurrent-alice", fields: { question: "How does a tool write a fact about this workspace, as alice reads it?" } },
  { id: "concurrent-bob", fields: { question: "How does a tool write a fact about this workspace, as bob reads it?" } },
  { id: "concurrent-agent", fields: { question: "How does a tool write a fact about this workspace, as the agent reads it?" } },
];

/** The amend step of {@link CONCURRENT_AMENDS} entry `c`, on record `id`, from digest `expect`. */
export function concurrentAmendStep(c: { id: string; fields: Record<string, unknown> }, id: string, expect: string): WriteStep {
  const params: WriteParams["records amend"] = { id, kind: WRITER_KINDS.decision, fields: c.fields, expect };
  return { id: c.id, action: "records amend", params, ...writeArgv("records amend", params) } as WriteStep;
}

/** The four things ws-074 lets a tool keep outside the repo. */
export const PRIVATE_STATE_CATEGORIES = ["cache", "telemetry", "secret", "runtime"] as const;
export type PrivateStateCategory = (typeof PRIVATE_STATE_CATEGORIES)[number];

/** A file or directory the writer keeps in its state directory, and which of the four it is. */
export interface PrivateStatePath {
  /** From the state directory, with / separators. A directory covers everything under it. */
  path: string;
  is: PrivateStateCategory | readonly PrivateStateCategory[];
}

/** One thing the writer holds, as its `holds()` reports it. */
export type HeldItem =
  | { record: string; kind: string }
  | { run: string }
  | { lease: string; kind: string }
  | { exempt: PrivateStateCategory; what: string };

export interface WorkspaceWriter {
  /** Perform one step: run its write-contract command through the transport, and return the parsed document chant printed. */
  write(step: WriteStep): Promise<unknown> | unknown;
  /**
   * The facts the tool shows, read the way the tool reads them, as a JSON
   * value. The suite compares the answer before and after amnesia. It may make
   * read-contract calls only.
   */
  facts(): Promise<unknown> | unknown;
  /** Optional: what the tool holds, each entry a record, run or lease in the repo, or one of the four exceptions. */
  holds?(): Promise<readonly HeldItem[]> | readonly HeldItem[];
  /** Optional: let go of the state directory (close a database) before the suite deletes it. */
  close?(): Promise<void> | void;
}

export interface WriterContext {
  /**
   * A directory the writer keeps its private state in, such as a database
   * file. The suite makes it, outside the workspace, and the same one is given
   * to the writer built again after amnesia.
   */
  stateDir: string;
}

/** Build the writer over the transport the suite gives it. Called twice: before the script, and again after amnesia. */
export type WorkspaceWriterFactory = (chant: ChantTransport, context: WriterContext) => WorkspaceWriter;

export interface WorkspaceWriterConformanceOptions {
  /** The actions the writer performs. The suite performs the other steps itself. Defaults to every action. */
  actions?: readonly WriteContractAction[];
  /** What the writer keeps in its state directory. Anything else left there is a problem. Defaults to nothing. */
  privateState?: readonly PrivateStatePath[];
  /** The chant to run, as a command and its leading arguments. The reader suite's default. */
  chantCommand?: string[];
  /** How long one chant run may take, in milliseconds. Default 120000. */
  timeoutMs?: number;
}

export interface WorkspaceWriterConformanceConfig extends WorkspaceWriterConformanceOptions {
  /** Short label, used in the suite name. */
  name: string;
  writer: WorkspaceWriterFactory;
}

/** What one step found. */
export interface WriterStepResult {
  id: string;
  action: WriteContractAction;
  /** Whether the writer performed it, or the suite did because the action is not the writer's. */
  by: "writer" | "suite";
  args: string[];
  problems: string[];
}

/** What {@link runWorkspaceWriterConformance} found. The writer conforms when `problems` is empty. */
export interface WorkspaceWriterConformanceReport {
  /** Every problem, each starting with the step it concerns, or `amnesia:`, `facts:`, `state:`, `holds:` or `read back:`. */
  problems: string[];
  /** The actions the writer performed, in contract order. */
  checked: WriteContractAction[];
  /** The actions not in `actions`, so not applicable to this writer. */
  skipped: WriteContractAction[];
  results: WriterStepResult[];
  /** The problems of the checks after the script, by check. `concurrent` is empty, and not run, when the writer does not perform records amend. */
  after: { facts: string[]; state: string[]; amnesia: string[]; holds: string[]; readBack: string[]; concurrent: string[] };
  /** What `facts()` returned before amnesia and after. */
  facts: { before: unknown; after: unknown };
  /** The workspace written. Removed before the report is returned. */
  workspaceDir: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const workspaceSrc = resolve(here, "..");
/** The overlay the writer workspace adds to the reader suite's fixture, shipped under `src/`. */
export const WRITER_FIXTURE_DIR = join(here, "__writer_fixture__");

type Validate = ((d: unknown) => boolean) & { errors?: unknown };
const writeValidators = new Map<string, { validate: Validate; schema: { $id: string } }>();

/** An action's output schema and a draft 2020-12 validator for it, from this package's own ajv 8. */
export function writeContractSchema(action: WriteContractAction): { schema: { $id: string }; validate: Validate } {
  const file = WRITE_CONTRACT_SCHEMAS[action];
  let v = writeValidators.get(file);
  if (!v) {
    const schema = JSON.parse(readFileSync(join(workspaceSrc, file), "utf-8")) as { $id: string };
    const mod = createRequire(import.meta.url)("ajv/dist/2020") as { default?: unknown };
    const Ajv = (mod.default ?? mod) as new (opts: object) => { compile(s: object): Validate };
    v = { validate: new Ajv({ strict: true, allErrors: true }).compile(schema), schema };
    writeValidators.set(file, v);
  }
  return v;
}

/** A digest of every file under `dir`, skipping `.git` and node_modules: the working tree. */
export function worktreeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, prefix: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.name === "node_modules" || (prefix === "" && e.name === ".git")) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(at, e.name), rel);
      else if (e.isFile()) out[rel] = createHash("sha256").update(readFileSync(join(at, e.name))).digest("hex");
    }
  };
  walk(dir, "");
  return out;
}

/** Every git ref in `dir` and what it points at, with `HEAD` as the branch it names and its commit. */
export function gitRefs(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = execFileSync("git", ["for-each-ref", "--format=%(refname) %(objectname)"], { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  for (const line of text.split("\n")) {
    const at = line.indexOf(" ");
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
  }
  const head = (args: string[]) => {
    try {
      return execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch {
      return "";
    }
  };
  out.HEAD = `${head(["symbolic-ref", "-q", "HEAD"])} ${head(["rev-parse", "-q", "--verify", "HEAD"])}`;
  return out;
}

/** The refs that differ between two {@link gitRefs}, with what each now points at (empty when removed). */
export function refChanges(before: Record<string, string>, after: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [r, v] of Object.entries(after)) if (before[r] !== v) out[r] = v;
  for (const r of Object.keys(before)) if (after[r] === undefined) out[r] = "";
  return out;
}

/** Whether `argv` is a read-contract call: one a reader may make, which writes nothing. */
export function isReadCall(argv: readonly string[]): boolean {
  if (argv[0] !== "workspace") return false;
  const [, verb, sub] = argv;
  switch (verb) {
    case "ls":
    case "graph":
    case "check":
    case "status":
      return true;
    case "records":
      return !["new", "amend", "review", "close", "pin"].includes(sub ?? "");
    case "runs":
      return !["start", "end", "record"].includes(sub ?? "");
    case "points":
      return !["ask", "answer"].includes(sub ?? "");
    case "work":
      return sub === "history";
    default:
      return false;
  }
}

/**
 * What is wrong with the chant calls one step made: anything but exactly
 * one call, of `workspace <action>` with the step's arguments in order and
 * the action's JSON flag, given the step's fields on stdin. Empty when the
 * calls conform.
 */
export function writerCallProblems(step: WriteStep, calls: readonly ChantRun[]): string[] {
  const name = `${step.id} (${step.action})`;
  if (calls.length !== 1) return [`${name}: made ${calls.length} chant calls (${calls.map((c) => c.argv.join(" ")).join("; ")}), expected exactly one`];
  const { argv, input } = calls[0];
  const prefix = ["workspace", ...step.action.split(" ")];
  if (prefix.some((t, i) => argv[i] !== t)) return [`${name}: ran chant ${argv.join(" ")}, which is not workspace ${step.action}`];
  const rest = argv.slice(prefix.length);
  const at = rest.findIndex((_, i) => step.args.every((a, j) => rest[i + j] === a));
  if (step.args.length > 0 && at === -1) return [`${name}: ran chant ${argv.join(" ")}, which does not pass ${step.args.join(" ")} in order`];
  const extra = step.args.length > 0 ? [...rest.slice(0, at), ...rest.slice(at + step.args.length)] : rest;
  const allowed = WRITE_CONTRACT_JSON_FLAGS[step.action];
  if (!allowed.some((flags) => flags.length === extra.length && flags.every((f, i) => extra[i] === f))) {
    return [`${name}: ran chant ${argv.join(" ")}; beyond the command and its arguments it may add only ${allowed.map((f) => (f.length ? f.join(" ") : "nothing")).join(" or ")}, and it added ${extra.join(" ") || "nothing"}`];
  }
  if (step.input === undefined) return input === undefined || input === "" ? [] : [`${name}: gave chant ${argv.join(" ")} something on stdin, and the command reads nothing there`];
  let given: unknown;
  try {
    given = input === undefined ? undefined : JSON.parse(input);
  } catch {
    given = undefined;
  }
  return isDeepStrictEqual(given, JSON.parse(step.input)) ? [] : [`${name}: gave chant ${argv.join(" ")} other fields on stdin than the step's`];
}

/** Everything wrong with the document one step returned (`doc`), given what chant printed (`printed`). Empty when it conforms. */
export function writerDocumentProblems(step: WriteStep, printed: ChantRun, doc: unknown): string[] {
  const name = `${step.id} (${step.action})`;
  if (printed.stdout.trim() === "") return [`${name}: chant ${printed.argv.join(" ")} printed nothing${printed.stderr ? `; stderr: ${printed.stderr.trim()}` : ""}`];
  let parsed: unknown;
  try {
    parsed = JSON.parse(printed.stdout);
  } catch (e) {
    return [`${name}: chant ${printed.argv.join(" ")} printed something that is not JSON (${(e as Error).message}); stderr: ${printed.stderr.trim()}`];
  }
  const problems: string[] = [];
  if (!isDeepStrictEqual(doc, parsed)) problems.push(`${name}: the writer must return the document chant printed, unchanged, and it returned something else`);
  const { schema, validate } = writeContractSchema(step.action);
  if (!validate(parsed)) problems.push(`${name}: the document does not validate against ${WRITE_CONTRACT_SCHEMAS[step.action]}: ${JSON.stringify(validate.errors)}`);
  const head = (parsed ?? {}) as { $schema?: unknown; error?: { code?: string; message?: string }; refused?: { code?: string; message?: string } };
  if (head.$schema !== schema.$id) problems.push(`${name}: $schema is ${JSON.stringify(head.$schema)}, expected ${schema.$id}`);
  const no = head.error ?? head.refused;
  if (no) problems.push(`${name}: chant did not write: ${no.code}: ${no.message}`);
  return problems;
}

/** The files and refs a step's document says chant wrote. */
export function reportedWrites(action: WriteContractAction, doc: unknown): { paths: string[]; refs: Record<string, string> } {
  const d = (doc ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  if (action.startsWith("work ") && action !== "work evidence") {
    // The lease ref holds a lease blob whose value the document does not
    // print, so any value of the ref it names is chant's ("*").
    const history = (d.history ?? {}) as Record<string, unknown>;
    const refs: Record<string, string> = {};
    if (str(history.commit)) refs["refs/heads/chant/lifecycle"] = String(history.commit);
    if (str(d.ref)) refs[String(d.ref)] = "*";
    return { paths: [], refs };
  }
  if (action.startsWith("runs ")) {
    const ledger = (d.ledger ?? {}) as Record<string, unknown>;
    return { paths: [], refs: str(ledger.commit) ? { "refs/heads/chant/lifecycle": String(ledger.commit) } : {} };
  }
  if (action === "box listing set") return { paths: Array.isArray(d.paths) ? d.paths.filter((p): p is string => typeof p === "string") : [], refs: {} };
  return { paths: str(d.path) ? [String(d.path)] : [], refs: {} };
}

/**
 * What changed in the workspace during one step that the step's document
 * does not report: a file other than the path chant wrote, or a ref other
 * than the lease ref and the ledger commit chant wrote.
 */
export function unreportedChanges(
  step: WriteStep,
  doc: unknown,
  files: { before: Record<string, string>; after: Record<string, string> },
  refs: { before: Record<string, string>; after: Record<string, string> },
): string[] {
  const name = `${step.id} (${step.action})`;
  const reported = reportedWrites(step.action, doc);
  const problems: string[] = [];
  const changed = treeChanges(files.before, files.after).filter((c) => !reported.paths.includes(c.replace(/ \((added|changed|removed)\)$/, "")));
  if (changed.length > 0) problems.push(`${name}: files changed that chant did not report writing: ${changed.join(", ")}`);
  const refsChanged = Object.entries(refChanges(refs.before, refs.after)).filter(([r, v]) => !(r in reported.refs && (reported.refs[r] === "*" || reported.refs[r] === v)));
  if (refsChanged.length > 0) problems.push(`${name}: git refs changed that chant did not report writing: ${refsChanged.map(([r]) => r).join(", ")}`);
  return problems;
}

/** Build the step a script step is at, from the documents of the steps before it and where the suite put its inputs. */
export function buildStep(s: WriterScriptStep, done: Record<string, Record<string, unknown>>, inputs?: WriterInputs): WriteStep {
  const params = s.params(done, inputs);
  return { id: s.id, action: s.action, params, ...writeArgv(s.action, params) } as WriteStep;
}

/** The box listings `status --json` prints, by member: what a home site shows of each box (#3308). */
export async function readListing(run: (argv: string[]) => Promise<ChantRun>): Promise<Record<string, unknown>> {
  const doc = JSON.parse((await run(["workspace", "status", "dev", "--json"])).stdout) as { members?: { name: string; box: { listing?: unknown } | null }[] };
  return Object.fromEntries((doc.members ?? []).filter((m) => m.box?.listing).map((m) => [m.name, m.box!.listing]));
}

/** The smallest writer that conforms: each step is its one command, and its facts are read through the read contract. */
export const referenceWriter: WorkspaceWriterFactory = (chant) => ({
  async write(step) {
    const run = await chant.run(["workspace", ...step.action.split(" "), ...step.args, ...WRITE_CONTRACT_JSON_FLAGS[step.action][0]], step.input === undefined ? undefined : { input: step.input });
    return JSON.parse(run.stdout);
  },
  async facts() {
    const out: Record<string, unknown> = {};
    for (const [name, kind] of Object.entries(WRITER_KINDS)) {
      const run = await chant.run(["workspace", "records", "--kind", kind, "--json"]);
      const doc = JSON.parse(run.stdout) as { records: { id: string; state: string | null }[] };
      out[name] = doc.records.map((r) => [r.id, r.state]).sort();
    }
    const runs = JSON.parse((await chant.run(["workspace", "runs", "--json"])).stdout) as { runs: { id: string; state: string }[] };
    out.runs = runs.runs.map((r) => [r.id, r.state]).sort();
    out.listing = await readListing((argv) => chant.run(argv));
    return out;
  },
});

/** A workspace generated for a writer run, and how to remove it. */
export interface WriterConformanceWorkspace {
  dir: string;
  dispose(): void;
}

/**
 * Generate the writer conformance workspace: the reader suite's workspace
 * ({@link createConformanceWorkspace}), with `__writer_fixture__/` copied over
 * it, the four kinds declared in its `records`, a box block on
 * {@link WRITER_BOX} for the listing step, and that committed.
 */
export function createWriterConformanceWorkspace(options: { chantCommand?: string[]; timeoutMs?: number } = {}): WriterConformanceWorkspace {
  const ws = createConformanceWorkspace({ chantCommand: options.chantCommand, timeoutMs: options.timeoutMs });
  try {
    cpSync(WRITER_FIXTURE_DIR, ws.dir, { recursive: true });
    const declFile = join(ws.dir, "chant.workspace.json");
    const decl = JSON.parse(readFileSync(declFile, "utf-8")) as Record<string, unknown>;
    decl.records = Object.values(WRITER_KINDS).map((kind) => ({ kind }));
    const box = (decl.members as { name: string; box?: unknown }[] | undefined)?.find((m) => m.name === WRITER_BOX);
    if (box) box.box = {};
    writeFileSync(declFile, `${JSON.stringify(decl, null, 2)}\n`);
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=chant", "-c", "user.email=chant@localhost", "-c", "commit.gpgsign=false", ...args], {
        cwd: ws.dir,
        env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    git("add", "-A");
    git("commit", "--quiet", "-m", "the writer conformance workspace");
    return ws;
  } catch (e) {
    ws.dispose();
    const err = e as Error & { stderr?: Buffer | string };
    throw new Error(`could not generate the writer conformance workspace: ${err.message}${err.stderr ? `\n${String(err.stderr)}` : ""}`);
  }
}

/** The actions to exercise and the ones skipped, from `actions`. Throws on a name that is not a write-contract action. */
export function selectActions(actions?: readonly WriteContractAction[]): { checked: WriteContractAction[]; skipped: WriteContractAction[] } {
  if (actions === undefined) return { checked: [...WRITE_CONTRACT_ACTIONS], skipped: [] };
  const unknown = actions.filter((a) => !(WRITE_CONTRACT_ACTIONS as readonly string[]).includes(a));
  if (unknown.length > 0) throw new Error(`not write-contract actions: ${unknown.join(", ")}; the actions are ${WRITE_CONTRACT_ACTIONS.join(", ")}`);
  if (actions.length === 0) throw new Error("actions is empty; list at least one write-contract action");
  return { checked: WRITE_CONTRACT_ACTIONS.filter((a) => actions.includes(a)), skipped: WRITE_CONTRACT_ACTIONS.filter((a) => !actions.includes(a)) };
}

/** Every file under `dir`, from it, with / separators. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, prefix: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(at, e.name), rel);
      else out.push(rel);
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return out.sort();
}

/** The files in the state directory that `privateState` does not declare, and problems with the declaration itself. */
export function undeclaredState(files: readonly string[], privateState: readonly PrivateStatePath[]): string[] {
  const problems: string[] = [];
  for (const p of privateState) {
    const is = typeof p.is === "string" ? [p.is] : [...p.is];
    const wrong = is.filter((c) => !(PRIVATE_STATE_CATEGORIES as readonly string[]).includes(c));
    if (is.length === 0 || wrong.length > 0) problems.push(`state: ${p.path} is declared as ${JSON.stringify(p.is)}; private state is ${PRIVATE_STATE_CATEGORIES.join(", ")} (ws-074)`);
  }
  const declared = (f: string) => privateState.some((p) => f === p.path || f.startsWith(`${p.path.replace(/\/+$/, "")}/`));
  const loose = files.filter((f) => !declared(f));
  if (loose.length > 0) problems.push(`state: the writer keeps ${loose.join(", ")} in its state directory, and privateState does not declare it`);
  return problems;
}

/** A short JSON rendering of a value for a problem message. */
function brief(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 400 ? `${s.slice(0, 400)}...` : s;
}

/**
 * Hold a writer to the write contract, with no test runner: drive
 * {@link WRITER_SCRIPT} through it on a generated workspace, check each step,
 * then the amnesia test and what the writer holds, and return what is wrong.
 * The writer conforms when `problems` is empty.
 *
 * ```js
 * import { test } from "node:test";
 * import assert from "node:assert/strict";
 * import { runWorkspaceWriterConformance } from "@intentius/chant/workspace/conformance";
 *
 * test("my writer writes only through chant", { timeout: 600_000 }, async () => {
 *   const report = await runWorkspaceWriterConformance(myWriter, {
 *     actions: ["records review", "points answer"],
 *     privateState: [{ path: "events.db", is: "cache" }],
 *   });
 *   assert.deepEqual(report.problems, []);
 * });
 * ```
 */
export async function runWorkspaceWriterConformance(writer: WorkspaceWriterFactory, options: WorkspaceWriterConformanceOptions = {}): Promise<WorkspaceWriterConformanceReport> {
  const { checked, skipped } = selectActions(options.actions);
  const chantCommand = options.chantCommand ?? defaultChantCommand();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const privateState = options.privateState ?? [];
  const ws = createWriterConformanceWorkspace({ chantCommand, timeoutMs });
  const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "chant-writer-state-")));
  const inputsDir = realpathSync(mkdtempSync(join(tmpdir(), "chant-writer-inputs-")));
  const inputs = writeWriterInputs(inputsDir);
  const calls: ChantRun[] = [];
  const transport: ChantTransport = {
    async run(argv, opts) {
      const run = await runChant(chantCommand, [...argv], ws.dir, timeoutMs, opts?.input);
      calls.push(run);
      return run;
    },
  };
  const direct = async (argv: string[], input?: string): Promise<Record<string, unknown>> => {
    const run = await runChant(chantCommand, argv, ws.dir, timeoutMs, input);
    try {
      return JSON.parse(run.stdout) as Record<string, unknown>;
    } catch {
      throw new Error(`chant ${argv.join(" ")} printed no JSON (exit ${run.status}): ${run.stderr.trim()}`);
    }
  };
  const after = { facts: [] as string[], state: [] as string[], amnesia: [] as string[], holds: [] as string[], readBack: [] as string[], concurrent: [] as string[] };
  const facts: { before: unknown; after: unknown } = { before: undefined, after: undefined };
  const results: WriterStepResult[] = [];
  try {
    let built = writer(transport, { stateDir });
    const done: Record<string, Record<string, unknown>> = {};
    for (const s of WRITER_SCRIPT) {
      const st = buildStep(s, done, inputs);
      if (!checked.includes(st.action)) {
        const doc = await direct(["workspace", ...st.action.split(" "), ...st.args, ...WRITE_CONTRACT_JSON_FLAGS[st.action][0]], st.input);
        done[st.id] = doc;
        const no = (doc.error ?? doc.refused) as { code?: string; message?: string } | undefined;
        results.push({ id: st.id, action: st.action, by: "suite", args: st.args, problems: no ? [`${st.id} (${st.action}): the suite's own write failed: ${no.code}: ${no.message}`] : [] });
        continue;
      }
      const files = { before: worktreeDigest(ws.dir), after: {} as Record<string, string> };
      const refs = { before: gitRefs(ws.dir), after: {} as Record<string, string> };
      calls.length = 0;
      let doc: unknown;
      let problems: string[];
      try {
        doc = await built.write(st);
        problems = writerCallProblems(st, calls);
        if (problems.length === 0) problems = writerDocumentProblems(st, calls[0], doc);
      } catch (e) {
        const stderr = calls[0]?.stderr.trim();
        problems = [`${st.id} (${st.action}): the writer threw: ${(e as Error).message}${stderr ? `; chant's stderr: ${stderr}` : ""}`];
      }
      files.after = worktreeDigest(ws.dir);
      refs.after = gitRefs(ws.dir);
      // What chant printed is what the later steps build on, whatever the writer returned.
      const printed = calls.length === 1 ? (() => { try { return JSON.parse(calls[0].stdout) as Record<string, unknown>; } catch { return undefined; } })() : undefined;
      done[st.id] = printed ?? ((doc ?? {}) as Record<string, unknown>);
      problems.push(...unreportedChanges(st, done[st.id], files, refs));
      results.push({ id: st.id, action: st.action, by: "writer", args: st.args, problems });
    }

    // Concurrent writes (#3173): three amendments of one record at once, each from the digest read.
    if (checked.includes("records amend")) {
      after.concurrent.push(...(await concurrentAmends(built, calls, direct, String(done.decision?.id ?? ""), ws.dir)));
    }

    // What the writer shows, read only through the read contract.
    const readFacts = async (w: WorkspaceWriter, when: string): Promise<unknown> => {
      const files = worktreeDigest(ws.dir);
      const refs = gitRefs(ws.dir);
      calls.length = 0;
      let value: unknown;
      try {
        value = await w.facts();
      } catch (e) {
        after.facts.push(`facts: ${when}, facts() threw: ${(e as Error).message}`);
      }
      const writes = calls.filter((c) => !isReadCall(c.argv));
      if (writes.length > 0) after.facts.push(`facts: ${when}, facts() made calls outside the read contract: ${writes.map((c) => c.argv.join(" ")).join("; ")}`);
      const changed = treeChanges(files, worktreeDigest(ws.dir));
      if (changed.length > 0) after.facts.push(`facts: ${when}, facts() changed files: ${changed.join(", ")}`);
      const refsChanged = Object.keys(refChanges(refs, gitRefs(ws.dir)));
      if (refsChanged.length > 0) after.facts.push(`facts: ${when}, facts() changed git refs: ${refsChanged.join(", ")}`);
      return value;
    };
    facts.before = await readFacts(built, "before amnesia");
    if (facts.before === undefined || facts.before === null) after.facts.push("facts: facts() returned nothing; it returns the facts the tool shows, read the way the tool reads them");

    // What the writer holds: each fact in the repo, or one of the four exceptions.
    if (built.holds) {
      let held: readonly HeldItem[] = [];
      try {
        held = await built.holds();
      } catch (e) {
        after.holds.push(`holds: holds() threw: ${(e as Error).message}`);
      }
      const records = new Map<string, Set<string>>();
      const recordIds = async (kind: string) => {
        if (!records.has(kind)) {
          const doc = await direct(["workspace", "records", "--kind", kind, "--json"]);
          records.set(kind, new Set(((doc.records ?? []) as { id: string }[]).map((r) => r.id)));
        }
        return records.get(kind)!;
      };
      let runIds: Set<string> | undefined;
      for (const h of held) {
        if ("record" in h) {
          if (!(await recordIds(h.kind)).has(h.record)) after.holds.push(`holds: the writer holds record ${h.record} of ${h.kind}, which the repository does not have`);
        } else if ("run" in h) {
          runIds ??= new Set(((await direct(["workspace", "runs", "--json"])).runs as { id: string }[] | undefined ?? []).map((r) => r.id));
          if (!runIds.has(h.run)) after.holds.push(`holds: the writer holds run ${h.run}, which the run ledger does not have`);
        } else if ("lease" in h) {
          const doc = await direct(["workspace", "work", "history", h.lease, "--kind", h.kind, "--json"]);
          if (!Array.isArray(doc.claims) || doc.claims.length === 0) after.holds.push(`holds: the writer holds a lease on ${h.lease}, which has no lease history`);
        } else if ("exempt" in h) {
          if (!(PRIVATE_STATE_CATEGORIES as readonly string[]).includes(h.exempt)) after.holds.push(`holds: ${h.what} is held as ${JSON.stringify(h.exempt)}; outside the repo a tool keeps only ${PRIVATE_STATE_CATEGORIES.join(", ")} (ws-074)`);
        } else {
          after.holds.push(`holds: ${brief(h)} is not a record, run, lease or exemption`);
        }
      }
    }

    // Amnesia: close the writer, delete its state, build it again, and ask again.
    try {
      await built.close?.();
    } catch (e) {
      after.amnesia.push(`amnesia: close() threw: ${(e as Error).message}`);
    }
    after.state.push(...undeclaredState(filesUnder(stateDir), privateState));
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
    built = writer(transport, { stateDir });
    facts.after = await readFacts(built, "after amnesia");
    if (!isDeepStrictEqual(facts.before, facts.after)) {
      after.amnesia.push(`amnesia: after its private state was deleted, the writer shows other facts; before: ${brief(facts.before)}; after: ${brief(facts.after)}`);
    }
    try {
      await built.close?.();
    } catch {
      // Closed again after the comparison; a failure here is not the writer's contract.
    }

    // Every fact the script produced, read back through the read contract.
    const uncommitted = new Map<string, Map<string, string>>();
    for (const kind of Object.values(WRITER_KINDS)) {
      const doc = await direct(["workspace", "records", "--uncommitted", "--kind", kind, "--json"]);
      uncommitted.set(kind, new Map(((doc.records ?? []) as { id: string; worktree: string }[]).map((r) => [r.id, r.worktree])));
    }
    const runs = new Map(((await direct(["workspace", "runs", "--json"])).runs as { id: string; state: string }[] | undefined ?? []).map((r) => [r.id, r.state]));
    const history = await direct(["workspace", "work", "history", "W-001", "--kind", WRITER_KINDS.work, "--json"]);
    const listings = await readListing((argv) => runChant(chantCommand, argv, ws.dir, timeoutMs));
    const claims = (history.claims ?? []) as { token: string; ended: string | null; release?: { outcome?: string } | null }[];
    for (const s of WRITER_SCRIPT) {
      const doc = done[s.id] ?? {};
      if (s.action.startsWith("records ") || s.action.startsWith("points ")) {
        const kind = String((doc.kind as { file?: unknown } | undefined)?.file ?? "");
        const id = String(doc.id ?? "");
        if (!uncommitted.get(kind)?.has(id)) after.readBack.push(`read back: ${s.id} (${s.action}) wrote ${id}, and records --uncommitted --kind ${kind} does not list it`);
      } else if (s.action === "work evidence") {
        if (!uncommitted.get(WRITER_KINDS.work)?.has(String(doc.item ?? ""))) after.readBack.push(`read back: ${s.id} (${s.action}) amended ${String(doc.item)}, and records --uncommitted does not list it`);
      } else if (s.action.startsWith("work ")) {
        const token = String((doc.lease as { token?: unknown } | undefined)?.token ?? "");
        const claim = claims.find((c) => c.token === token);
        if (!claim) after.readBack.push(`read back: ${s.id} (${s.action}) wrote a lease with token ${token}, and work history does not list it`);
        else if (s.action === "work release" && claim.release?.outcome !== "done") after.readBack.push(`read back: ${s.id} (${s.action}) released the lease as done, and work history says ${brief(claim.release)}`);
      } else if (s.action.startsWith("runs ")) {
        const id = String((doc.run as { id?: unknown } | undefined)?.id ?? "");
        const want = s.action === "runs start" ? undefined : "ended";
        if (!runs.has(id)) after.readBack.push(`read back: ${s.id} (${s.action}) wrote run ${id}, and runs does not list it`);
        else if (want && runs.get(id) !== want) after.readBack.push(`read back: ${s.id} (${s.action}) ended run ${id}, and runs says it is ${runs.get(id)}`);
      } else if (s.action === "box listing set") {
        const member = String(doc.member ?? "");
        if (!isDeepStrictEqual(listings[member], doc.listing)) after.readBack.push(`read back: ${s.id} (${s.action}) set ${member}'s listing to ${brief(doc.listing)}, and status --json says ${brief(listings[member] ?? null)}`);
      }
    }

    const problems = [...results.flatMap((r) => r.problems), ...after.concurrent, ...after.facts, ...after.state, ...after.amnesia, ...after.holds, ...after.readBack];
    return { problems, checked, skipped, results, after, facts, workspaceDir: ws.dir };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(inputsDir, { recursive: true, force: true });
    ws.dispose();
  }
}

/**
 * The concurrent case (#3173, ws-089): the writer makes the three
 * {@link CONCURRENT_AMENDS} of record `id` at once, each from the digest the
 * suite read. Exactly one is written and the others are refused with
 * record-conflict naming its digest; each is then retried from the digest
 * its refusal named, and written. Returns the problems, each starting
 * `concurrent:`.
 */
export async function concurrentAmends(
  built: WorkspaceWriter,
  calls: ChantRun[],
  direct: (argv: string[], input?: string) => Promise<Record<string, unknown>>,
  id: string,
  dir: string,
): Promise<string[]> {
  const problems: string[] = [];
  const digestOf = async (): Promise<{ digest: string; path: string } | undefined> => {
    const doc = await direct(["workspace", "records", "--kind", WRITER_KINDS.decision, "--json"]);
    const r = ((doc.records ?? []) as { id: string; digest: string; path: string }[]).find((x) => x.id === id);
    return r ? { digest: r.digest, path: r.path } : undefined;
  };
  const start = await digestOf();
  if (!start) return [`concurrent: the script's decision ${id || "(none)"} can't be read back to amend`];
  const files = { before: worktreeDigest(dir), after: {} as Record<string, string> };
  const refs = { before: gitRefs(dir), after: {} as Record<string, string> };
  const steps = CONCURRENT_AMENDS.map((c) => concurrentAmendStep(c, id, start.digest));
  calls.length = 0;
  const docs = await Promise.all(
    steps.map(async (st) => {
      try {
        return { st, doc: await built.write(st) };
      } catch (e) {
        problems.push(`concurrent: ${st.id} (${st.action}): the writer threw: ${(e as Error).message}`);
        return { st, doc: undefined };
      }
    }),
  );
  // Each step's call: the one that gave chant its fields.
  const printed = new Map<string, Record<string, unknown> | undefined>();
  for (const { st, doc } of docs) {
    const mine = calls.filter((c) => c.input !== undefined && st.input !== undefined && isDeepStrictEqual(safeJson(c.input), JSON.parse(st.input)));
    const callProblems = writerCallProblems(st, mine);
    if (callProblems.length > 0) {
      problems.push(...callProblems.map((p) => `concurrent: ${p}`));
      continue;
    }
    const out = safeJson(mine[0].stdout) as Record<string, unknown> | undefined;
    printed.set(st.id, out);
    if (!isDeepStrictEqual(doc, out)) problems.push(`concurrent: ${st.id} (${st.action}): the writer must return the document chant printed, unchanged, refusal included, and it returned something else`);
    const { validate } = writeContractSchema(st.action);
    if (!validate(out)) problems.push(`concurrent: ${st.id} (${st.action}): the document does not validate against ${WRITE_CONTRACT_SCHEMAS[st.action]}: ${JSON.stringify(validate.errors)}`);
  }
  if (problems.length > 0) return problems;
  const won = steps.filter((st) => printed.get(st.id)?.error === undefined);
  const lost = steps.filter((st) => printed.get(st.id)?.error !== undefined);
  if (won.length !== 1) {
    problems.push(`concurrent: ${won.length} of the three amendments from digest ${start.digest} were written (${won.map((s) => s.id).join(", ") || "none"}); exactly one may be`);
    return problems;
  }
  const d1 = String(printed.get(won[0].id)?.digest ?? "");
  for (const st of lost) {
    const doc = printed.get(st.id)!;
    const code = (doc.error as { code?: string }).code;
    const conflict = doc.conflict as { digest?: string; expected?: string } | undefined;
    if (code !== "record-conflict") problems.push(`concurrent: ${st.id} was refused with ${code}, not record-conflict`);
    else if (conflict?.digest !== d1 || conflict?.expected !== start.digest) problems.push(`concurrent: ${st.id}'s conflict names ${brief(conflict)}, not expected ${start.digest} and digest ${d1}`);
  }
  files.after = worktreeDigest(dir);
  refs.after = gitRefs(dir);
  const changed = treeChanges(files.before, files.after).filter((c) => c.replace(/ \((added|changed|removed)\)$/, "") !== start.path);
  if (changed.length > 0) problems.push(`concurrent: files changed that chant did not report writing: ${changed.join(", ")}`);
  if (Object.keys(refChanges(refs.before, refs.after)).length > 0) problems.push(`concurrent: git refs changed: ${Object.keys(refChanges(refs.before, refs.after)).join(", ")}`);
  if (problems.length > 0) return problems;
  // Each loser retries from the digest it was told, one after the other.
  let digest = d1;
  for (const st of lost) {
    const retry = concurrentAmendStep(CONCURRENT_AMENDS.find((c) => c.id === st.id)!, id, digest);
    calls.length = 0;
    let doc: unknown;
    try {
      doc = await built.write(retry);
    } catch (e) {
      problems.push(`concurrent: ${st.id}'s retry: the writer threw: ${(e as Error).message}`);
      continue;
    }
    const p = writerCallProblems({ ...retry, id: `${st.id} retry` } as WriteStep, calls);
    if (p.length > 0) {
      problems.push(...p.map((x) => `concurrent: ${x}`));
      continue;
    }
    const out = safeJson(calls[0].stdout) as Record<string, unknown> | undefined;
    if (out?.error !== undefined) {
      problems.push(`concurrent: ${st.id}'s retry from ${digest} was refused: ${brief(out.error)}`);
      continue;
    }
    if (!isDeepStrictEqual(doc, out)) problems.push(`concurrent: ${st.id}'s retry: the writer must return the document chant printed, unchanged`);
    digest = String(out?.digest ?? "");
  }
  const end = await digestOf();
  if (problems.length === 0 && end?.digest !== digest) problems.push(`concurrent: after the retries records --json gives ${id} digest ${end?.digest}, and the last retry printed ${digest}`);
  return problems;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
