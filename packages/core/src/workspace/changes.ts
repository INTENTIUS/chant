/**
 * The forward coverage check: `chant workspace check --changes
 * <base>..<head>` (#2773).
 *
 * `graph --intent` reads the join between records and code backwards, from a
 * region to the decisions and work items whose `constrains` cover it. This
 * reads it forwards. Each path a diff changes is mapped to the current
 * records whose `constrains` cover it, and two gaps are findings with closed
 * codes:
 *
 * - `change-uncovered`: no current decided record and no open work item
 *   covers the path, by a `path:` entry that is the path or a directory
 *   above it, or by the `member:` of the member holding it.
 * - `change-out-of-scope`: a record in hand for the change lists the path in
 *   its `out_of_scope` (the field its kind names in `outOfScope`). With
 *   `--work <id>`, the records in hand are that work item and the decisions it
 *   implements; without it, every current record that covers some path the
 *   diff changes.
 *
 * A path the declaration's `changes.ignore` globs match is listed as
 * `ignored`, and a record file of a kind read as `record`: a change to the
 * records is the coverage itself. The declaration's `changes.severity` says
 * what a finding does: `off` reports none, `warn` (the default) reports them
 * and passes, `fail` reports them and fails. Nothing here runs unless the
 * check is asked for, so a workspace that never asks pays nothing.
 *
 * Records are read at `<head>`, so a change that adds the work item covering
 * it is covered. Each finding carries `triage`, the `{ finding, region }` a
 * work item's `source` takes (`work.schema.json`'s `sourceGap`), so the
 * finding-triage decision point (#2741) can seed a work item or a decision
 * from it; see {@link changeFindingSource}. When a work kind is read, each
 * finding also says whether a work item already addresses it, the way `graph
 * --intent` says it for its own findings (#2683), and
 * {@link changeFindingTriageInputs} turns a finding into that point's inputs
 * (#2794). Git is read through a local `git` subprocess only: no fetch, no
 * network.
 */

import { execFileSync } from "node:child_process";
import { relative, resolve, sep } from "node:path";
// @ts-ignore — picomatch has no types declaration
import picomatch from "picomatch";
import { declaredRecordKinds, readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError, type ChangeSeverity } from "./declaration";
import { declaredKindFile } from "./declared-kinds";
import { isGeneratedPath } from "./generated-files";
import { parseRegion } from "./intent";
import { constraintCovers, isWorkspacePath, memberHolding } from "./record-assets";
import { RecordReadError, type LoadedRecordKind, type RecordEntry } from "./records";
import { readRecordsFor } from "./records-cli";
import type { ReasonCode } from "./reason-codes";
import { joinPath } from "./tree";
import { locateWorkspace } from "./which-chant";
import { idList, isDecided } from "./work";

/** The version of the `changes` document this chant writes. */
export const CHANGES_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the document, shipped beside this file. */
export const CHANGES_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/changes/v1/changes.schema.json";

/** The finding codes. Closed: a reader may switch on them. */
export const CHANGES_FINDING_CODES = [
  /** No current decided record and no open work item covers a changed path. */
  "change-uncovered",
  /** A record in hand for the change lists a changed path in its out_of_scope. */
  "change-out-of-scope",
] as const satisfies readonly ReasonCode[];
export type ChangesFindingCode = (typeof CHANGES_FINDING_CODES)[number];

/** Why the check failed as a whole: the declaration's codes, the record kind's, or a `--work` item no record has. */
export const CHANGES_ERROR_CODES = [
  ...WORKSPACE_ERROR_CODES,
  "kind-unreadable",
  "kind-invalid",
  "schema-unreadable",
  "schema-id-mismatch",
  "schema-invalid",
  "location-missing",
  "work-item-unknown",
] as const satisfies readonly ReasonCode[];
export type ChangesErrorCode = (typeof CHANGES_ERROR_CODES)[number];

