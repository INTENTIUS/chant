/**
 * `chant workspace graph [dir] [--at <rev>] [--member <name>] [--kind <kind file>]
 * [-o <file>] [--env <env>] [--dry-run]` (#2537, #2536): every `chant`
 * member's IR, read through the member's own toolchain and composed into one
 * document (`compose-graph.ts`). With `--kind`, the records of that kind and
 * their asset and constrains links join it (#2549, `record-assets.ts`).
 *
 * With `--intent <path[:start-end]>` it prints the intent graph over one
 * region instead (#2651, `intent.ts`), a document of its own in the read
 * contract. With `--composites` it prints each composite instance with the
 * components that can deploy it (#2662, `composites.ts`), another.
 *
 * The document is part of the read contract, described by `graph.schema.json`
 * beside this file. It is printed for a failure too, with the error's reason
 * code, so a reader always has JSON to parse.
 *
 * `--at <rev>` reads the declaration from git objects, as `ls --at` does. A
 * member's IR comes from running its chant config, so for `--at` the
 * workspace root's tree at that revision is exported to a temporary
 * directory with `git archive`, the `node_modules` directories installed in
 * the working tree are linked into it, and each member runs there under the
 * toolchain it resolves, which is the one installed now. Nothing touches the
 * checkout or the network. When no member needs running (a workspace with no
 * `chant` members, or `--dry-run`) nothing is exported.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext, ParsedArgs } from "../cli/registry";
import { composeWorkspaceGraph, readMemberIr, type ComposedMember, type ComposeInput, type WorkspaceGraph } from "./compose-graph";
import { openGraphCache, splitCached, storeReads, withoutUnits } from "./graph-cache";
import { readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError, type ErrorLocation } from "./declaration";
import { describePlan, emitDocument, executePlan, memberStatus, planJson, planMembers, type MemberPlan, type Toolchain, type UnitResult } from "./member-commands";
import { loadKindRegistry } from "./kinds";
import { prepareKindReaders, type PreparedReaders } from "./kind-readers";
import { recordLinkRows } from "./record-assets";
import { RecordReadError } from "./records";
import { workingTree } from "./tree";
import { handToRootChant, locateWorkspace, type LocatedWorkspace } from "./which-chant";

/** The version of the `graph` document this chant writes. */
export const GRAPH_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the document, shipped beside this file. */
export const GRAPH_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/graph/v1/graph.schema.json";

/**
 * Why the graph couldn't be read at all: the declaration's codes, `--at`'s
 * included, and `live-at-revision` for `--live` with `--at` (#2875).
 */
export const GRAPH_ERROR_CODES = [...WORKSPACE_ERROR_CODES, "live-at-revision"] as const;
export type GraphErrorCode = (typeof GRAPH_ERROR_CODES)[number];

/** Why `--live` and `--at` don't go together (#2875). */
const LIVE_AT_REVISION = "--live reads the account as it stands now, and --at reads the source at a revision; chant workspace graph takes one of them";

const USAGE =
  "chant workspace graph [dir] [--at <rev>] [--member <name>] [--kind <kind file>] [-o <file>] [--env <env>] [--live [--overlay] [--traffic <level>]] [--no-cache] [--dry-run] | chant workspace graph --composites [--at <rev>] [--member <name>] [-o <file>] | chant workspace graph --intent <path[:start-end]> [--at <rev>] [--kind <kind file>...] [--json]";

interface Head {
  $schema: string;
  contract: number;
  chant: string;
}

export type GraphDocument =
  | (Head & { at: string | null } & WorkspaceGraph)
  | (Head & { error: { code: GraphErrorCode; message: string; location: ErrorLocation | null } });

