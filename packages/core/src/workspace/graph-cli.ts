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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { formatError } from "../cli/format";
import { INSTANCE_ROLLUP_CODES } from "../instance-nodes";
import type { ReasonCode } from "./reason-codes";
import type { CommandContext, ParsedArgs } from "../cli/registry";
import { graphBox, plantability, type Plantable } from "./box-factory";
import { composedId, composeWorkspaceGraph, readMemberIr, type ComposedMember, type ComposeInput, type WorkspaceGraph } from "./compose-graph";
import { placeCatalogPass, runCatalogPass, runsOnEdges, type LookPath } from "./catalog-edges";
import { detailIdMap, type DetailLevel } from "../graph-detail";
import type { NamedCatalog } from "../graph-refs";
import { isViewDocument, prefixView } from "../capabilities/view";
import { refusedCapabilityView } from "./nested-graph";
import { openGraphCache, planStamps, splitCached, storeReads, withoutUnits } from "./graph-cache";
import { DECLARATION_FILES, readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError, type Declaration, type ErrorLocation, type RepoRef } from "./declaration";
import { describePlan, emitDocument, executePlan, memberStatus, planJson, planMembers, type MemberArgv, type MemberPlan, type Toolchain, type UnitResult } from "./member-commands";
import { loadKindRegistry, REPO_KIND, type KindRegistry } from "./kinds";
import { repoIdentity } from "./repo-ref";
import { readKindLinks } from "./kind-link-readers";
import { prepareKindReaders, type PreparedReaders } from "./kind-readers";
import { recordLinkRows } from "./record-assets";
import { RecordReadError } from "./records";
import { workingTree, type WorkspaceTree } from "./tree";
import { declares, discover, discoveredTree, discoveredWorkspaceName, discoveryKinds, locateDiscovered, type DiscoveredEntry } from "./discover";
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

/** Why a block node of an expanded terraform block stays one node: `nodes[].instanceRollup.code` (#4489). */
export const GRAPH_INSTANCE_ROLLUP_CODES = INSTANCE_ROLLUP_CODES satisfies readonly ReasonCode[];

/** Why `--live` and `--at` don't go together (#2875). */
const LIVE_AT_REVISION = "--live reads the account as it stands now, and --at reads the source at a revision; chant workspace graph takes one of them";

const USAGE =
  "chant workspace graph [dir] [--discover [--runs-on <member>=<member>/<address>]...] [--at <rev>] [--member <name>] [--kind <kind file>] [-o <file>] [--env <env>] [--live [--overlay] [--traffic <level>]] [--no-cache] [--dry-run] | chant workspace graph --composites [--at <rev>] [--member <name>] [-o <file>] | chant workspace graph --intent <path[:start-end]|path#symbol|member/node|sha> [--at <rev>] [--kind <kind file>...] [--follow-squash] [--json]";

interface Head {
  $schema: string;
  contract: number;
  chant: string;
}

export type GraphDocument =
  | (Head & { at: string | null; plantable: Plantable; discovered?: DiscoveredEntry[] } & WorkspaceGraph)
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
  /**
   * Read `cwd` with no declaration (#5095): the kinds' probes find the
   * members, as `discover.ts` describes, and nothing is written inside it.
   * When `cwd` holds a declaration itself, that declaration is read instead.
   */
  discover?: boolean;
  /** With `discover`: the cluster resource a discovered member runs on, by member name (#5101), as a declaration's `runsOn`. */
  runsOn?: Record<string, string>;
  /**
   * Run the lexicons' reference catalogs over the composed graph (#5097,
   * `./catalog-edges.ts`). A source read only: with `--live` each member's
   * own chant has run its catalog already. `chant workspace graph` sets it.
   */
  catalog?: boolean;
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
  capabilityView = false,
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
    // The member's own capability view (#4378), with composed ids; null when its chant printed none.
    if (capabilityView) {
      const view = (ir.ir as { capabilityView?: unknown }).capabilityView;
      member.capabilityView = isViewDocument(view) ? prefixView(view, composedId(m.name, "")) : null;
    }
    delete (ir.ir as { capabilityView?: unknown }).capabilityView;
    inputs.push({ member, ir: ir.ir });
  }
  return { inputs, failed };
}

/** Where a read's members come from: a declaration, or a discovery (#5095). */
interface ReadSource {
  located: LocatedWorkspace;
  declaration: Declaration;
  kinds: KindRegistry;
  kindProblems: string[];
  /** The tree to plan from in a directory the revision was exported to (`--at`). */
  treeAt(dir: string): WorkspaceTree;
  /** For a discovered read, every directory a kind claims. */
  discovered?: DiscoveredEntry[];
}