export const CHANGE_SEVERITIES = ["off", "warn", "fail"] as const satisfies readonly ChangeSeverity[];

class ChangesError extends Error {
  constructor(
    readonly code: ChangesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChangesError";
  }
}

// ── The document ─────────────────────────────────────────────────────────────

/** A record, as `<kind name>/<id>`, and the entry that ties it to the path. */
export interface ChangeRecordRef {
  record: string;
  state: string | null;
  /** The constrains or out_of_scope entry. */
  entry: string;
}

export type ChangeStatus = "covered" | "uncovered" | "out-of-scope" | "ignored" | "record";

export interface ChangedPath {
  /** From the workspace root. */
  path: string;
  change: "added" | "modified" | "deleted" | "renamed";
  /** For a rename, the path it had at base. */
  from: string | null;
  /** The member whose directory holds the path, or null. */
  member: string | null;
  /** Whether the path is a generated file, as `graph --intent` reads a region's `generated` (#2794). */
  generated: boolean;
  status: ChangeStatus;
  /** The current records covering the path, with the entry that covers it. */
  coveredBy: ChangeRecordRef[];
  /** The records in hand that put the path out of scope. */
  outOfScopeBy: ChangeRecordRef[];
  /** For an ignored path, the first glob that matched it. */
  ignoredBy: string | null;
}

export interface ChangeFinding {
  /** `finding:<code>:<path>`: one finding per path. */
  id: string;
  code: ChangesFindingCode;
  path: string;
  message: string;
  severity: "warn" | "fail";
  /** The records the finding concerns, as `<kind name>/<id>`: for out-of-scope, the records that put the path out. */
  records: string[];
  /** What a work item's `source` takes to name this gap (#2741): `{ finding, region }`. */
  triage: { finding: ChangesFindingCode; region: string };
  /**
   * Present when a work kind was read (#2794): whether a work item addresses
   * the finding, because its `source.finding` is this code and its
   * `source.region` is this path or a directory above it.
   */
  addressed?: boolean;
  /** Present when a work kind was read: the work items addressing the finding, as `<kind name>/<id>`, each with its state. */
  addressedBy?: { record: string; state: string | null }[];
}

/** The inputs of the finding-triage decision point (#2741), by the names `decisions/points.json` declares. */
export type ChangeFindingTriageInputs = {
  "finding.code": ChangesFindingCode;
  "finding.message": string;
  "finding.addressed": boolean;
  "region.path": string;
  "region.member": string | null;
  "region.generated": boolean;
};

interface Head {
  $schema: string;
  contract: number;
  chant: string;
}

export type ChangesDocument =
  | (Head & {
      workspace: { name: string; root: string };
      range: { spec: string; base: string; head: string };
      severity: ChangeSeverity;
      ignore: string[];
      /** The work item in hand, from `--work`, or null. */
      work: { record: string; state: string | null } | null;
      kinds: { file: string; name: string; role: "decision" | "work" | "other" }[];
      paths: ChangedPath[];
      findings: ChangeFinding[];
      summary: { paths: number; covered: number; uncovered: number; outOfScope: number; ignored: number; records: number };
      /** False only when severity is fail and there are findings. */
      ok: boolean;
    })
  | (Head & { error: { code: ChangesErrorCode; message: string } });

export interface ChangesQuery {
  /** Where the walk up to the declaration starts. */
  cwd: string;
  /** `<base>..<head>`, `<base>...<head>` (from their merge base), or `<base>` alone, to HEAD. */
  range: string;
  /** Kind files, relative to `cwd`. Left out, every record kind the declaration names. */
  kinds?: string[];
  /** The id of the work item in hand, such as the item an Op's work lease holds. */
  work?: string;
  /** In place of the declaration's `changes.severity`. */
  severity?: ChangeSeverity;
}

export interface ChangesResult {
  doc: ChangesDocument;
  /** The read failed, or severity is fail and there are findings. */
  failed: boolean;
}