export interface GraphQuery {
  /** Where the walk up to the declaration starts. */
  cwd: string;
  at?: string;
  /** Only these members. */
  members?: string[];
  /** The flags each member's `chant graph` gets (`--env`, and `--live`, `--overlay` and `--traffic`, #2875). */
  args?: Partial<ParsedArgs>;
  /** The chant for members with none of their own; the running chant by default. */
  reader?: Toolchain;
  /** Called with each member's stderr, so the command can pass it on. */
  onStderr?: (text: string) => void;
  /**
   * A record kind file, absolute or relative to `cwd` (#2549). Its records
   * fill `records`, and their asset pins and `constrains` entries become
   * rows of `links`.
   */
  kind?: string;
  /**
   * Also run each member's `chant graph --components --format ir` (#2662),
   * under the same toolchain and at the same revision, and return the answers
   * in {@link GraphResult.components}. The document is unchanged.
   */
  components?: boolean;
  /**
   * Called once the members have run, with the directory they were read from
   * (the exported tree for `--at`, before it is removed) and the declared
   * members the read covers. `--composites` reads each member's runtimes
   * here (#2674).
   */
  inTree?: (root: string, members: readonly { name: string; dir: string; kind: string }[]) => Promise<void>;
  /** Read every member, leaving the per-member cache unread and unwritten (`--no-cache`, #2876). */
  noCache?: boolean;
}

export interface GraphResult {
  doc: GraphDocument;
  /** A member failed or couldn't be read, or the declaration couldn't be read. */
  failed: boolean;
  /** With {@link GraphQuery.components}: each member's component graph run, in plan order. */
  components?: UnitResult[];
}

/** The command line a member runs for its component graph (#2662). */
export function componentGraphArgv(args: Partial<ParsedArgs>): string[] {
  return ["graph", ".", "--components", "--format", "ir", ...(args.env ? ["--env", args.env] : [])];
}

/**
 * Export the workspace root's tree at `at` into a temporary directory and link
 * the working tree's `node_modules` into it, so members' configs resolve the
 * packages installed now. Returns the directory; the caller removes it.
 */