/**
 * The declaration a read covers and the kinds it reads with. With
 * `discover`, and no declaration in `cwd` itself, the members are found by
 * probe and the declaration is held in memory. Throws a {@link WorkspaceReadError}.
 */
function readSource(query: GraphQuery): ReadSource {
  if (query.discover) {
    const where = locateDiscovered(query.cwd, query.at);
    if (!declares(where.base)) {
      const kinds = discoveryKinds();
      const found = discover(where.base, kinds, discoveredWorkspaceName(where.rootOnDisk), query.runsOn);
      const tree = discoveredTree(where.base, found.declaration);
      const declaration = readDeclaration(tree, "", { rootChant: true });
      return {
        located: { ...where, tree },
        declaration,
        kinds: kinds.registry,
        kindProblems: kinds.problems,
        treeAt: (dir) => discoveredTree(workingTree(dir), found.declaration),
        discovered: found.entries,
      };
    }
  }
  const located = locateWorkspace(query.cwd, query.at);
  const declaration = readDeclaration(located.tree, "", { rootChant: true });
  // Kinds are read before planning: a package kind with a graph block runs (#2874).
  const { registry: kinds, problems } = loadKindRegistry(declaration.pins, located.rootOnDisk);
  return { located, declaration, kinds, kindProblems: problems.map((p) => p.message), treeAt: workingTree };
}

/** Plan a graph read without running anything, for `--dry-run`. Throws a {@link WorkspaceReadError}. */
export function planGraph(query: GraphQuery): MemberPlan {
  const { located, kinds, kindProblems } = readSource(query);
  return planMembers("graph", located.rootOnDisk, { only: query.members, reader: query.reader, tree: located.tree, kinds, kindProblems });
}

/** The members of a workspace read, each read under its own toolchain: what graph and search compose (#4374). */
export interface MemberReads {
  located: LocatedWorkspace;
  declaration: Declaration;
  kinds: KindRegistry;
  /** The plan the members ran from. */
  plan: MemberPlan;
  /** Each member's answer, the cache's included, in no particular order. */
  results: UnitResult[];
  /** The members the cache answered. */
  served: ReadonlySet<string>;
  /** Each member's stamp, by unit id (ws-059). */
  stamps: ReadonlyMap<string, string>;
  /** With {@link GraphQuery.components}: each member's component graph run. */
  components?: UnitResult[];
  /** For a discovered read (#5095), every directory a kind claims. */
  discovered?: DiscoveredEntry[];
}

export interface MemberReadOptions {
  /** The command line each member runs; `chant graph --format ir` and the verb's flags by default. */
  argvFor?: MemberArgv;
  /**
   * Answer members from the per-member cache and store what they print
   * (ws-059). Only a read whose output is a graph IR may be cached. When
   * off, every member is still stamped by the same rule.
   */
  cache: boolean;
}

/**
 * Plan the members a workspace read covers, run each under its own toolchain
 * (ws-021) at the revision asked for, and return what they printed. One
 * fan-out, shared by `chant workspace graph` and `chant workspace search`
 * (#4374): `--at` exports the tree once, a member of a package's kind runs in
 * its reader project, and every member is stamped by the rule of ws-059. The
 * exported tree and the reader projects are removed before this returns.
 * Throws a {@link WorkspaceReadError} when the declaration can't be read.
 */
