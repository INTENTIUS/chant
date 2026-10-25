/**
 * `chant workspace drift [dir] --member <name> [--read <read>] [--resource
 * <addr>] [--env <env>] [--stream] [-o <file>]` (behold#995): one member's
 * drift, read by the engine that owns it, as chant's drift record
 * (`../drift-record.ts`, #4451).
 *
 * The read is the member kind's:
 *
 * | kind | default read | how |
 * |---|---|---|
 * | `chant` | `live-read` | the member's `chant lifecycle diff <env> --live --json`, through `liveDiffDriftRecords` and, when a lexicon has a deep reader, `mergeDeepDrift`. `--components` adds `chant components status <env> --live --json` through `componentStatusDriftRecords`. Needs `--env` |
 * | `terraform` | `state` | `chant lifecycle drift` in the member's reader project: the terraform lexicon's `readDrift`, `terraform show -json` over state, or `--read plan` for a saved plan's `show -json` |
 * | `choudoufu` | `ownership` | the same, through `choudoufu live-plan -json` (and `live-ls`), or `--read plan` for live-plan with a plan beside it; `--resource <addr>` passes `choudoufu live-plan -resource=<addr>`'s stream through |
 *
 * Any other kind has no drift read and answers `no-drift-read`. A member of
 * a package's kind runs in the reader project `workspace graph` writes for it
 * (`./kind-readers.ts`), under the member's own toolchain, so chant core
 * never imports the lexicon.
 *
 * Every record's `node` is placed on the member's source graph with the
 * change set's rule (`mapDriftToGraph`, `graphNodeFor`), the graph read the
 * way `workspace graph --member <name>` reads it, from the per-member cache
 * when the source has not moved. A graph that can't be read leaves `node`
 * null; the drift still prints.
 *
 * Without `--stream` it prints one drift document with the read contract's
 * head beside it (`contract`, `chant`), and with `error: {code, message}`
 * and no records when the read could not run. With `--stream` it prints the
 * NDJSON stream, decoded and re-encoded with C1's codec: a `drift-start`,
 * the records and a `drift-settle` per read (for a chant member chant writes
 * the start and settle itself around the diff's records). A failed read
 * prints nothing on stdout in stream mode and says why on stderr.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext, ParsedArgs } from "../cli/registry";
import { graphNodeFor, type ChangeSetGraphNodes } from "../change-set-graph";
import {
  componentStatusDriftRecords,
  countDriftStatuses,
  decodeDriftLines,
  deepDiffDriftRecords,
  DRIFT_READS,
  DRIFT_SCHEMA_ID,
  DRIFT_VERSION,
  driftExpected,
  driftRecordLine,
  driftSettle,
  driftStart,
  encodeDriftLines,
  foldDriftLines,
  liveDiffDriftRecords,
  mergeDeepDrift,
  type DriftDocument,
  type DriftLine,
  type DriftRead,
  type DriftRecord,
} from "../drift-record";
import type { DeepDiffResult } from "../lifecycle/deep-diff";
import type { LiveDiffResult } from "../lifecycle/live-diff";
import type { ComponentStatusRow } from "../lifecycle/status";
import { readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError } from "./declaration";
import { prepareKindReaders } from "./kind-readers";
import { loadKindRegistry } from "./kinds";
import { emitDocument, executePlan, planMembers, type UnitResult } from "./member-commands";
import { handToRootChant, locateWorkspace } from "./which-chant";

/** The version of the read contract the document is written under. */
export const DRIFT_CONTRACT_VERSION = 1;

/** Why a drift read could not run: the declaration's codes, and the read's own. */
export const DRIFT_ERROR_CODES = [
  ...WORKSPACE_ERROR_CODES,
  /** No `--member`, or more than one. */
  "member-required",
  /** The member's kind has no drift read (`other`, `app`, a nested workspace, ...). */
  "no-drift-read",
  /** The read is not one the member's engine has, such as `state` on a chant member. */
  "read-unsupported",
  /** `--resource` on an engine that cannot read one resource on its own. */
  "resource-unsupported",
  /** A chant member's live read needs an environment. */
  "env-required",
  /** The member's command failed, or printed something that is not drift. */
  "command-failed",
] as const;
export type DriftErrorCode = (typeof DRIFT_ERROR_CODES)[number];

/** The reads each member kind answers, the first its default. A kind not here has no drift read. */
export const DRIFT_READS_BY_KIND: Record<string, readonly DriftRead[]> = {
  chant: ["live-read"],
  terraform: ["state", "plan"],
  choudoufu: ["ownership", "plan"],
};

