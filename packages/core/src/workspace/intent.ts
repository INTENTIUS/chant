/**
 * The intent graph over one region: `chant workspace graph --intent
 * <path[:start-end]>` (#2651; #2650 sections B and C1; #2524 D8, D15).
 *
 * A person points at some code and asks how it got this way and who decided
 * it should be this way. This module gathers what the workspace records about
 * that, as one document of nodes and edges, and decides nothing. It gathers
 * three sources before it relates any of them, so no one of them frames the
 * others:
 *
 * - The commits that touched the region, from git: `git log -L` for a line
 *   range, `git log --follow` for a file and `git log -- <dir>` for a
 *   directory. Each carries its trailers and its provenance level, and a
 *   plugin may join it to a unit of work, a contract and evidence
 *   (`intent-joins.ts`).
 * - The decisions whose `constrains` cover the region: a `path:` entry that
 *   is the region or a directory above it, the region's `member:`, an issue
 *   the region's commits name, or a contract a plugin joined. Their
 *   supersession chains come along.
 * - The artifacts those decisions pin. Artifacts relate to code only through
 *   decisions (#2549), so an artifact is in the graph because a decision in
 *   the graph pins it.
 *
 * Every gap the walk finds is a `finding` node with a closed code, never
 * prose, so a reader can draw it and a test can assert it. A commit made
 * inside a decision's window is not taken as that decision's work: unless
 * the decision's own unit made it, it is `decided-by-window`, shown for the
 * person to judge (#2656). A plugin's `commitJoins` may add findings of its
 * own, in its own code namespace. chant emits the
 * graph and hud renders it (#2524 D8, D15). Git is read through a local
 * `git` subprocess only: no fetch, no network.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { readDeclaration, readerVersion, resolveGroups, WORKSPACE_ERROR_CODES, WorkspaceReadError, type Declaration } from "./declaration";
import { classifyFile, declaredFilesUnder } from "./generated-files";
import { entityDecisions, hasTrailer, readCommitJoins, runCommitJoins, type CommitJoins, type IntentCommit, type JoinedEntity, type PluginFinding } from "./intent-joins";
import { loadKindRegistry } from "./kinds";
import { resolveLinks, type LinkTableRow } from "./links";
import { sourceMemberHandles } from "./member-handles";
import { constraintCovers, isWorkspacePath, memberHolding } from "./record-assets";
import { importKindModule, loadRecordKind, RecordReadError, type LoadedRecordKind } from "./records";
import { queryRecords, type RecordView } from "./records-cli";
import type { PluginCode, ReasonCode } from "./reason-codes";
import { joinPath, skippedDir, type WorkspaceTree } from "./tree";
import { activeAttestors, type ProvenanceLevel } from "./trust/attestor";
import { commitProvenance, policyAtBase, resolveBase } from "./trust/provenance";
import { locateWorkspace, type LocatedWorkspace } from "./which-chant";

/** The version of the `intent` document this chant writes. */
export const INTENT_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the document, shipped beside this file. */
export const INTENT_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/intent/v1/intent.schema.json";

// ── Codes ────────────────────────────────────────────────────────────────────

/** The finding codes. Closed: a reader may switch on them. */
export const INTENT_FINDING_CODES = [
  /** A commit touched the region when no decision constrained it at path granularity. */
  "intent-commit-undecided",
  /** A commit has no unit, no pull request reference and no decision covering the region at its time. */
  "intent-commit-bare",
  /** A pinned artifact's bytes no longer hash to the pin. */
  "intent-pin-drifted",
  /** A pinned artifact does not exist in the tree read. */
  "intent-pin-missing",
  /** An artifact that decisions in the graph pinned, and that no current decision pins. */
  "intent-artifact-unpinned",
  /** Every decision constraining the region is superseded. */
  "intent-decision-superseded-live",
  /** The current decisions constraining the region are all in states their kind does not close, such as decided and not ratified. */
  "intent-decision-provisional",
  /** The region is constrained only at member granularity. */
  "intent-constraint-coarse",
  /** A decision's path constraint names a path that does not exist. */
  "intent-constraint-lost",
  /** A decision's evidence has no hash: a URL, or a path with no sha256. */
  "intent-evidence-unpinned",
  /** A commit carries a trailer a plugin says claims authorship, and the commit is not attested. */
  "intent-trailer-unverified",
  /** No decision constrains the region at any granularity. */
  "intent-region-unconstrained",
] as const satisfies readonly ReasonCode[];
export type IntentFindingCode = (typeof INTENT_FINDING_CODES)[number];

/** Why part of the walk could not be read. The read still succeeds. */
export const INTENT_REASON_CODES = [
  /** The repository is a shallow clone, so the history is cut. */
  "intent-history-shallow",
  /** A plugin's commitJoins failed for a commit. */
  "intent-plugin-failed",
] as const satisfies readonly ReasonCode[];
export type IntentReasonCode = (typeof INTENT_REASON_CODES)[number];

/** Why the read failed as a whole: the declaration's codes, the record kind's codes, or a region that isn't there. */
export const INTENT_ERROR_CODES = [
  ...WORKSPACE_ERROR_CODES,
  "kind-unreadable",
  "kind-invalid",
  "schema-unreadable",
  "schema-id-mismatch",
  "schema-invalid",
  "location-missing",
  /** The region's path, or its line range, does not exist in the tree read. */
  "intent-region-invalid",
] as const satisfies readonly ReasonCode[];
export type IntentErrorCode = (typeof INTENT_ERROR_CODES)[number];

export class IntentError extends Error {
  constructor(
    readonly code: IntentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IntentError";
  }
}

// ── The document ─────────────────────────────────────────────────────────────

export interface LineRange {
  start: number;
  end: number;
}