/** The `source` a work item seeded from this finding carries (`work.schema.json`'s `sourceGap`): the seam for the finding-triage point (#2741). */
export function changeFindingSource(finding: Pick<ChangeFinding, "code" | "path">): { finding: ChangesFindingCode; region: string } {
  return { finding: finding.code, region: finding.path };
}

/**
 * The finding-triage point's inputs for a change finding and the entry in
 * `paths` it fired on (#2794), for `askPoint` or the `decide` activity. The
 * same names a caller fills from `graph --intent`'s finding and region nodes.
 * The region is the changed file, so `region.generated` is never null. A
 * document that read no work kind has no `addressed`, and it is passed as
 * false: nothing that was read addresses the finding.
 */
export function changeFindingTriageInputs(
  finding: Pick<ChangeFinding, "code" | "message" | "path" | "addressed">,
  path: Pick<ChangedPath, "path" | "member" | "generated">,
): ChangeFindingTriageInputs {
  if (path.path !== finding.path) throw new Error(`the finding fired on ${finding.path}, and the path given is ${path.path}`);
  return {
    "finding.code": finding.code,
    "finding.message": finding.message,
    "finding.addressed": finding.addressed ?? false,
    "region.path": path.path,
    "region.member": path.member,
    "region.generated": path.generated,
  };
}

// ── Git ──────────────────────────────────────────────────────────────────────

function git(top: string, args: string[]): string {
  return execFileSync("git", args, { cwd: top, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024 });
}

function commitOf(top: string, rev: string): string {
  if (rev === "" || rev.startsWith("-")) throw new ChangesError("revision-unknown", `--changes needs <base>..<head>, and ${JSON.stringify(rev)} is not a revision`);
  try {
    return git(top, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]).trim();
  } catch {
    throw new ChangesError("revision-unknown", `--changes names ${rev}, which is no commit in this repository`);
  }
}

/** The base and head commits of `<base>..<head>`, `<base>...<head>` or `<base>`. */
function resolveRange(top: string, spec: string): { base: string; head: string } {
  const three = spec.indexOf("...");
  if (three >= 0) {
    const head = commitOf(top, spec.slice(three + 3) || "HEAD");
    const other = commitOf(top, spec.slice(0, three));
    try {
      return { base: git(top, ["merge-base", other, head]).trim(), head };
    } catch {
      throw new ChangesError("revision-unknown", `${spec}: the two revisions have no merge base`);
    }
  }
  const two = spec.indexOf("..");
  if (two >= 0) return { base: commitOf(top, spec.slice(0, two)), head: commitOf(top, spec.slice(two + 2) || "HEAD") };
  return { base: commitOf(top, spec), head: commitOf(top, "HEAD") };
}

/** Each path the diff changes, from the repository root, with renames followed. */
function diffPaths(top: string, base: string, head: string, prefix: string): { path: string; change: ChangedPath["change"]; from: string | null }[] {
  const out = git(top, ["diff", "--name-status", "-z", "-M", "--no-color", base, head, "--", prefix === "" ? "." : prefix]);
  const tokens = out.split("\0");
  const paths: { path: string; change: ChangedPath["change"]; from: string | null }[] = [];
  for (let i = 0; i < tokens.length && tokens[i] !== ""; ) {
    const status = tokens[i];
    if (status.startsWith("R") || status.startsWith("C")) {
      paths.push({ path: tokens[i + 2], change: status.startsWith("R") ? "renamed" : "added", from: status.startsWith("R") ? tokens[i + 1] : null });
      i += 3;
    } else {
      paths.push({ path: tokens[i + 1], change: status === "A" ? "added" : status === "D" ? "deleted" : "modified", from: null });
      i += 2;
    }
  }
  return paths;
}

// ── The check ────────────────────────────────────────────────────────────────

const toPosix = (p: string) => (sep === "/" ? p : p.split(sep).join("/"));