/** The exit status `chant lifecycle drift` gives a refused read (`../cli/handlers/lifecycle-drift.ts`). */
const MEMBER_REFUSED_EXIT = 3;

const USAGE =
  "chant workspace drift [dir] --member <name> [--read <state|plan|refresh|live-read|ownership>] [--resource <addr>] [--env <env>] [--components] [--stream] [-o <file>]";

/** The document `workspace drift` prints: a drift document with the read contract's head. */
export type WorkspaceDriftDocument = DriftDocument & {
  contract: number;
  chant: string;
  /** The member read. */
  member?: string;
  error?: { code: DriftErrorCode; message: string };
};

export interface DriftQuery {
  cwd: string;
  member: string;
  read?: string;
  resource?: string;
  env?: string;
  components?: boolean;
}

export type DriftReadResult = { lines: DriftLine[] } | { error: { code: DriftErrorCode; message: string } };

class DriftReadFailure extends Error {
  constructor(
    readonly code: DriftErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function tail(text: string): string {
  return text.trim().split("\n").slice(-5).join("\n");
}

/** The member's node ids, without the member in front, from its source graph; null when it can't be read. */
async function memberGraph(cwd: string, member: string): Promise<ChangeSetGraphNodes | null> {
  try {
    const { workspaceGraph } = await import("./graph-cli");
    const { doc } = await workspaceGraph({ cwd, members: [member] });
    if ("error" in doc) return null;
    const entry = doc.members.find((m) => m.name === member);
    if (!entry || entry.status !== "composed") return null;
    const prefix = `${member}/`;
    const ids = doc.nodes.filter((n) => n.member === member && n.id.startsWith(prefix)).map((n) => n.id.slice(prefix.length));
    return { member, at: doc.at, ids };
  } catch {
    return null;
  }
}

/** A record placed on the member's graph by the change set's rule; a URN stays null. */
function place(record: DriftRecord, graph: ChangeSetGraphNodes | null): DriftRecord {
  const engine = record.engine;
  if (graph === null || engine === "pulumi" || engine === "plunge") return record;
  const { instanceOf: _i, ...r } = record;
  const placed = graphNodeFor({ member: r.member, planner: engine, address: r.address }, graph);
  return { ...r, node: placed.node, ...(placed.instanceOf !== undefined ? { instanceOf: placed.instanceOf } : {}) };
}

/** Every line with the workspace's member name and its node placed. An engine that names its own estate (choudoufu) is renamed. */
function placeLines(lines: DriftLine[], member: string, graph: ChangeSetGraphNodes | null): DriftLine[] {
  return lines.map((line) => {
    if (line.type === "drift-record") {
      const { type: _t, ...record } = line;
      return driftRecordLine(place({ ...record, member }, graph));
    }
    if (line.type === "drift-start") {
      const engine = line.engine;
      const expected = driftExpected(line).map((e) => {
        if (graph === null || engine === "pulumi" || engine === "plunge") return e;
        const placed = graphNodeFor({ member, planner: engine, address: e.address }, graph);
        return { ...e, node: placed.node, ...(placed.instanceOf !== undefined ? { instanceOf: placed.instanceOf } : {}) };
      });
      return { ...line, member, expected };
    }
    return { ...line, member };
  });
}

/** A chant member's records, from `lifecycle diff --live --json` (and `components status --live --json`). */
function chantRecords(member: string, diffOut: string, componentsOut: string | undefined, observedAt: string, version: string | undefined): DriftRecord[] {
  let doc: { lexicons?: Record<string, LexiconDiff>; stacks?: Record<string, Record<string, LexiconDiff>> };
  try {
    doc = JSON.parse(diffOut) as typeof doc;
  } catch (err) {
    throw new DriftReadFailure("command-failed", `chant lifecycle diff --live --json printed something that is not JSON: ${(err as Error).message}`);
  }
  const lexicons: LexiconDiff[] = [...Object.values(doc.lexicons ?? {}), ...Object.values(doc.stacks ?? {}).flatMap((s) => Object.values(s))];
  const base = { member, observedAt, ...(version ? { version } : {}) };
  const out: DriftRecord[] = [];
  for (const lex of lexicons) {
    if (!lex.resources) continue;
    const types: Record<string, string> = {};
    for (const [name, meta] of Object.entries(lex.observed ?? {})) if (typeof meta?.type === "string") types[name] = meta.type;
    const thin = liveDiffDriftRecords({ ...base, diff: lex.resources, types });
    out.push(...(lex.deep ? mergeDeepDrift(thin, deepDiffDriftRecords({ ...base, diff: lex.deep })) : thin));
  }
  if (componentsOut !== undefined) {
    let rows: ComponentStatusRow[];
    try {
      rows = JSON.parse(componentsOut) as ComponentStatusRow[];
    } catch (err) {
      throw new DriftReadFailure("command-failed", `chant components status --live --json printed something that is not JSON: ${(err as Error).message}`);
    }
    if (Array.isArray(rows)) out.push(...componentStatusDriftRecords({ ...base, rows }));
  }
  return out;
}

interface LexiconDiff {
  resources?: LiveDiffResult;
  observed?: Record<string, { type?: unknown }>;
  deep?: DeepDiffResult;
}

/** The command line the member runs. */
function memberArgv(kind: string, query: DriftQuery, read: DriftRead): string[] {
  if (kind === "chant") return ["lifecycle", "diff", query.env!, "--live", "--json"];
  return ["lifecycle", "drift", ".", "--member", query.member, "--read", read, ...(query.resource !== undefined ? ["--resource", query.resource] : [])];
}

/**
 * Read one member's drift and return the stream lines, placed on its graph.
 * Never throws a {@link WorkspaceReadError}: a failure is `error`.
 */
export async function readWorkspaceDrift(query: DriftQuery): Promise<DriftReadResult> {
  let cleanup: (() => void) | undefined;
  try {
    const located = locateWorkspace(query.cwd);
    const declaration = readDeclaration(located.tree, "", { rootChant: true });
    const entry = declaration.members.find((m) => m.name === query.member);
    if (!entry) {
      throw new DriftReadFailure("member-required", `--member ${query.member} is not a member of ${declaration.name}; it declares ${declaration.members.map((m) => m.name).join(", ")}`);
    }
    const reads = DRIFT_READS_BY_KIND[entry.kind];
    if (!reads) throw new DriftReadFailure("no-drift-read", `${query.member} is kind ${entry.kind}, and chant workspace drift reads members of kind ${Object.keys(DRIFT_READS_BY_KIND).join(", ")}`);
    if (query.read !== undefined && !(DRIFT_READS as readonly string[]).includes(query.read)) {
      throw new DriftReadFailure("read-unsupported", `--read ${query.read} is not a drift read; the reads are ${DRIFT_READS.join(", ")}`);
    }
    const read = (query.read ?? reads[0]) as DriftRead;
    if (!reads.includes(read)) throw new DriftReadFailure("read-unsupported", `a ${entry.kind} member answers ${reads.join(" or ")}, not --read ${read}`);
    if (query.resource !== undefined && entry.kind !== "choudoufu") {
      throw new DriftReadFailure("resource-unsupported", `--resource reads one resource through choudoufu live-plan -resource; ${query.member} is kind ${entry.kind}`);
    }
    if (entry.kind === "chant" && !query.env) throw new DriftReadFailure("env-required", `${query.member} is a chant member, read live through chant lifecycle diff <env> --live: add --env <env>`);

    const { registry: kinds, problems } = loadKindRegistry(declaration.pins, located.rootOnDisk);
    const plan = planMembers("graph", located.rootOnDisk, { only: [query.member], tree: located.tree, kinds, kindProblems: problems.map((p) => p.message) });
    const notRun = [...plan.unreadable, ...plan.skipped].find((s) => s.name === query.member);
    if (notRun) throw new DriftReadFailure(plan.unreadable.includes(notRun) ? "command-failed" : "no-drift-read", `${query.member}: ${notRun.reason.code}: ${notRun.reason.message}`);
    const readers = prepareKindReaders(plan, located.rootOnDisk);
    cleanup = readers.cleanup;
    const failedReader = readers.failed.find((f) => f.name === query.member);
    if (failedReader) throw new DriftReadFailure("command-failed", `${query.member}: ${failedReader.reason.message}`);

    const args = {} as ParsedArgs;
    const [graph, results, components] = await Promise.all([
      memberGraph(query.cwd, query.member),
      executePlan(plan, args, () => memberArgv(entry.kind, query, read)),
      entry.kind === "chant" && query.components ? executePlan(plan, args, () => ["components", "status", query.env!, "--live", "--json"]) : Promise.resolve(undefined),
    ]);
    const result: UnitResult | undefined = results.find((r) => r.member === query.member);
    if (!result) throw new DriftReadFailure("command-failed", `${query.member} did not run`);
    if (result.stderr.trim()) process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
    const observedAt = result.finishedAt ?? new Date().toISOString();

    if (entry.kind === "chant") {
      if (result.exitCode !== 0) throw new DriftReadFailure("command-failed", `chant lifecycle diff ${query.env} --live exited ${result.exitCode}${tail(result.stderr) ? `: ${tail(result.stderr)}` : ""}`);
      const comp = components?.find((r) => r.member === query.member);
      if (comp && comp.exitCode !== 0) throw new DriftReadFailure("command-failed", `chant components status ${query.env} --live exited ${comp.exitCode}${tail(comp.stderr) ? `: ${tail(comp.stderr)}` : ""}`);
      const records = chantRecords(query.member, result.stdout, comp?.stdout, observedAt, result.chant ?? undefined).map((r) => place(r, graph));
      const start = driftStart({ member: query.member, engine: "chant", read, at: observedAt, expected: records.map((r) => ({ address: r.address, node: r.node, ...(r.instanceOf ? { instanceOf: r.instanceOf } : {}) })), evidence: { tool: "chant", command: "chant lifecycle diff --live" } });
      const settled = driftSettle(start, records, observedAt);
      return { lines: [start, ...settled.records.map(driftRecordLine), settled.line] };
    }

    if (result.exitCode === MEMBER_REFUSED_EXIT) {
      let refused: { code?: string; message?: string } | undefined;
      try {
        refused = (JSON.parse(result.stdout.trim().split("\n").pop() ?? "") as { refused?: { code?: string; message?: string } }).refused;
      } catch {
        refused = undefined;
      }
      if (refused) {
        const code = (DRIFT_ERROR_CODES as readonly string[]).includes(refused.code ?? "") ? (refused.code as DriftErrorCode) : "command-failed";
        throw new DriftReadFailure(code, `${query.member}: ${refused.message ?? refused.code}`);
      }
    }
    if (result.exitCode !== 0) {
      throw new DriftReadFailure("command-failed", `chant lifecycle drift in ${query.member}'s reader project exited ${result.exitCode}${tail(result.stderr) ? `: ${tail(result.stderr)}` : ""}`);
    }
    let lines: DriftLine[];
    try {
      lines = decodeDriftLines(result.stdout);
    } catch (err) {
      throw new DriftReadFailure("command-failed", `chant lifecycle drift in ${query.member}'s reader project printed a line that is not drift: ${(err as Error).message}`);
    }
    return { lines: placeLines(lines, query.member, graph) };
  } catch (err) {
    if (err instanceof DriftReadFailure) return { error: { code: err.code, message: err.message } };
    if (err instanceof WorkspaceReadError) return { error: { code: err.code, message: err.message } };
    throw err;
  } finally {
    cleanup?.();
  }
}

/** The document for a read: the folded stream, or an empty one carrying the error. */
export function driftReadDocument(member: string, result: DriftReadResult): WorkspaceDriftDocument {
  const chant = readerVersion();
  const head = { contract: DRIFT_CONTRACT_VERSION, chant, ...(member ? { member } : {}) };
  if ("error" in result) {
    return { $schema: DRIFT_SCHEMA_ID, drift: DRIFT_VERSION, ...head, records: [], counts: countDriftStatuses([]), error: result.error };
  }
  const { document } = foldDriftLines(result.lines, { chant });
  return { ...document, ...head };
}

export async function runWorkspaceDrift(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const cwd = resolve(args.extraPositional ?? ".");
  if (!existsSync(cwd)) {
    console.error(formatError({ message: `${cwd} does not exist`, hint: USAGE }));
    return 1;
  }
  // The root's chant reads the declaration (ws-021).
  const handed = await handToRootChant(cwd, undefined);
  if (handed !== undefined) return handed;

  const members = args.members ?? [];
  const result: DriftReadResult =
    members.length !== 1
      ? { error: { code: "member-required", message: `chant workspace drift reads one member: --member <name>${members.length > 1 ? `, and it was given ${members.join(", ")}` : ""}` } }
      : await readWorkspaceDrift({
          cwd,
          member: members[0],
          ...(args.driftRead !== undefined ? { read: args.driftRead } : {}),
          ...(args.resource !== undefined ? { resource: args.resource } : {}),
          ...(args.env !== undefined ? { env: args.env } : {}),
          ...(args.components ? { components: true } : {}),
        });

  if ("error" in result) console.error(formatError({ message: `${result.error.code}: ${result.error.message}`, hint: USAGE }));
  if (args.stream) {
    if ("error" in result) return 1;
    const text = encodeDriftLines(result.lines);
    if (args.output) {
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(resolve(args.output)), { recursive: true });
      writeFileSync(resolve(args.output), text);
    } else process.stdout.write(text);
    return 0;
  }
  emitDocument(driftReadDocument(members[0] ?? "", result), args.output);
  return "error" in result ? 1 : 0;
}