export function exportRevision(located: LocatedWorkspace, memberDirs: string[]): string {
  const { top, at, root, rootOnDisk } = located;
  if (!top || !at) throw new Error("exportRevision needs a revision");
  const scratch = mkdtempSync(join(tmpdir(), "chant-ws-at-"));
  const out = join(scratch, "root");
  const tar = join(scratch, "tree.tar");
  execFileSync("git", ["archive", "--format=tar", "-o", tar, root === "." ? at : `${at}:${root}`], { cwd: top, stdio: ["ignore", "ignore", "pipe"] });
  mkdirSync(out, { recursive: true });
  execFileSync("tar", ["-xf", tar, "-C", out], { stdio: ["ignore", "ignore", "pipe"] });
  rmSync(tar, { force: true });

  // Every directory from the root down to each member that runs, where an
  // install can sit: services/node_modules serves services/api and services/web.
  const dirs = new Set<string>([""]);
  for (const d of memberDirs) {
    if (d === ".") continue;
    const parts = d.split("/");
    for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  for (const d of dirs) {
    const src = join(rootOnDisk, ...d.split("/"), "node_modules");
    const dst = join(out, ...d.split("/"), "node_modules");
    if (existsSync(src) && existsSync(dirname(dst)) && !existsSync(dst)) symlinkSync(src, dst, "dir");
  }
  // A workspace root below the install (a monorepo package) resolves from above.
  if (!existsSync(join(out, "node_modules"))) {
    for (let dir = dirname(rootOnDisk); ; dir = dirname(dir)) {
      if (existsSync(join(dir, "node_modules"))) {
        symlinkSync(join(dir, "node_modules"), join(out, "node_modules"), "dir");
        break;
      }
      if (dirname(dir) === dir) break;
    }
  }
  return out;
}

function compose(
  plan: MemberPlan,
  results: UnitResult[],
  only: string[] | undefined,
  declarationMembers: { name: string; dir: string; kind: string }[],
  live = false,
): { inputs: ComposeInput[]; failed: boolean } {
  // A member that ran was read live when --live was given, and says when (#2875).
  const read = (member: ComposedMember, r: UnitResult): ComposedMember => {
    if (live) {
      member.live = true;
      if (r.finishedAt) member.readAt = r.finishedAt;
    }
    return member;
  };
  const byId = new Map(results.map((r) => [r.id, r]));
  const inputs: ComposeInput[] = [];
  let failed = plan.unreadable.length > 0;
  for (const m of declarationMembers) {
    if (only?.length && !only.includes(m.name)) continue;
    const r = byId.get(m.name);
    const skip = plan.skipped.find((s) => s.name === m.name) ?? plan.unreadable.find((s) => s.name === m.name);
    if (!r) {
      const status = plan.unreadable.some((s) => s.name === m.name) ? "failed" : "skipped";
      inputs.push({ member: memberStatus(m.name, m.dir, m.kind, status, skip?.reason ?? null, null) });
      continue;
    }
    if (r.exitCode !== 0) {
      failed = true;
      const tail = r.stderr.trim().split("\n").slice(-5).join("\n");
      inputs.push({ member: read(memberStatus(m.name, m.dir, m.kind, "failed", { code: "command-failed", message: `chant graph exited ${r.exitCode}${tail ? `: ${tail}` : ""}` }, r.chant), r) });
      continue;
    }
    const ir = readMemberIr(r.stdout);
    if ("reason" in ir) {
      failed = true;
      inputs.push({ member: read(memberStatus(m.name, m.dir, m.kind, "failed", ir.reason, r.chant), r) });
      continue;
    }
    const member = read(memberStatus(m.name, m.dir, m.kind, "composed", null, r.chant), r);
    member.irVersion = ir.irVersion;
    inputs.push({ member, ir: ir.ir });
  }
  return { inputs, failed };
}

/** Plan a graph read without running anything, for `--dry-run`. Throws a {@link WorkspaceReadError}. */
export function planGraph(query: GraphQuery): MemberPlan {
  const located = locateWorkspace(query.cwd, query.at);
  const declaration = readDeclaration(located.tree, "", { rootChant: true });
  const kinds = loadKindRegistry(declaration.pins, located.rootOnDisk).registry;
  return planMembers("graph", located.rootOnDisk, { only: query.members, reader: query.reader, tree: located.tree, kinds });
}

/** Read and compose the graph, and build the document. Never throws a {@link WorkspaceReadError}. */
export async function workspaceGraph(query: GraphQuery): Promise<GraphResult> {
  const head: Head = { $schema: GRAPH_OUTPUT_SCHEMA_ID, contract: GRAPH_CONTRACT_VERSION, chant: readerVersion() };
  let exported: string | undefined;
  let readers: PreparedReaders | undefined;
  if (query.args?.live && query.at !== undefined) {
    return { doc: { ...head, error: { code: "live-at-revision", message: LIVE_AT_REVISION, location: null } }, failed: true };
  }
  try {
    const located = locateWorkspace(query.cwd, query.at);
    const declaration = readDeclaration(located.tree, "", { rootChant: true });
    // Kinds are read before planning: a package kind with a graph block runs (#2874).
    const kinds = loadKindRegistry(declaration.pins, located.rootOnDisk).registry;
    let plan = planMembers("graph", located.rootOnDisk, { only: query.members, reader: query.reader, tree: located.tree, kinds });
    const args = (query.args ?? {}) as ParsedArgs;
    // Members whose last source read still stands are answered from the cache (#2876).
    // A composites read runs every member's component graph as well, so it reads everything.
    const cache = query.noCache || query.components ? undefined : openGraphCache(located.rootOnDisk);
    const split = cache ? splitCached(plan, args, cache, located.at) : undefined;
    const served = new Set(split?.hits.map((h) => h.id));
    if (located.at !== null && withoutUnits(plan, served).groups.length > 0) {
      exported = exportRevision(located, withoutUnits(plan, served).groups.flatMap((g) => g.units.map((u) => u.dir)));
      plan = planMembers("graph", exported, { only: query.members, reader: query.reader, tree: workingTree(exported), kinds });
    }
    // Only the members that run get a reader project; a served member needs none.
    const toRun = withoutUnits(plan, served);
    readers = prepareKindReaders(toRun, exported ?? located.rootOnDisk);
    const [ran, components] = await Promise.all([
      executePlan(toRun, args),
      query.components ? executePlan(plan, args, () => componentGraphArgv(args)) : Promise.resolve(undefined),
    ]);
    if (cache && split) storeReads(split, ran, cache);
    const results = [...(split?.hits ?? []), ...ran];
    if (query.inTree) await query.inTree(exported ?? located.rootOnDisk, declaration.members.filter((m) => !query.members?.length || query.members.includes(m.name)));
    for (const r of components ?? []) if (r.stderr.trim() && query.onStderr) query.onStderr(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    for (const r of results) if (r.stderr.trim() && query.onStderr) query.onStderr(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    const { inputs, failed } = compose(plan, results, query.members, declaration.members, !!args.live);
    for (const { member } of inputs) {
      if (member.status !== "composed") continue;
      member.cached = served.has(member.name);
      member.stamp = split?.stamps.get(member.name) ?? null;
    }
    // Links (#2539) resolve against the declaration that was read, the revision's for --at, and the kinds installed now.
    const graph = composeWorkspaceGraph({ name: declaration.name, root: located.root }, inputs, { declaration, kinds });
    // Nested workspaces (#2551, ws-071): read-only, through their own chant workspace graph.
    const nestedFailed = await expandNested(graph, declaration.members, query, located.rootOnDisk, located.at);
    let recordsFailed = false;
    if (query.kind !== undefined) {
      // Artifact relationships come from records (#2549): a record's pins and
      // what it constrains, read at the same revision as the declaration.
      const { readRecordsFor } = await import("./records-cli");
      try {
        const read = await readRecordsFor({ kind: query.kind, cwd: query.cwd, at: query.at });
        const name = read.loaded.kind.name;
        graph.records = read.result.records.map((r) => ({ kind: name, id: r.id, path: r.path, state: r.state, valid: r.valid, supersededBy: r.supersededBy, remediatedBy: r.remediatedBy }));
        graph.links.push(...recordLinkRows(name, read.result.records, read.loaded.kind.constrains?.field, located.tree, declaration.members));
      } catch (err) {
        if (!(err instanceof RecordReadError)) throw err;
        recordsFailed = true;
        query.onStderr?.(`${formatError({ message: `--kind ${query.kind}: ${err.code}: ${err.message}`, hint: USAGE })}\n`);
      }
    }
    return { doc: { ...head, at: located.at, ...graph }, failed: failed || recordsFailed || nestedFailed, ...(components ? { components } : {}) };
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    return { doc: { ...head, error: { code: err.code, message: err.message, location: err.location ?? null } }, failed: true };
  } finally {
    readers?.cleanup();
    if (exported) rmSync(dirname(exported), { recursive: true, force: true });
  }
}

/**
 * Expand every member of kind `workspace` the query covers, read-only (#2551,
 * ws-071). Returns whether one could not be read.
 */
async function expandNested(
  graph: WorkspaceGraph,
  members: readonly { name: string; dir: string; kind: string }[],
  query: GraphQuery,
  rootOnDisk: string,
  at: string | null,
): Promise<boolean> {
  const nested = members.filter((m) => m.kind === "workspace" && (!query.members?.length || query.members.includes(m.name)));
  if (nested.length === 0) return false;
  const { foldNested, readNested } = await import("./nested-graph");
  const reads = await Promise.all(
    nested.map(async (m) => {
      const abs = join(rootOnDisk, ...m.dir.split("/"));
      if (!existsSync(abs)) return { m, read: null };
      return { m, read: await readNested(abs, query.args ?? {}, at, GRAPH_OUTPUT_SCHEMA_ID, GRAPH_CONTRACT_VERSION, query.reader) };
    }),
  );
  let failed = false;
  for (const { m, read } of reads) {
    const member = graph.members.find((x) => x.name === m.name);
    if (!member) continue;
    if (!read) {
      failed = true;
      member.status = "failed";
      member.reason = { code: "dir-missing", message: `the nested workspace's directory ${m.dir} does not exist` };
      continue;
    }
    if (read.stderr.trim() && query.onStderr) query.onStderr(read.stderr.endsWith("\n") ? read.stderr : `${read.stderr}\n`);
    member.chant = read.chant;
    if (read.ok) {
      foldNested(graph, member, read.doc);
    } else {
      failed = true;
      member.status = "failed";
      member.reason = { code: read.code, message: read.message };
    }
  }
  return failed;
}

export async function runWorkspaceGraph(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const cwd = resolve(args.extraPositional ?? ".");
  if (!existsSync(cwd)) {
    console.error(formatError({ message: `${cwd} does not exist`, hint: USAGE }));
    return 1;
  }
  // The root's chant reads the declaration (ws-021).
  const handed = await handToRootChant(cwd, args.at);
  if (handed !== undefined) return handed;

  // Composite instances joined to components (#2662) are their own document.
  if (args.composites) {
    if (args.intent !== undefined || args.kind !== undefined) {
      console.error(formatError({ message: "--composites takes neither --intent nor --kind", hint: USAGE }));
      return 1;
    }
    if (!args.dryRun) return (await import("./composites")).runWorkspaceComposites(ctx, cwd);
  }

  // The live read (#2875): the flags mean what they mean to a member's own
  // `chant graph`, where --overlay and --traffic only act on a live read and
  // --live needs an environment. Here they are refused rather than ignored.
  if (!args.composites && args.intent === undefined) {
    if ((args.overlay || args.traffic !== undefined) && !args.live) {
      console.error(formatError({ message: "--overlay and --traffic act on a live read; add --live --env <env>", hint: USAGE }));
      return 1;
    }
    if (args.live && args.at !== undefined) {
      emitDocument({ $schema: GRAPH_OUTPUT_SCHEMA_ID, contract: GRAPH_CONTRACT_VERSION, chant: readerVersion(), error: { code: "live-at-revision", message: LIVE_AT_REVISION, location: null } }, args.output);
      console.error(formatError({ message: `live-at-revision: ${LIVE_AT_REVISION}`, hint: USAGE }));
      return 1;
    }
    if (args.live && !args.env) {
      console.error(formatError({ message: "--live needs an environment, as each member's chant graph --live does: --live --env <env>", hint: USAGE }));
      return 1;
    }
  }

  // The intent graph over one region (#2651) is its own document.
  if (args.intent !== undefined) return (await import("./intent-cli")).runWorkspaceIntent(ctx, cwd);

  if (args.dryRun) {
    let plan: MemberPlan;
    try {
      plan = planGraph({ cwd, at: args.at, members: args.members });
    } catch (err) {
      if (!(err instanceof WorkspaceReadError)) throw err;
      console.error(formatError({ message: `${err.code}: ${err.describe()}`, hint: USAGE }));
      return 1;
    }
    console.log(args.json ? JSON.stringify(planJson(plan), null, 2) : describePlan(plan));
    return 0;
  }

  const { doc, failed } = await workspaceGraph({
    cwd,
    at: args.at,
    members: args.members,
    args,
    ...(args.noCache ? { noCache: true } : {}),
    ...(args.kind !== undefined ? { kind: resolve(args.kind) } : {}),
    onStderr: (text) => process.stderr.write(text),
  });
  emitDocument(doc, args.output);
  if ("error" in doc) {
    const l = doc.error.location;
    console.error(formatError({ message: `${doc.error.code}: ${l ? `${l.file}:${l.line}:${l.column}: ` : ""}${doc.error.message}`, hint: USAGE }));
  }
  return failed ? 1 : 0;
}