interface ReadKind {
  file: string;
  loaded: LoadedRecordKind;
  records: RecordEntry[];
  /** The kind's workspace root, from the repository root; "" for the top. */
  prefix: string;
  role: "decision" | "work" | "other";
}

/** A work record's `source` when it names the gap it came from, as `{ finding, region }`, or null. */
function gapSource(data: Record<string, unknown> | null): { finding: string; region: string } | null {
  const src = data?.source;
  if (src === null || typeof src !== "object" || Array.isArray(src)) return null;
  const s = src as Record<string, unknown>;
  return typeof s.finding === "string" && typeof s.region === "string" ? { finding: s.finding, region: s.region } : null;
}

/** A record's list field, as strings. */
function stringList(data: Record<string, unknown> | null, field: string | undefined): string[] {
  const list = field ? data?.[field] : undefined;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

/** Run the check and build the document. Never throws a {@link WorkspaceReadError} or {@link RecordReadError}. */
export async function checkChanges(query: ChangesQuery): Promise<ChangesResult> {
  const head: Head = { $schema: CHANGES_OUTPUT_SCHEMA_ID, contract: CHANGES_CONTRACT_VERSION, chant: readerVersion() };
  try {
    const doc = await run(query, head);
    return { doc, failed: !doc.ok };
  } catch (err) {
    if (err instanceof ChangesError || err instanceof WorkspaceReadError || err instanceof RecordReadError) {
      return { doc: { ...head, error: { code: err.code as ChangesErrorCode, message: err.message } }, failed: true };
    }
    throw err;
  }
}

async function run(query: ChangesQuery, head: Head): Promise<Exclude<ChangesDocument, { error: unknown }>> {
  const top = locateWorkspace(query.cwd).top;
  if (!top) throw new ChangesError("not-a-git-repository", "the change check reads a git diff, and this directory is not in a git repository");
  const range = resolveRange(top, query.range);
  // The declaration and the records as the change leaves them.
  const located = locateWorkspace(query.cwd, range.head);
  const declaration = readDeclaration(located.tree, "", { rootChant: true });
  const severity = query.severity ?? declaration.changes?.severity ?? "warn";
  const ignore = declaration.changes?.ignore ?? [];
  const workspacePrefix = located.root === "." ? "" : located.root;

  const kindFiles = query.kinds?.map((k) => resolve(query.cwd, k)) ?? declaredRecordKinds(declaration).map((d) => declaredKindFile(d, located.rootOnDisk));
  const kinds: ReadKind[] = [];
  for (const file of kindFiles) {
    const read = await readRecordsFor({ kind: file, cwd: query.cwd, at: range.head });
    const { kind } = read.loaded;
    kinds.push({
      file: toPosix(relative(located.rootOnDisk, file)),
      loaded: read.loaded,
      records: read.result.records,
      prefix: read.workspaceRoot === "." ? "" : read.workspaceRoot,
      role: kind.work ? "work" : kind.constrains ? "decision" : "other",
    });
  }
  const ref = (k: ReadKind, r: RecordEntry) => `${k.loaded.kind.name}/${r.id}`;
  /** Current: a decision not superseded and in a decided state, or a work item not closed. Invalid records cover nothing. */
  const current = (k: ReadKind, r: RecordEntry): boolean => {
    if (!r.valid || r.id === null || r.supersededBy !== null) return false;
    if (k.role === "work") return r.state === null || !(k.loaded.kind.closedStates ?? []).includes(r.state);
    return k.role === "decision" && isDecided(k.loaded.kind, r.state);
  };
  /** The `path:` and `member:` entries of a record that cover `full` (from the repository root). */
  const covers = (k: ReadKind, r: RecordEntry, full: string, member: string | null): string[] =>
    stringList(r.data, k.loaded.kind.constrains?.field).filter((entry) => {
      if (entry.startsWith("path:")) {
        const p = entry.slice("path:".length);
        return isWorkspacePath(p) && constraintCovers(joinPath(k.prefix, p), full);
      }
      return entry.startsWith("member:") && member !== null && entry.slice("member:".length) === member;
    });
  /** The out_of_scope entries of a record that cover `full`. */
  const excludes = (k: ReadKind, r: RecordEntry, full: string): string[] =>
    stringList(r.data, k.loaded.kind.outOfScope?.field).filter((p) => isWorkspacePath(p) && constraintCovers(joinPath(k.prefix, p), full));

  // The work item in hand, and the decisions it implements.
  let work: { kind: ReadKind; record: RecordEntry } | null = null;
  if (query.work !== undefined) {
    for (const k of kinds.filter((x) => x.role === "work")) {
      const r = k.records.find((x) => x.id === query.work);
      if (r) {
        work = { kind: k, record: r };
        break;
      }
    }
    if (!work) throw new ChangesError("work-item-unknown", `--work ${query.work}: no work record of the kinds read has that id`);
  }

  const isMatch = ignore.length > 0 ? ignore.map((g) => ({ glob: g, match: picomatch(g, { dot: true }) as (p: string) => boolean })) : [];
  const recordFiles = new Set(kinds.flatMap((k) => k.records.map((r) => r.path)));
  const changed = diffPaths(top, range.base, range.head, workspacePrefix);
  const inWorkspace = (full: string) => (workspacePrefix === "" ? full : full.slice(workspacePrefix.length + 1));

  const paths: ChangedPath[] = changed.map((c) => {
    const path = inWorkspace(c.path);
    const member = memberHolding(path, declaration.members);
    const coveredBy: ChangeRecordRef[] = [];
    for (const k of kinds) {
      for (const r of k.records) {
        if (!current(k, r)) continue;
        const entries = covers(k, r, c.path, member);
        if (entries.length > 0 && excludes(k, r, c.path).length === 0) coveredBy.push({ record: ref(k, r), state: r.state, entry: entries[0] });
      }
    }
    const ignoredBy = isMatch.find((m) => m.match(path))?.glob ?? null;
    const status: ChangeStatus = recordFiles.has(c.path) ? "record" : ignoredBy !== null ? "ignored" : coveredBy.length > 0 ? "covered" : "uncovered";
    const generated = isGeneratedPath(declaration, path);
    return { path, change: c.change, from: c.from === null ? null : inWorkspace(c.from), member, generated, status, coveredBy, outOfScopeBy: [], ignoredBy };
  });

  // The records in hand: the work item and what it implements, or every current record covering some changed path.
  const inHand: { kind: ReadKind; record: RecordEntry }[] = [];
  if (work) {
    inHand.push(work);
    const implemented = new Set(idList(work.record.data, work.kind.loaded.kind.work!.implements));
    for (const k of kinds.filter((x) => x.role === "decision")) for (const r of k.records) if (r.id !== null && implemented.has(r.id)) inHand.push({ kind: k, record: r });
  } else {
    for (const k of kinds) {
      for (const r of k.records) {
        if (!current(k, r)) continue;
        if (changed.some((c) => covers(k, r, c.path, memberHolding(inWorkspace(c.path), declaration.members)).length > 0)) inHand.push({ kind: k, record: r });
      }
    }
  }
  for (const [i, p] of paths.entries()) {
    if (p.status === "record" || p.status === "ignored") continue;
    for (const h of inHand) {
      const entries = excludes(h.kind, h.record, changed[i].path);
      if (entries.length > 0) p.outOfScopeBy.push({ record: ref(h.kind, h.record), state: h.record.state, entry: entries[0] });
    }
    if (p.outOfScopeBy.length > 0) p.status = "out-of-scope";
  }

  // A work item addresses a finding when it came from that gap (#2794), as
  // graph --intent's fromGap reads it (#2683): the item's source names the
  // finding's code, on a region that is the path or a directory above it.
  // Every work item with an id counts, in any state, as there: a done item
  // whose gap fires again still says the gap was taken once. Only the gap
  // source counts. graph --intent also counts an item that implements a
  // decision a pin finding concerns, and no change finding concerns a
  // decision that way.
  const workKinds = kinds.filter((k) => k.role === "work");
  const addressing = (code: ChangesFindingCode, full: string): { record: string; state: string | null }[] => {
    const by: { record: string; state: string | null }[] = [];
    for (const k of workKinds) {
      for (const r of k.records) {
        if (r.id === null) continue;
        const src = gapSource(r.data);
        if (src === null || src.finding !== code) continue;
        const parsed = parseRegion(src.region);
        if ("error" in parsed) continue;
        const named = joinPath(k.prefix, parsed.path);
        // A change finding is about a whole file, so a line range on the same file still names it.
        if (named === full || named === "" || full.startsWith(`${named}/`)) by.push({ record: ref(k, r), state: r.state });
      }
    }
    return by;
  };

  const findings: ChangeFinding[] = [];
  if (severity !== "off") {
    for (const [i, p] of paths.entries()) {
      let f: ChangeFinding | null = null;
      if (p.status === "uncovered") {
        const where = p.member ? `, in member ${p.member},` : "";
        f = finding("change-uncovered", p, severity, `${p.path}${where} is ${p.change}, and no current decided record or open work item covers it by path or member`, []);
      } else if (p.status === "out-of-scope") {
        const by = p.outOfScopeBy.map((o) => `${o.record} (${o.entry})`).join(", ");
        f = finding("change-out-of-scope", p, severity, `${p.path} is ${p.change}, and ${by} ${p.outOfScopeBy.length === 1 ? "puts" : "put"} it out of scope`, p.outOfScopeBy.map((o) => o.record));
      }
      if (f === null) continue;
      if (workKinds.length > 0) {
        f.addressedBy = addressing(f.code, changed[i].path);
        f.addressed = f.addressedBy.length > 0;
      }
      findings.push(f);
    }
  }
  const count = (s: ChangeStatus) => paths.filter((p) => p.status === s).length;
  return {
    ...head,
    workspace: { name: declaration.name, root: located.root },
    range: { spec: query.range, base: range.base, head: range.head },
    severity,
    ignore,
    work: work ? { record: ref(work.kind, work.record), state: work.record.state } : null,
    kinds: kinds.map((k) => ({ file: k.file, name: k.loaded.kind.name, role: k.role })),
    paths,
    findings,
    summary: { paths: paths.length, covered: count("covered"), uncovered: count("uncovered"), outOfScope: count("out-of-scope"), ignored: count("ignored"), records: count("record") },
    ok: !(severity === "fail" && findings.length > 0),
  };
}

function finding(code: ChangesFindingCode, p: ChangedPath, severity: "warn" | "fail", message: string, records: string[]): ChangeFinding {
  return { id: `finding:${code}:${p.path}`, code, path: p.path, message, severity, records, triage: changeFindingSource({ code, path: p.path }) };
}

// ── Under a work lease ───────────────────────────────────────────────────────

/**
 * For a checkout on a work branch, `chant/work/[<member>/]<id>`, as an Op
 * with `changesCheckout` works in (#2748): the range from where the branch
 * left the main worktree's HEAD to its own HEAD, and the item's id. Undefined
 * on any other branch.
 */
export function workBranchChanges(cwd: string): { range: string; work: string } | undefined {
  let branch: string;
  try {
    branch = git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
  } catch {
    return undefined;
  }
  if (!branch.startsWith("chant/work/")) return undefined;
  const id = branch.slice(branch.lastIndexOf("/") + 1);
  // The main worktree comes first in the list.
  const list = git(cwd, ["worktree", "list", "--porcelain"]);
  const mainHead = list.split("\n").find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length).trim();
  if (!mainHead) return undefined;
  try {
    const base = git(cwd, ["merge-base", mainHead, "HEAD"]).trim();
    return { range: `${base}..HEAD`, work: id };
  } catch {
    return undefined;
  }
}