export interface RegionNode {
  id: string;
  kind: "region";
  /** From the workspace root. */
  path: string;
  lines: LineRange | null;
  /** The member whose directory holds the path, or null. */
  member: string | null;
  at: string | null;
  type: "file" | "dir";
  /** For a file region, whether the file is generated (#2524 D14); null for a directory. */
  generated: boolean | null;
  /** Set when the region was given as a graph node id. */
  node: string | null;
}

export interface FileNode {
  id: string;
  kind: "file";
  path: string;
  member: string | null;
  generated: boolean;
}

export interface MemberNode {
  id: string;
  kind: "member";
  name: string;
  dir: string;
  memberKind: string;
}

export interface CommitNode {
  id: string;
  kind: "commit";
  sha: string;
  subject: string;
  author: { name: string; email: string };
  date: string;
  trailers: Record<string, string[]>;
  /** The pull request number the subject ends with, as a squash merge writes it, or null. */
  pullRequest: number | null;
  signature: { level: ProvenanceLevel; reason: string; principal?: string };
  /** The line ranges the commit changed in the region, in the commit's own version of the file; null for a file or directory region. */
  lines: LineRange[] | null;
  /**
   * How the decisions constraining the region by path relate to the commit
   * (#2656): `decided` when it falls inside a decision's window and that
   * decision's own unit made it, `decided-by-window` when it only falls
   * inside a window, `undecided` when it falls outside every window, and
   * null when no record kind was read.
   */
  state: CommitState | null;
}

export type CommitState = "decided" | "decided-by-window" | "undecided";

export interface JoinedNode {
  id: string;
  kind: "unit" | "contract" | "evidence";
  /** The plugin's own id. */
  ref: string;
  /** The kind file that supplied it. */
  plugin: string;
  /** The fields the plugin gave, besides the id. */
  data: Record<string, unknown>;
}

export interface EvidenceEntryNode {
  id: string;
  kind: "evidence";
  ref: string;
  plugin: null;
  data: { title: string | null; url: string | null; path: string | null; as_of: string | null; sha256: string | null };
}

export interface DecisionNode {
  id: string;
  kind: "decision";
  recordKind: string;
  record: string;
  /** The record file, from the repository root. */
  path: string;
  title: string | null;
  state: string | null;
  /** Whether the kind counts the state as closed (final), such as ratified. */
  closed: boolean;
  valid: boolean;
  reasons: RecordView["reasons"];
  provenance: { level: ProvenanceLevel; commit: string | null; reason: string };
  decided_by: string | null;
  decided_on: string | null;
  reviews: { agree: number; dissent: number; abstain: number; openConcerns: number };
  supersededBy: string | null;
  /** The ids of the records this one's supersedes links name. */
  supersedes: string[];
  /** The constrains entries that cover the region, with their granularity. Empty for a decision in the graph only through supersession. */
  constrains: { entry: string; granularity: Granularity }[];
}

export type PinState = "pinned" | "drifted" | "missing" | "stale" | "unpinned";

export interface ArtifactNode {
  id: string;
  kind: "artifact";
  /** From the workspace root the pinning record's kind resolves pins in. */
  path: string;
  anchor: string | null;
  /** The hash a current decision pins, or null when none does. */
  pinnedSha256: string | null;
  /** The file's hash in the tree read, or null when it is missing. */
  currentSha256: string | null;
  /** The state of a current decision's pin, or unpinned when only superseded decisions pin it. */
  pinState: PinState;
}

export interface LinkNode {
  id: string;
  kind: "link";
  row: LinkTableRow;
}

export interface FindingNode {
  id: string;
  kind: "finding";
  /** A closed code, or a plugin's own `plugin:<name>:<code>` (#2656). */
  code: IntentFindingCode | PluginCode;
  message: string;
  concerns: string[];
  /** For a plugin's finding: the kind file that returned it. */
  plugin?: string;
  /** For a plugin's finding: the refs as the plugin gave them. The ones that name a node in the graph are in concerns. */
  refs?: string[];
}

export type IntentNode = RegionNode | FileNode | MemberNode | CommitNode | JoinedNode | EvidenceEntryNode | DecisionNode | ArtifactNode | LinkNode | FindingNode;

export type Granularity = "path" | "member" | "contract" | "issue";

export type IntentEdge =
  | { kind: "constrains"; from: string; to: string; granularity: Granularity; entry: string }
  | { kind: "pins"; from: string; to: string; pinnedSha256: string | null; pinState: PinState }
  | { kind: "touched-by"; from: string; to: string; lines: LineRange[] | null }
  | { kind: "within"; from: string; to: string; state: "decided" | "decided-by-window" }
  | { kind: "produced-by" | "serves" | "cites-evidence" | "supersedes" | "links"; from: string; to: string };

export interface IntentReason {
  code: IntentReasonCode;
  message: string;
}

interface Head {
  $schema: string;
  contract: number;
  chant: string;
}

export type IntentDocument =
  | (Head & {
      at: string | null;
      workspace: { name: string; root: string };
      region: string;
      history: { rev: string | null; follows: "line-range" | "file" | "directory"; shallow: boolean };
      kinds: { file: string; name: string; records: string | null; joins: "function" | "data" | null }[];
      nodes: IntentNode[];
      edges: IntentEdge[];
      reasons: IntentReason[];
      summary: { commits: number; decisions: number; artifacts: number; findings: number };
    })
  | (Head & { error: { code: IntentErrorCode; message: string } });

export interface IntentQuery {
  /** Where the walk up to the declaration starts, and what the region path is relative to. */
  cwd: string;
  /** `path`, `path:line` or `path:start-end`, or a graph node id `<member>/<id>`. */
  region: string;
  at?: string;
  /** Kind files: record kinds, plugins with `commitJoins`, or both. Relative to `cwd`. */
  kinds?: string[];
  /**
   * Resolve a graph node id to its source location, for a region given as a
   * node id. The default reads the member's graph as `chant workspace graph
   * --member` does.
   */
  resolveNode?: (cwd: string, at: string | undefined, member: string, id: string) => Promise<{ file: string; line: number | null } | null | undefined>;
}