export async function readMembers(query: GraphQuery, options: MemberReadOptions): Promise<MemberReads> {
  let exported: string | undefined;
  let readers: PreparedReaders | undefined;
  try {
    const { located, declaration, kinds, kindProblems, treeAt, discovered } = readSource(query);
    let plan = planMembers("graph", located.rootOnDisk, { only: query.members, reader: query.reader, tree: located.tree, kinds, kindProblems });
    const args = (query.args ?? {}) as ParsedArgs;
    // Members whose last source read still stands are answered from the cache (#2876).
    // A composites read runs every member's component graph as well, so it reads everything.
    const cache = !options.cache || query.noCache || query.components ? undefined : openGraphCache(located.rootOnDisk);
    const split = cache ? splitCached(plan, args, cache, located.at) : undefined;
    const stamps = split?.stamps ?? (options.cache ? new Map<string, string>() : planStamps(plan, located.at));
    const served = new Set(split?.hits.map((h) => h.id));
    if (located.at !== null && withoutUnits(plan, served).groups.length > 0) {
      exported = exportRevision(located, withoutUnits(plan, served).groups.flatMap((g) => g.units.map((u) => u.dir)));
      plan = planMembers("graph", exported, { only: query.members, reader: query.reader, tree: treeAt(exported), kinds, kindProblems });
    }
    // Only the members that run get a reader project; a served member needs none.
    const toRun = withoutUnits(plan, served);
    readers = prepareKindReaders(toRun, exported ?? located.rootOnDisk);
    const [first, components] = await Promise.all([
      executePlan(toRun, args, options.argvFor),
      query.components ? executePlan(plan, args, () => componentGraphArgv(args)) : Promise.resolve(undefined),
    ]);
    const ran = args.capabilityView && !options.argvFor ? await withoutViewWhereRefused(toRun, args, first) : first;
    if (cache && split) storeReads(split, ran, cache);
    const results = [...(split?.hits ?? []), ...ran];
    if (query.inTree) await query.inTree(exported ?? located.rootOnDisk, declaration.members.filter((m) => !query.members?.length || query.members.includes(m.name)));
    for (const r of components ?? []) if (r.stderr.trim() && query.onStderr) query.onStderr(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    for (const r of results) if (r.stderr.trim() && query.onStderr) query.onStderr(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    return { located, declaration, kinds, plan, results, served, stamps, ...(components ? { components } : {}), ...(discovered ? { discovered } : {}) };
  } finally {
    readers?.cleanup();
    if (exported) rmSync(dirname(exported), { recursive: true, force: true });
  }
}

/**
 * A member's chant from before #4378 refuses `--capability-view` as a flag
 * it doesn't know. Read those members again without it, so the graph still
 * composes them; they carry `capabilityView: null`, which a capability search
 * reports as `member-chant-too-old`.
 */
async function withoutViewWhereRefused(plan: MemberPlan, args: ParsedArgs, results: UnitResult[]): Promise<UnitResult[]> {
  const refused = new Set(results.filter((r) => r.exitCode !== 0 && refusedCapabilityView(r.stderr)).map((r) => r.id));
  if (refused.size === 0) return results;
  const others = new Set(results.filter((r) => !refused.has(r.id)).map((r) => r.id));
  const again = await executePlan(withoutUnits(plan, others), { ...args, capabilityView: false });
  const byId = new Map(again.map((r) => [r.id, r]));
  return results.map((r) => byId.get(r.id) ?? r);
}

/** Read and compose the graph, and build the document. Never throws a {@link WorkspaceReadError}. */
export async function workspaceGraph(query: GraphQuery): Promise<GraphResult> {
  const head: Head = { $schema: GRAPH_OUTPUT_SCHEMA_ID, contract: GRAPH_CONTRACT_VERSION, chant: readerVersion() };
  if (query.args?.live && query.at !== undefined) {
    return { doc: { ...head, error: { code: "live-at-revision", message: LIVE_AT_REVISION, location: null } }, failed: true };
  }
  try {
    const { located, declaration, kinds, plan, results, served, stamps, components, discovered } = await readMembers(query, { cache: true });
    const args = (query.args ?? {}) as ParsedArgs;
    const { inputs, failed } = compose(plan, results, query.members, declaration.members, !!args.live, !!args.capabilityView);
    for (const { member } of inputs) {
      if (member.status !== "composed") continue;
      member.cached = served.has(member.name);
      member.stamp = stamps.get(member.name) ?? null;
    }
    // Links (#2539) resolve against the declaration that was read, the revision's for --at, and the kinds installed now.
    // A kind's link reader (#3932) reads the member's files in the tree read, as check does.
    const graph = composeWorkspaceGraph({ name: declaration.name, root: located.root, repo: repoIdentity(located.rootOnDisk) }, inputs, { declaration, kinds, read: readKindLinks(declaration, located.tree, kinds) });
    // The reference catalogs over the composed graph (#5097), on full attributes whatever --detail asks for.
    if (query.catalog && !args.live) await addCatalogEdges(graph, query, args, { workspace: graph.workspace, inputs, located, runsOn: runsOnOf(declaration.members) });
    // The box's factory and listing (#3146), from the declaration read, so --at gives them at that revision.
    for (const member of graph.members) member.box = graphBox(declaration.members.find((m) => m.name === member.name)?.box ?? null, located.tree, declaration.members);
    // Nested workspaces (#2551, ws-071): read-only, through their own chant workspace graph.
    // Repo members (#3168): another repository's workspace at its pinned revision, read the same way.
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
    // A discovered read lists every directory a kind claims (#5095), the ones that are not members included.
    return {
      doc: { ...head, at: located.at, plantable: plantability(declaration), ...graph, ...(discovered ? { discovered } : {}) },
      failed: failed || recordsFailed || nestedFailed,
      ...(components ? { components } : {}),
    };
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    return { doc: { ...head, error: { code: err.code, message: err.message, location: err.location ?? null } }, failed: true };
  }
}

/** The reference catalog of each lexicon that has one, best effort: a lexicon that does not load has none. */
async function loadCatalogs(lexicons: readonly string[]): Promise<NamedCatalog[]> {
  const { loadPlugin } = await import("../cli/plugins");
  const out: NamedCatalog[] = [];
  for (const lexicon of lexicons) {
    try {
      const catalog = (await loadPlugin(lexicon)).referenceCatalog;
      if (catalog) out.push({ lexicon, catalog });
    } catch {
      // Not installed where this chant can load it: its nodes get no derived edges.
    }
  }
  return out;
}

/**
 * The catalog pass (#5097): load the catalogs of the lexicons the graph
 * holds, read the members again at `--detail 3` when the document is printed
 * at another tier, since the rules read nested attributes (`spec`,
 * `metadata`) that the lower tiers leave out, run the pass over those nodes
 * and place what it finds on the document's nodes.
 */
async function addCatalogEdges(
  graph: WorkspaceGraph,
  query: GraphQuery,
  args: ParsedArgs,
  read: { workspace: WorkspaceGraph["workspace"]; inputs: ComposeInput[]; located: LocatedWorkspace; runsOn: ReadonlyMap<string, string> },
): Promise<void> {
  const lexicons = [...new Set(graph.nodes.map((n) => n.lexicon))].sort();
  const catalogs = await loadCatalogs(lexicons);
  const level = (args.detail ?? 2) as DetailLevel;
  let full = read.inputs;
  if (catalogs.length > 0 && level !== 3) {
    // With no stderr and no capability view: the document's own read has
    // passed on what the members said already.
    const again = await readMembers({ ...query, args: { ...args, detail: 3, capabilityView: false }, onStderr: undefined, inTree: undefined, components: false }, { cache: true });
    full = compose(again.plan, again.results, query.members, again.declaration.members).inputs;
  }
  const printed = new Set(read.inputs.filter((i) => i.ir).map((i) => i.member.name));
  const readable = full.filter((i) => i.ir && printed.has(i.member.name)).map((i) => ({ member: { ...i.member }, ir: i.ir }));
  const nodes = catalogs.length > 0 ? composeWorkspaceGraph(read.workspace, readable).nodes : [];
  const placed = new Map<string, string>();
  for (const { member, ir } of readable) {
    for (const [id, at] of detailIdMap(ir!, level)) placed.set(composedId(member.name, id), composedId(member.name, at));
  }
  const pass = runCatalogPass(nodes, catalogs, catalogs.length > 0 ? readable.map((i) => i.member.name) : [], repoPathLookup(read.located, read.workspace.repo ?? null));
  // The declared cluster each member runs on (#5101): its edges are drawn first, so a Secret they join is not also derived or left dangling.
  const declared = runsOnEdges(nodes, read.runsOn, catalogs);
  for (const problem of declared.problems) query.onStderr?.(`warning: ${problem}\n`);
  pass.dangling = pass.dangling.filter((d) => !(declared.joined.has(d.from) && pass.rules[d.rule!]?.relation === "reference"));
  graph.edges = [...graph.edges, ...declared.edges.map((e) => ({ ...e, from: placed.get(e.from) ?? e.from, to: placed.get(e.to) ?? e.to })).filter((e) => e.from !== e.to)];
  placeCatalogPass(graph, pass, placed, level);
}

/** A repository URL with its scheme, credentials, `.git` and case taken off, so two spellings of one repository compare equal. */
export function repoKey(url: string): string {
  let u = url.trim().toLowerCase();
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^[^@/]+@/, "");
  // scp-like `host:owner/repo` is `host/owner/repo`.
  u = u.replace(/^([^/:]+):(?!\d+\/)/, "$1/").replace(/^([^/:]+):\d+\//, "$1/");
  return u.replace(/\/+$/, "").replace(/\.git$/, "");
}

/**
 * Where a path rule's path is (#5102): read in the tree the workspace was
 * read from, when the path's repository is the workspace's own (its origin)
 * and the path is under the workspace root. A path in any other repository,
 * or with no origin to compare with, is not read.
 */
function repoPathLookup(located: LocatedWorkspace, repo: string | null): LookPath | undefined {
  if (repo === null) return undefined;
  const own = repoKey(repo);
  const root = located.root;
  if (isAbsolute(root)) return undefined;
  return (ref) => {
    if (repoKey(ref.repo) !== own) return undefined;
    let path = ref.value;
    if (root !== "." && root !== "") {
      if (path !== root && !path.startsWith(`${root}/`)) return undefined;
      path = path.slice(root.length + 1);
    }
    if (path === "") return "dir";
    return located.tree.stat(path) ?? "missing";
  };
}

/** The `runsOn` each declared member sets, by member name (#5101). */
function runsOnOf(members: readonly { name: string; runsOn: string | null }[]): Map<string, string> {
  return new Map(members.filter((m) => m.runsOn !== null).map((m) => [m.name, m.runsOn!]));
}

/**
 * Expand every member of kind `workspace` the query covers, read-only (#2551,
 * ws-071), and every member of kind `repo` the same way, at its pinned
 * revision, fetched into the user's cache (#3168). Returns whether one could
 * not be read.
 */
async function expandNested(
  graph: WorkspaceGraph,
  members: readonly { name: string; dir: string; kind: string; repo: RepoRef | null }[],
  query: GraphQuery,
  rootOnDisk: string,
  at: string | null,
): Promise<boolean> {
  const covered = (m: { name: string }) => !query.members?.length || query.members.includes(m.name);
  const nested = members.filter((m) => (m.kind === "workspace" || (m.kind === REPO_KIND && m.repo !== null)) && covered(m));
  if (nested.length === 0) return false;
  const { foldNested, readNested } = await import("./nested-graph");
  const { fetchRepoAt } = await import("./repo-ref");
  const reads = await Promise.all(
    nested.map(async (m) => {
      if (m.repo) {
        // The other repository at its pinned revision, whatever revision the outer read is at.
        const fetched = fetchRepoAt(m.repo, rootOnDisk);
        if (!fetched.ok) return { m, read: null, missing: fetched.message };
        if (!existsSync(fetched.dir)) return { m, read: null, missing: `${m.repo.url} at ${m.repo.rev} has no directory ${m.repo.workspace}` };
        return { m, read: await readNested(fetched.dir, query.args ?? {}, m.repo.rev, GRAPH_OUTPUT_SCHEMA_ID, GRAPH_CONTRACT_VERSION, query.reader), missing: null };
      }
      const abs = join(rootOnDisk, ...m.dir.split("/"));
      if (!existsSync(abs)) return { m, read: null, missing: null };
      return { m, read: await readNested(abs, query.args ?? {}, at, GRAPH_OUTPUT_SCHEMA_ID, GRAPH_CONTRACT_VERSION, query.reader), missing: null };
    }),
  );
  let failed = false;
  for (const { m, read, missing } of reads) {
    const member = graph.members.find((x) => x.name === m.name);
    if (!member) continue;
    if (m.repo) member.repo = { ...m.repo, read: read?.ok ? (read.doc.workspace.repo ?? null) : null };
    if (!read) {
      failed = true;
      member.status = "failed";
      // A repo that can't be fetched is a read that failed; the contract's codes stay as they are.
      member.reason = missing !== null ? { code: "command-failed", message: missing } : { code: "dir-missing", message: `the nested workspace's directory ${m.dir} does not exist` };
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
  if (args.runsOn && !args.discover) {
    console.error(formatError({ message: "--runs-on sets a discovered member's cluster; with a declaration, set runsOn on the member's entry", hint: USAGE }));
    return 2;
  }
  // --discover (#5095) reads one directory with no declaration, as the composed graph only.
  if (args.discover && (args.composites || args.intent !== undefined || args.kind !== undefined)) {
    console.error(formatError({ message: "--discover reads the composed graph, and takes none of --composites, --intent and --kind", hint: USAGE }));
    return 1;
  }
  // The root's chant reads the declaration (ws-021). A discovered read has
  // none to hand over, unless <dir> holds one itself, which is then read.
  if (!args.discover || DECLARATION_FILES.some((f) => existsSync(join(cwd, f)))) {
    const handed = await handToRootChant(cwd, args.at);
    if (handed !== undefined) return handed;
  }

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
      plan = planGraph({ cwd, at: args.at, members: args.members, ...(args.discover ? { discover: true } : {}) });
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
    ...(args.discover ? { discover: true } : {}),
    ...(args.runsOn ? { runsOn: args.runsOn } : {}),
    ...(args.kind !== undefined ? { kind: resolve(args.kind) } : {}),
    onStderr: (text) => process.stderr.write(text),
    catalog: true,
  });
  emitDocument(doc, args.output);
  if ("error" in doc) {
    const l = doc.error.location;
    console.error(formatError({ message: `${doc.error.code}: ${l ? `${l.file}:${l.line}:${l.column}: ` : ""}${doc.error.message}`, hint: USAGE }));
  }
  return failed ? 1 : 0;
}