export interface IntentResult {
  doc: IntentDocument;
  /** The read failed, or a plugin failed. */
  failed: boolean;
}

// ── Git ──────────────────────────────────────────────────────────────────────

function git(top: string, args: string[], input?: string): string {
  return execFileSync("git", args, { cwd: top, encoding: "utf-8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
}

function tryGit(top: string, args: string[], input?: string): string | undefined {
  try {
    return git(top, args, input);
  } catch {
    return undefined;
  }
}

/** The new-side line ranges of each hunk header in a patch. */
function hunkRanges(patch: string): LineRange[] {
  const out: LineRange[] = [];
  for (const m of patch.matchAll(/^@@+ [^@]*\+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    if (count > 0) out.push({ start, end: start + count - 1 });
  }
  return out;
}

/** The commits that touched the region, newest first, with the lines each changed for a line range. */
function regionHistory(top: string, rev: string, gitPath: string, type: "file" | "dir", lines: LineRange | null): { sha: string; lines: LineRange[] | null }[] {
  if (lines) {
    const out = tryGit(top, ["log", `-L${lines.start},${lines.end}:${gitPath}`, "--format=%x00%H", "--no-color", rev]);
    if (out === undefined) return [];
    return out
      .split("\0")
      .filter(Boolean)
      .map((chunk) => {
        const nl = chunk.indexOf("\n");
        const sha = (nl < 0 ? chunk : chunk.slice(0, nl)).trim();
        return { sha, lines: hunkRanges(nl < 0 ? "" : chunk.slice(nl + 1)) };
      });
  }
  const args = type === "file" ? ["log", "--follow", "--format=%H", rev, "--", gitPath] : ["log", "--format=%H", rev, "--", gitPath === "" ? "." : gitPath];
  const out = tryGit(top, args);
  if (out === undefined) return [];
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((sha) => ({ sha, lines: null }));
}

/** Subject, body, author, date and trailers of each commit. */
function commitDetails(top: string, shas: string[]): Map<string, IntentCommit> {
  const out = new Map<string, IntentCommit>();
  if (shas.length === 0) return out;
  const text = git(top, ["log", "--no-walk=unsorted", "--stdin", "--format=%x00%H%x1f%an%x1f%ae%x1f%aI%x1f%(trailers:only,unfold,separator=%x1e)%x1f%B"], `${shas.join("\n")}\n`);
  for (const record of text.split("\0")) {
    if (!record) continue;
    const [sha, name, email, date, trailerText, ...rest] = record.split("\x1f");
    const message = rest.join("\x1f").replace(/\n+$/, "");
    const nl = message.indexOf("\n");
    const trailers: Record<string, string[]> = {};
    for (const t of (trailerText ?? "").split("\x1e")) {
      const colon = t.indexOf(":");
      if (colon <= 0) continue;
      const key = t.slice(0, colon).trim();
      (trailers[key] ??= []).push(t.slice(colon + 1).trim());
    }
    out.set(sha.trim(), {
      sha: sha.trim(),
      subject: nl < 0 ? message : message.slice(0, nl),
      body: nl < 0 ? "" : message.slice(nl + 1).replace(/^\n+/, ""),
      author: { name, email },
      date,
      trailers,
    });
  }
  return out;
}

/** The commit reachable from `rev` that last added `path` (from the repository root), or null. */
function addingCommit(top: string, rev: string, path: string): string | null {
  const out = tryGit(top, ["log", "--diff-filter=A", "-1", "--format=%H", rev, "--", path]);
  return out?.trim() || null;
}

/** `commit` and every commit between it and `rev` that has it as an ancestor. */
function descendants(top: string, commit: string, rev: string): Set<string> {
  const out = new Set<string>([commit]);
  const text = tryGit(top, ["rev-list", "--ancestry-path", `${commit}..${rev}`]);
  for (const line of (text ?? "").split("\n")) if (line.trim()) out.add(line.trim());
  return out;
}

/** `owner/repo` of the `origin` remote, lower case, or null. Read from local config; nothing is fetched. */
function originRepo(top: string): string | null {
  const url = tryGit(top, ["config", "--get", "remote.origin.url"])?.trim();
  const m = url?.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const toPosix = (p: string) => (sep === "/" ? p : p.split(sep).join("/"));

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Parse `path`, `path:line` or `path:start-end`. */
export function parseRegion(arg: string): { path: string; lines: LineRange | null } | { error: string } {
  const m = arg.match(/^(.+?):(\d+)(?:-(\d+))?$/);
  if (!m) return { path: arg, lines: null };
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (start < 1 || end < start) return { error: `${arg}: a line range is start-end with 1 <= start <= end` };
  return { path: m[1], lines: { start, end } };
}

function regionId(path: string, lines: LineRange | null): string {
  return `region:${path}${lines ? `:${lines.start}${lines.end === lines.start ? "" : `-${lines.end}`}` : ""}`;
}

function filesUnder(tree: WorkspaceTree, dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of (tree.list(d) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = joinPath(d, e.name);
      if (e.type === "dir") {
        if (!skippedDir(e.name)) walk(p);
      } else out.push(p);
    }
  };
  walk(dir === "." ? "" : dir);
  return out;
}

function isGenerated(declaration: Declaration, path: string): boolean {
  const m = declaration.members.find((x) => x.name === memberHolding(path, declaration.members));
  const dir = m?.dir ?? ".";
  const rel = dir === "." ? path : path.slice(dir.length + 1);
  return classifyFile(rel, declaredFilesUnder(declaration, dir)).class === "generated";
}

function stringOr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function reviewSummary(data: Record<string, unknown> | null): DecisionNode["reviews"] {
  const out = { agree: 0, dissent: 0, abstain: 0, openConcerns: 0 };
  const list = data?.reviews;
  if (!Array.isArray(list)) return out;
  for (const r of list) {
    if (r === null || typeof r !== "object") continue;
    const review = r as Record<string, unknown>;
    if (review.verdict === "agree") out.agree++;
    else if (review.verdict === "abstain") out.abstain++;
    else if (review.verdict === "dissent") {
      out.dissent++;
      if (review.addressed_by == null && review.withdrawn_on == null) out.openConcerns++;
    }
  }
  return out;
}

const SHA256 = /^[0-9a-f]{64}$/;
const ISSUE = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([0-9]+)$/;
const PIN_ORDER: PinState[] = ["missing", "drifted", "stale", "pinned"];

/** The default node resolver: the member's graph, read as `workspace graph --member` reads it. */
async function resolveNodeFromGraph(cwd: string, at: string | undefined, member: string, id: string): Promise<{ file: string; line: number | null } | null> {
  const { workspaceGraph } = await import("./graph-cli");
  const { doc } = await workspaceGraph({ cwd, at, members: [member] });
  if ("error" in doc) return null;
  const node = doc.nodes.find((n) => n.id === id) as { sourceLoc?: { file: string; line?: number } } | undefined;
  if (!node) return null;
  return node.sourceLoc ? { file: node.sourceLoc.file, line: node.sourceLoc.line ?? null } : { file: ".", line: null };
}

// ── The walk ─────────────────────────────────────────────────────────────────

interface LoadedKind {
  file: string;
  /** Relative to the repository root, for the document. */
  display: string;
  /** The record kind's name, or the file's name without `.kind.mjs`: the namespace of its plugin findings. */
  name: string;
  records?: { loaded: LoadedRecordKind; views: RecordView[]; workspaceRoot: string };
  joins?: CommitJoins;
}

async function loadKinds(query: IntentQuery, top: string): Promise<LoadedKind[]> {
  const out: LoadedKind[] = [];
  for (const k of query.kinds ?? []) {
    const file = resolve(query.cwd, k);
    const display = toPosix(relative(top, realpathOr(file)));
    let mod: Record<string, unknown>;
    try {
      mod = await importKindModule(file);
    } catch (err) {
      throw new IntentError("kind-unreadable", `kind file ${k} could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    }
    const joins = readCommitJoins(mod);
    if (typeof joins === "string") throw new IntentError("kind-invalid", `kind file ${k} has a commitJoins export that can't be read: ${joins}`);
    const kind: LoadedKind = { file, display, name: basename(file).replace(/(?:\.kind)?\.[cm]?[jt]s$/, ""), ...(joins ? { joins } : {}) };
    if (mod.recordKind !== undefined) {
      const doc = await queryRecords({ kind: file, at: query.at, cwd: query.cwd });
      if ("error" in doc) throw new IntentError(doc.error.code, doc.error.message);
      try {
        kind.records = { loaded: await loadRecordKind(file), views: doc.records, workspaceRoot: doc.workspaceRoot };
        kind.name = kind.records.loaded.kind.name;
      } catch (err) {
        if (err instanceof RecordReadError) throw new IntentError(err.code as IntentErrorCode, err.message);
        throw err;
      }
    } else if (!joins) {
      throw new IntentError("kind-invalid", `kind file ${k} exports neither recordKind nor commitJoins`);
    }
    out.push(kind);
  }
  return out;
}

async function resolveRegion(query: IntentQuery, located: LocatedWorkspace, declaration: Declaration): Promise<{ path: string; lines: LineRange | null; node: string | null }> {
  const parsed = parseRegion(query.region);
  if ("error" in parsed) throw new IntentError("intent-region-invalid", parsed.error);
  const rel = toPosix(relative(realpathOr(located.rootOnDisk), resolve(realpathOr(query.cwd), parsed.path)));
  const path = rel === "" ? "." : rel;
  if (path === "." || (isWorkspacePath(path) && !path.startsWith("../") && located.tree.stat(path) !== undefined)) {
    return { path, lines: parsed.lines, node: null };
  }
  // A graph node id, <member>/<id>, when no such path exists (#2650 B1).
  const slash = query.region.indexOf("/");
  const member = slash > 0 ? declaration.members.find((m) => m.name === query.region.slice(0, slash)) : undefined;
  if (member && !parsed.lines) {
    const loc = await (query.resolveNode ?? resolveNodeFromGraph)(query.cwd, query.at, member.name, query.region);
    if (loc) {
      const file = joinPath(member.dir, loc.file);
      return { path: file === "" ? "." : file, lines: loc.line ? { start: loc.line, end: loc.line } : null, node: query.region };
    }
  }
  throw new IntentError("intent-region-invalid", `${query.region} is not a path in the workspace${located.tree.label}, or a graph node id`);
}

/** Build the intent document. Never throws an {@link IntentError}, {@link WorkspaceReadError} or {@link RecordReadError}. */
export async function intentGraph(query: IntentQuery): Promise<IntentResult> {
  const head: Head = { $schema: INTENT_OUTPUT_SCHEMA_ID, contract: INTENT_CONTRACT_VERSION, chant: readerVersion() };
  try {
    return await walk(query, head);
  } catch (err) {
    if (err instanceof IntentError || err instanceof WorkspaceReadError || err instanceof RecordReadError) {
      return { doc: { ...head, error: { code: err.code as IntentErrorCode, message: err.message } }, failed: true };
    }
    throw err;
  }
}

async function walk(query: IntentQuery, head: Head): Promise<IntentResult> {
  const located = locateWorkspace(query.cwd, query.at);
  const top = located.top;
  if (!top) throw new IntentError("not-a-git-repository", "the intent graph reads git history, and this directory is not in a git repository");
  const declaration = readDeclaration(located.tree, "", { rootChant: true });
  const region = await resolveRegion(query, located, declaration);
  const type = region.path === "." ? "dir" : located.tree.stat(region.path);
  if (!type) throw new IntentError("intent-region-invalid", `${region.path} does not exist${located.tree.label}`);
  if (region.lines) {
    if (type !== "file") throw new IntentError("intent-region-invalid", `${region.path} is a directory, and a line range needs a file`);
    const count = located.tree.read(region.path).replace(/\n$/, "").split("\n").length;
    if (region.lines.end > count) throw new IntentError("intent-region-invalid", `${region.path} has ${count} lines${located.tree.label}, so ${region.lines.start}-${region.lines.end} is not in it`);
  }
  const kinds = await loadKinds(query, top);

  const nodes = new Map<string, IntentNode>();
  const edges: IntentEdge[] = [];
  const reasons: IntentReason[] = [];
  const findings: FindingNode[] = [];
  const add = <N extends IntentNode>(n: N): N => {
    if (!nodes.has(n.id)) nodes.set(n.id, n);
    return nodes.get(n.id) as N;
  };
  const find = (code: IntentFindingCode, message: string, concerns: string[]) => {
    findings.push({ id: `finding:${code}:${findings.filter((f) => f.code === code).length + 1}`, kind: "finding", code, message, concerns });
  };

  // The region, its files and its member.
  const member = region.path === "." ? (declaration.members.find((m) => m.dir === ".")?.name ?? null) : memberHolding(region.path, declaration.members);
  const rid = regionId(region.path, region.lines);
  add<RegionNode>({ id: rid, kind: "region", path: region.path, lines: region.lines, member, at: located.at, type, generated: type === "file" ? isGenerated(declaration, region.path) : null, node: region.node });
  const files = type === "dir" ? filesUnder(located.tree, region.path) : [];
  for (const f of files) add<FileNode>({ id: `file:${f}`, kind: "file", path: f, member: memberHolding(f, declaration.members), generated: isGenerated(declaration, f) });
  const memberNode = (name: string) => {
    const m = declaration.members.find((x) => x.name === name);
    return add<MemberNode>({ id: `member:${name}`, kind: "member", name, dir: m?.dir ?? "", memberKind: m?.kind ?? "" });
  };
  if (member) memberNode(member);

  // 1. The region's history.
  const rev = located.at ?? (tryGit(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.trim() || null);
  const shallow = tryGit(top, ["rev-parse", "--is-shallow-repository"])?.trim() === "true";
  if (shallow) reasons.push({ code: "intent-history-shallow", message: "this is a shallow clone, so the history stops at its boundary and the oldest commit listed may stand for many" });
  const workspacePrefix = located.root === "." ? "" : located.root;
  const gitPath = joinPath(workspacePrefix, region.path);
  const touched = rev ? regionHistory(top, rev, gitPath, type, region.lines) : [];
  const details = commitDetails(top, touched.map((t) => t.sha));

  // Each commit's provenance, judged by the policy at base as records judges a record's (#2547).
  const policy = policyAtBase(top, resolveBase(top));
  const attestors = policy.active ? await activeAttestors() : [];

  const readAt = (path: string): string | undefined => {
    if (!isWorkspacePath(path) || located.tree.stat(path) !== "file") return undefined;
    return located.tree.read(path);
  };
  interface Joined {
    unit?: string;
    contracts: string[];
    authorship: string[];
    /** The record ids the commit's units and contracts say they carry out. */
    decisions: string[];
  }
  const joined = new Map<string, Joined>();
  const pluginFindings: { commit: string; plugin: string; finding: PluginFinding }[] = [];
  const failedPlugins = new Set<string>();
  for (const t of touched) {
    const c = details.get(t.sha);
    if (!c) continue;
    const signature = policy.active
      ? (() => {
          const p = commitProvenance(top, policy, c.sha, attestors);
          return { level: p.level, reason: p.reason, ...(p.principal ? { principal: p.principal } : {}) };
        })()
      : { level: "unattested" as const, reason: policy.problems.length ? policy.problems.join("; ") : `no signers file (${policy.signersPath}) at base; attestation is off` };
    const pr = c.subject.match(/\(#([0-9]+)\)\s*$/);
    const cid = `commit:${c.sha}`;
    add<CommitNode>({ id: cid, kind: "commit", sha: c.sha, subject: c.subject, author: c.author, date: c.date, trailers: c.trailers, pullRequest: pr ? Number(pr[1]) : null, signature, lines: t.lines, state: null });
    edges.push({ kind: "touched-by", from: rid, to: cid, lines: t.lines });

    // 2. Each commit's origin, from the plugins.
    const entry: Joined = { contracts: [], authorship: [], decisions: [] };
    joined.set(c.sha, entry);
    for (const k of kinds) {
      if (!k.joins) continue;
      let result;
      try {
        result = await runCommitJoins(k.joins, c, { read: readAt, at: located.at }, k.name);
      } catch (err) {
        const message = `${k.display}: commitJoins failed for ${c.sha.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`;
        if (!failedPlugins.has(message)) reasons.push({ code: "intent-plugin-failed", message });
        failedPlugins.add(message);
        continue;
      }
      const joinedNode = (kind: JoinedNode["kind"], e: JoinedEntity): string => {
        const { id, ...data } = e;
        return add<JoinedNode>({ id: `${kind}:${id}`, kind, ref: id, plugin: k.display, data }).id;
      };
      const unitId = result.unit ? joinedNode("unit", result.unit) : undefined;
      const contractId = result.contract ? joinedNode("contract", result.contract) : undefined;
      if (unitId) {
        entry.unit = unitId;
        edges.push({ kind: "produced-by", from: cid, to: unitId });
        if (contractId) edges.push({ kind: "serves", from: unitId, to: contractId });
      }
      if (contractId) entry.contracts.push(result.contract!.id);
      if (unitId) entry.decisions.push(...entityDecisions(result.unit), ...entityDecisions(result.contract));
      for (const f of result.findings ?? []) pluginFindings.push({ commit: cid, plugin: k.display, finding: f });
      const evidence = result.evidence === undefined ? [] : Array.isArray(result.evidence) ? result.evidence : [result.evidence];
      for (const e of evidence) edges.push({ kind: "cites-evidence", from: unitId ?? contractId ?? cid, to: joinedNode("evidence", e) });
      entry.authorship.push(...(result.authorship ?? []));
    }
  }

  // 3. The decisions whose constrains cover the region, and their chains.
  const regionFull = region.path === "." ? workspacePrefix : gitPath;
  const origin = originRepo(top);
  const commitRefs = new Set<string>();
  for (const c of details.values()) for (const m of c.subject.matchAll(/#([0-9]+)/g)) commitRefs.add(m[1]);
  const contractIds = new Set([...joined.values()].flatMap((j) => j.contracts));
  interface Covering {
    view: RecordView;
    kind: LoadedKind;
    node: DecisionNode;
  }
  const covering: Covering[] = [];
  const decisionById = new Map<string, { view: RecordView; kind: LoadedKind }>();
  const decisionId = (k: LoadedKind, id: string) => `record:${k.records!.loaded.kind.name}/${id}`;
  const decisionNode = (k: LoadedKind, v: RecordView): DecisionNode => {
    const kind = k.records!.loaded.kind;
    const links = v.data?.[kind.supersedes.field];
    const supersedes = Array.isArray(links)
      ? links.map((l) => (l && typeof l === "object" ? (l as Record<string, unknown>)[kind.supersedes.key] : undefined)).filter((x): x is string => typeof x === "string")
      : [];
    return add<DecisionNode>({
      id: decisionId(k, v.id!),
      kind: "decision",
      recordKind: kind.name,
      record: v.id!,
      path: v.path,
      title: stringOr(v.data?.title),
      state: v.state,
      closed: v.state !== null && kind.closedStates.includes(v.state),
      valid: v.valid,
      reasons: v.reasons,
      provenance: { level: v.provenance.level, commit: v.provenance.commit, reason: v.provenance.reason },
      decided_by: stringOr(v.data?.decided_by),
      decided_on: stringOr(v.data?.decided_on),
      reviews: reviewSummary(v.data),
      supersededBy: v.supersededBy,
      supersedes,
      constrains: [],
    });
  };
  const fileNodesUnder = (full: string) => files.filter((f) => constraintCovers(full, joinPath(workspacePrefix, f)));
  for (const k of kinds) {
    if (!k.records) continue;
    const field = k.records.loaded.kind.constrains?.field;
    const kindPrefix = k.records.workspaceRoot === "." ? "" : k.records.workspaceRoot;
    for (const v of k.records.views) {
      if (v.id === null) continue;
      decisionById.set(`${k.records.loaded.kind.name}/${v.id}`, { view: v, kind: k });
      const list = field ? v.data?.[field] : undefined;
      if (!Array.isArray(list)) continue;
      const matched: { entry: string; granularity: Granularity; to: string }[] = [];
      for (const entry of list) {
        if (typeof entry !== "string") continue;
        if (entry.startsWith("path:")) {
          const p = entry.slice("path:".length);
          if (!isWorkspacePath(p)) continue;
          const full = joinPath(kindPrefix, p);
          if (regionFull !== "" && constraintCovers(full, regionFull)) {
            matched.push({ entry, granularity: "path", to: rid });
          } else if (type === "dir" && full !== regionFull && (regionFull === "" || full.startsWith(`${regionFull}/`))) {
            // A path below a directory region constrains the files under it, not the whole region.
            for (const f of fileNodesUnder(full)) matched.push({ entry, granularity: "path", to: `file:${f}` });
          }
        } else if (entry.startsWith("member:")) {
          if (member !== null && entry.slice("member:".length) === member) matched.push({ entry, granularity: "member", to: rid });
        } else {
          const issue = entry.match(ISSUE);
          if (issue && origin !== null && issue[1].toLowerCase() === origin && commitRefs.has(issue[2])) matched.push({ entry, granularity: "issue", to: rid });
          else if (contractIds.has(entry)) matched.push({ entry, granularity: "contract", to: `contract:${entry}` });
        }
      }
      if (matched.length === 0) continue;
      const node = decisionNode(k, v);
      for (const m of matched) {
        edges.push({ kind: "constrains", from: node.id, to: m.to, granularity: m.granularity, entry: m.entry });
        if (m.to === rid || m.granularity === "contract") node.constrains.push({ entry: m.entry, granularity: m.granularity });
      }
      if (node.constrains.length > 0) covering.push({ view: v, kind: k, node });
    }
  }
  // Supersession chains, both ways, as records derives them.
  const queue = [...nodes.values()].filter((n): n is DecisionNode => n.kind === "decision");
  while (queue.length > 0) {
    const d = queue.shift()!;
    const related: string[] = [];
    if (d.supersededBy) related.push(`${d.recordKind}/${d.supersededBy}`);
    for (const [key, { view }] of decisionById) if (key.startsWith(`${d.recordKind}/`) && view.supersededBy === d.record) related.push(key);
    for (const key of related) {
      const hit = decisionById.get(key);
      if (!hit) continue;
      const id = decisionId(hit.kind, hit.view.id!);
      if (nodes.has(id)) continue;
      queue.push(decisionNode(hit.kind, hit.view));
    }
  }
  const decisions = [...nodes.values()].filter((n): n is DecisionNode => n.kind === "decision");
  for (const d of decisions) {
    if (d.supersededBy) {
      const to = `record:${d.recordKind}/${d.supersededBy}`;
      if (nodes.has(to)) edges.push({ kind: "supersedes", from: to, to: d.id });
    }
  }

  // 4. The artifacts those decisions pin, and their evidence entries.
  const pinsOf = new Map<string, { decision: DecisionNode; state: PinState; sha256: string | null; actual: string | null }[]>();
  for (const d of decisions) {
    const hit = decisionById.get(`${d.recordKind}/${d.record}`)!;
    const kind = hit.kind.records!.loaded.kind;
    for (const a of hit.view.assets) {
      const list = pinsOf.get(a.path) ?? [];
      list.push({ decision: d, state: a.state, sha256: a.sha256, actual: a.actual });
      pinsOf.set(a.path, list);
    }
    const evidence = kind.pins ? hit.view.data?.[kind.pins.field] : undefined;
    if (Array.isArray(evidence)) {
      for (const e of evidence) {
        if (e === null || typeof e !== "object" || Array.isArray(e)) continue;
        const entry = e as Record<string, unknown>;
        const hashed = typeof entry.sha256 === "string" && SHA256.test(entry.sha256);
        if (isWorkspacePath(entry.path)) {
          if (hashed) continue;
          const list = pinsOf.get(entry.path) ?? [];
          list.push({ decision: d, state: "unpinned", sha256: null, actual: null });
          pinsOf.set(entry.path, list);
          find("intent-evidence-unpinned", `${d.record} names ${entry.path} as evidence with no sha256, so a later edit can't be told from what was decided on`, [d.id, `artifact:${entry.path}`]);
          continue;
        }
        if (typeof entry.url !== "string") continue;
        const ev = add<EvidenceEntryNode>({
          id: `evidence:${entry.url}`,
          kind: "evidence",
          ref: entry.url,
          plugin: null,
          data: { title: stringOr(entry.title), url: entry.url, path: null, as_of: stringOr(entry.as_of), sha256: hashed ? (entry.sha256 as string) : null },
        });
        edges.push({ kind: "cites-evidence", from: d.id, to: ev.id });
        if (!hashed) find("intent-evidence-unpinned", `${d.record} cites ${entry.url} with no hash, so what the page said when it was decided can't be checked`, [d.id, ev.id]);
      }
    }
  }
  for (const [path, pins] of pinsOf) {
    const aid = `artifact:${path}`;
    const current = pins.filter((p) => p.decision.supersededBy === null && p.state !== "unpinned");
    const worst = [...current].sort((a, b) => PIN_ORDER.indexOf(a.state) - PIN_ORDER.indexOf(b.state))[0];
    add<ArtifactNode>({
      id: aid,
      kind: "artifact",
      path,
      anchor: null,
      pinnedSha256: worst?.sha256 ?? null,
      currentSha256: pins.find((p) => p.state !== "unpinned")?.actual ?? null,
      pinState: worst?.state ?? "unpinned",
    });
    for (const p of pins) {
      edges.push({ kind: "pins", from: p.decision.id, to: aid, pinnedSha256: p.sha256, pinState: p.state });
      if (p.state === "drifted") find("intent-pin-drifted", `${path} changed after ${p.decision.record} pinned it: sha256 ${p.sha256?.slice(0, 12)} is pinned, the file hashes to ${p.actual?.slice(0, 12)}`, [p.decision.id, aid]);
      if (p.state === "missing") find("intent-pin-missing", `${p.decision.record} pins ${path}, which does not exist${located.tree.label}`, [p.decision.id, aid]);
    }
    if (!worst && pins.some((p) => p.state !== "unpinned")) {
      find("intent-artifact-unpinned", `${path} was pinned by ${[...new Set(pins.map((p) => p.decision.record))].join(", ")}, and no current decision pins it`, [aid, ...new Set(pins.map((p) => p.decision.id))]);
    }
  }

  // A path constraint that no longer resolves (#2650 A15).
  for (const d of decisions) {
    const hit = decisionById.get(`${d.recordKind}/${d.record}`)!;
    const field = hit.kind.records!.loaded.kind.constrains?.field;
    const list = field ? hit.view.data?.[field] : undefined;
    if (!Array.isArray(list)) continue;
    const kindPrefix = hit.kind.records!.workspaceRoot === "." ? "" : hit.kind.records!.workspaceRoot;
    for (const entry of list) {
      if (typeof entry !== "string" || !entry.startsWith("path:")) continue;
      const p = entry.slice("path:".length);
      if (!isWorkspacePath(p)) continue;
      const full = joinPath(kindPrefix, p);
      const inTree = workspacePrefix === "" ? full : full.startsWith(`${workspacePrefix}/`) ? full.slice(workspacePrefix.length + 1) : undefined;
      if (inTree !== undefined && located.tree.stat(inTree) === undefined) {
        find("intent-constraint-lost", `${d.record} constrains ${p}, which does not exist${located.tree.label}`, [d.id]);
      }
    }
  }

  // Which decisions covered the region at each commit's time: from the commit
  // that added the record until the commit that added the record superseding it.
  const windows = new Map<string, { from: Set<string>; until: Set<string> | null }>();
  if (rev) {
    for (const c of covering) {
      const added = addingCommit(top, rev, c.view.path);
      const successor = c.view.supersededBy ? decisionById.get(`${c.node.recordKind}/${c.view.supersededBy}`) : undefined;
      const replaced = successor ? addingCommit(top, rev, successor.view.path) : null;
      windows.set(c.node.id, { from: added ? descendants(top, added, rev) : new Set(), until: replaced ? descendants(top, replaced, rev) : null });
    }
  }
  const coveredAt = (sha: string, granularities: Granularity[]) =>
    covering.filter((c) => {
      if (!c.node.constrains.some((x) => granularities.includes(x.granularity))) return false;
      const w = windows.get(c.node.id);
      return !!w && w.from.has(sha) && !w.until?.has(sha);
    });
  const readsRecords = kinds.some((k) => k.records);
  // A decision's own work: a commit whose unit, or that unit's contract, names
  // the decision, or whose unit serves a contract the decision constrains.
  const ownWork = (j: Joined, d: DecisionNode) =>
    !!j.unit && (j.decisions.some((x) => x === d.record || x === `${d.recordKind}/${d.record}`) || d.constrains.some((x) => x.granularity === "contract" && j.contracts.includes(x.entry)));
  for (const t of touched) {
    const c = nodes.get(`commit:${t.sha}`) as CommitNode | undefined;
    if (!c) continue;
    const j = joined.get(t.sha)!;
    if (readsRecords) {
      const inWindow = coveredAt(t.sha, ["path"]);
      for (const w of inWindow) edges.push({ kind: "within", from: c.id, to: w.node.id, state: ownWork(j, w.node) ? "decided" : "decided-by-window" });
      c.state = inWindow.length === 0 ? "undecided" : inWindow.some((w) => ownWork(j, w.node)) ? "decided" : "decided-by-window";
    }
    if (readsRecords && c.state === "undecided") {
      find("intent-commit-undecided", `${t.sha.slice(0, 8)} changed the region when no decision constrained ${region.path} by path`, [c.id, rid]);
    }
    if (readsRecords && !j.unit && c.pullRequest === null && coveredAt(t.sha, ["path", "member", "contract", "issue"]).length === 0) {
      find("intent-commit-bare", `${t.sha.slice(0, 8)} names no unit, no pull request and no decision`, [c.id]);
    }
    const claims = [...new Set(j.authorship)].filter((key) => hasTrailer(c.trailers, key));
    if (claims.length > 0 && c.signature.level !== "attested") {
      find("intent-trailer-unverified", `${t.sha.slice(0, 8)} carries ${claims.join(", ")}, and the commit is ${c.signature.level}, so nothing vouches for the trailer`, [c.id]);
    }
  }

  // Findings about the region as a whole.
  if (readsRecords) {
    const current = covering.filter((c) => c.node.supersededBy === null);
    if (covering.length === 0) {
      find("intent-region-unconstrained", `no decision constrains ${region.path}`, [rid]);
    } else if (current.length === 0) {
      find("intent-decision-superseded-live", `every decision constraining ${region.path} is superseded: ${covering.map((c) => `${c.node.record} by ${c.node.supersededBy}`).join(", ")}`, [rid, ...covering.map((c) => c.node.id)]);
    } else if (current.every((c) => !c.node.closed)) {
      find("intent-decision-provisional", `the decisions constraining ${region.path} are ${[...new Set(current.map((c) => c.node.state ?? "stateless"))].join(" or ")}, and none is in a closed state`, [rid, ...current.map((c) => c.node.id)]);
    }
    const granularities = new Set(covering.flatMap((c) => c.node.constrains.map((x) => x.granularity)));
    if (covering.length > 0 && !granularities.has("path") && granularities.has("member")) {
      find("intent-constraint-coarse", `${region.path} is constrained only through its member, ${member}`, [rid, ...covering.map((c) => c.node.id)]);
    }
  }

  // 5. Links: the declared member links that touch the region's member, read in source.
  if (member) {
    let rows: LinkTableRow[] = [];
    try {
      const groups = resolveGroups(declaration, located.tree);
      const kindsRegistry = loadKindRegistry(declaration.pins, located.rootOnDisk).registry;
      rows = resolveLinks(declaration, sourceMemberHandles(declaration, located.tree, groups, kindsRegistry)).filter((r) => r.origin === "declared");
    } catch (err) {
      if (!(err instanceof WorkspaceReadError)) throw err;
    }
    rows.forEach((row, i) => {
      const producer = "producer" in row ? row.producer : null;
      if (row.consumer !== member && producer !== member) return;
      const { pointer: _pointer, ...clean } = row as LinkTableRow & { pointer?: string };
      add<LinkNode>({ id: `link:${i + 1}`, kind: "link", row: clean as LinkTableRow });
      memberNode(row.consumer);
      if (producer && declaration.members.some((m) => m.name === producer)) {
        memberNode(producer);
        edges.push({ kind: "links", from: `member:${row.consumer}`, to: `member:${producer}` });
      }
    });
  }

  // Findings last, in the order of the code list, so the same walk always prints the same way.
  findings.sort((x, y) => INTENT_FINDING_CODES.indexOf(x.code as IntentFindingCode) - INTENT_FINDING_CODES.indexOf(y.code as IntentFindingCode));
  // Then the plugins' findings, in commit order, each about its commit and the nodes its refs name.
  const resolveRef = (ref: string): string | undefined => {
    if (nodes.has(ref)) return ref;
    for (const prefix of ["commit", "unit", "contract", "evidence", "artifact", "file", "member"]) if (nodes.has(`${prefix}:${ref}`)) return `${prefix}:${ref}`;
    for (const n of nodes.values()) {
      if (n.kind === "decision" && (ref === n.record || ref === `${n.recordKind}/${n.record}`)) return n.id;
      if (n.kind === "commit" && /^[0-9a-f]{7,}$/.test(ref) && n.sha.startsWith(ref)) return n.id;
    }
    return undefined;
  };
  for (const { commit, plugin, finding } of pluginFindings) {
    const code = finding.code as PluginCode;
    const refs = finding.refs ?? [];
    const concerns = [...new Set([commit, ...refs.map(resolveRef).filter((x): x is string => x !== undefined)])];
    findings.push({ id: `finding:${code}:${findings.filter((f) => f.code === code).length + 1}`, kind: "finding", code, message: finding.message, concerns, plugin, refs });
  }
  for (const f of findings) nodes.set(f.id, f);
  const all = [...nodes.values()];
  return {
    doc: {
      ...head,
      at: located.at,
      workspace: { name: declaration.name, root: located.root },
      region: rid,
      history: { rev, follows: region.lines ? "line-range" : type === "file" ? "file" : "directory", shallow },
      kinds: kinds.map((k) => ({ file: k.display, name: k.name, records: k.records?.loaded.kind.name ?? null, joins: k.joins?.form ?? null })),
      nodes: all,
      edges,
      reasons,
      summary: {
        commits: all.filter((n) => n.kind === "commit").length,
        decisions: all.filter((n) => n.kind === "decision").length,
        artifacts: all.filter((n) => n.kind === "artifact").length,
        findings: findings.length,
      },
    },
    failed: reasons.some((r) => r.code === "intent-plugin-failed"),
  };
}
