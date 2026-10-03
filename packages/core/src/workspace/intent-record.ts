/**
 * The intent walk for one record: `chant workspace graph --intent --record
 * <id>`.
 *
 * `graph --intent <path>` answers for one region. A decision's `constrains`
 * may list several `path:` and `member:` entries, and a reader drawing the
 * decision's drift wants every commit that changed any of them while the
 * decision stood. This walk reads the history of each entry the way the
 * region walk does (`git log --follow` for a file, `git log` for a
 * directory, and for a member, its directory less the members nested in it),
 * keeps each commit once, and keeps the commits inside the record's window:
 * from the commit that decided it, or added it when it is not approved
 * (`record-decided.ts`), until the commit that opened the window of the
 * record superseding it.
 *
 * Each commit gets one bucket, relative to this record, in this order:
 *
 * - `own`: the record's own work, as the region walk judges it: a commit a
 *   plugin joins to a unit whose unit or contract names the record, or that
 *   serves a contract the record constrains; or a commit whose own trailers
 *   (#3149) name the record, or a work item that implements it.
 * - `worked`: inside the window of a work item that is not dropped and that
 *   implements the record, or whose `path:` entries cover a file the commit
 *   changed in the record's region.
 * - `within-other`: inside the window of another decision whose `path:`
 *   entries cover a file the commit changed in the record's region.
 * - `unexplained`: none of these.
 *
 * `workedBy` and `alsoWithin` list every work item and other decision that
 * matched, whatever the bucket. `issue` and `contract` entries are listed and
 * not walked: they name no path. Git is read through a local `git`
 * subprocess only: no fetch, no network.
 */

import { declaredRecordKinds, readDeclaration, readerVersion, WorkspaceReadError } from "./declaration";
import { declaredKindFile } from "./declared-kinds";
import { entityDecisions, runCommitJoins } from "./intent-joins";
import {
  addingCommit,
  closingCommit,
  commitDetails,
  descendants,
  IntentError,
  loadKinds,
  regionHistory,
  tryGit,
  windowOpening,
  type IntentErrorCode,
  type IntentReason,
  type LoadedKind,
} from "./intent";
import { constraintCovers, isWorkspacePath, memberHolding } from "./record-assets";
import type { DecidedIn } from "./record-decided";
import { RecordReadError } from "./records";
import type { RecordView } from "./records-cli";
import { runsForCommits, type RunRef } from "./runs";
import { readTrailerJoins, type CommitTrailerJoins } from "./trailer-joins";
import { joinPath } from "./tree";
import { locateWorkspace } from "./which-chant";
import { idList } from "./work";

/** The version of the `intent-record` document this chant writes. */
export const INTENT_RECORD_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for the document, shipped beside this file. */
export const INTENT_RECORD_OUTPUT_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/intent-record/v1/intent-record.schema.json";

export const INTENT_RECORD_BUCKETS = ["own", "worked", "within-other", "unexplained"] as const;
export type IntentRecordBucket = (typeof INTENT_RECORD_BUCKETS)[number];

export interface RecordConstraint {
  entry: string;
  granularity: "path" | "member" | "contract" | "issue";
  /** For a path entry, from the workspace root; for a member entry, the member's directory. Null otherwise. */
  path: string | null;
  /** For a path entry, whether the path is in the tree read; for a member entry, whether the declaration names the member. Null for an entry that is not walked. */
  exists: boolean | null;
  /** Whether its history was read. */
  walked: boolean;
}

export interface RecordRef {
  recordKind: string;
  record: string;
  state: string | null;
}

export interface RecordCommit {
  sha: string;
  subject: string;
  author: { name: string; email: string };
  date: string;
  trailers: Record<string, string[]>;
  pullRequest: number | null;
  /** The unit a plugin joined the commit to, or null. */
  unit: string | null;
  /** What chant's own trailers join the commit to (#3149), as a commit node in `graph --intent` reports it. */
  joins: CommitTrailerJoins;
  /** The agent runs that made the commit (#3033): the one its Chant-Run names, and any whose record lists it. */
  runs: RunRef[];
  /** The record's constrains entries whose history listed the commit. */
  entries: string[];
  /** The files the commit changed in the record's region, from the workspace root. Empty when git lists none, as for a merge that changed nothing against its first parent there. */
  files: string[];
  bucket: IntentRecordBucket;
  /** Every work item whose window holds the commit and that implements the record or covers one of its files by path. */
  workedBy: RecordRef[];
  /** Every other decision whose window holds the commit and whose path entries cover one of its files. */
  alsoWithin: RecordRef[];
}

interface Head {
  $schema: string;
  contract: number;
  chant: string;
}

export type IntentRecordDocument =
  | (Head & {
      at: string | null;
      workspace: { name: string; root: string };
      record: {
        id: string;
        recordKind: string;
        record: string;
        path: string;
        title: string | null;
        state: string | null;
        supersededBy: string | null;
        decidedIn: DecidedIn | null;
        constrains: RecordConstraint[];
      };
      history: { rev: string | null; shallow: boolean };
      /** The commit the window opens at, and the one it closes at (the superseding record's opening), or null. */
      window: { from: string | null; until: string | null };
      kinds: { file: string; name: string; records: string | null; joins: "function" | "data" | null }[];
      commits: RecordCommit[];
      counts: { commits: number; own: number; worked: number; withinOther: number; unexplained: number; outsideWindow: number };
      reasons: IntentReason[];
    })
  | (Head & { error: { code: IntentErrorCode; message: string } });

export interface IntentRecordQuery {
  cwd: string;
  /** The record's id, or `<kind name>/<id>`. */
  record: string;
  at?: string;
  kinds?: string[];
}

export interface IntentRecordResult {
  doc: IntentRecordDocument;
  failed: boolean;
}

const stringOr = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Build the document. Never throws an {@link IntentError}, {@link WorkspaceReadError} or {@link RecordReadError}. */
export async function intentRecord(query: IntentRecordQuery): Promise<IntentRecordResult> {
  const head: Head = { $schema: INTENT_RECORD_OUTPUT_SCHEMA_ID, contract: INTENT_RECORD_CONTRACT_VERSION, chant: readerVersion() };
  try {
    return await walk(query, head);
  } catch (err) {
    if (err instanceof IntentError || err instanceof WorkspaceReadError || err instanceof RecordReadError) {
      return { doc: { ...head, error: { code: err.code as IntentErrorCode, message: err.message } }, failed: true };
    }
    throw err;
  }
}

async function walk(query: IntentRecordQuery, head: Head): Promise<IntentRecordResult> {
  const located = locateWorkspace(query.cwd, query.at);
  const top = located.top;
  if (!top) throw new IntentError("not-a-git-repository", "the intent walk reads git history, and this directory is not in a git repository");
  const declaration = readDeclaration(located.tree, "", { rootChant: true });
  const kindFiles = query.kinds ?? declaredRecordKinds(declaration).map((d) => declaredKindFile(d, located.rootOnDisk));
  const kinds = await loadKinds({ cwd: query.cwd, region: "", at: query.at, kinds: kindFiles }, top);
  const workspacePrefix = located.root === "." ? "" : located.root;
  const kindPrefix = (k: LoadedKind) => (k.records!.workspaceRoot === "." ? "" : k.records!.workspaceRoot);
  const fromWorkspace = (full: string) => (workspacePrefix === "" ? full : full.startsWith(`${workspacePrefix}/`) ? full.slice(workspacePrefix.length + 1) : full === workspacePrefix ? "." : full);

  // The record, among the decision kinds read.
  const slash = query.record.indexOf("/");
  const [wantKind, wantId] = slash > 0 ? [query.record.slice(0, slash), query.record.slice(slash + 1)] : [null, query.record];
  const decisionKinds = kinds.filter((k) => k.records && !k.records.loaded.kind.work);
  const hit = decisionKinds
    .filter((k) => wantKind === null || k.records!.loaded.kind.name === wantKind)
    .flatMap((k) => k.records!.views.filter((v) => v.id === wantId).map((v) => ({ kind: k, view: v })))[0];
  if (!hit) {
    const kindsRead = decisionKinds.map((k) => k.records!.loaded.kind.name);
    throw new IntentError("intent-record-unknown", `no record of ${kindsRead.length > 0 ? `the decision kinds read (${kindsRead.join(", ")})` : "a decision kind: none was read"} has the id ${query.record}`);
  }
  const kind = hit.kind.records!.loaded.kind;
  const view = hit.view;

  const rev = located.at ?? (tryGit(top, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])?.trim() || null);
  const shallow = tryGit(top, ["rev-parse", "--is-shallow-repository"])?.trim() === "true";
  const reasons: IntentReason[] = [];
  if (shallow) reasons.push({ code: "intent-history-shallow", message: "this is a shallow clone, so the history stops at its boundary and the oldest commit listed may stand for many" });

  // Each constrains entry, and the commits its history lists.
  const constrains: RecordConstraint[] = [];
  const pathEntries: { entry: string; full: string }[] = [];
  const memberEntries: { entry: string; name: string }[] = [];
  const listed = new Map<string, string[]>();
  const list = kind.constrains?.field ? view.data?.[kind.constrains.field] : undefined;
  for (const entry of Array.isArray(list) ? list : []) {
    if (typeof entry !== "string") continue;
    if (entry.startsWith("path:")) {
      const p = entry.slice("path:".length);
      if (!isWorkspacePath(p)) {
        constrains.push({ entry, granularity: "path", path: null, exists: null, walked: false });
        continue;
      }
      const full = joinPath(kindPrefix(hit.kind), p);
      const type = located.tree.stat(fromWorkspace(full));
      constrains.push({ entry, granularity: "path", path: fromWorkspace(full), exists: type !== undefined, walked: rev !== null });
      pathEntries.push({ entry, full });
      if (!rev) continue;
      for (const t of regionHistory(top, rev, full, type === "file" ? "file" : "dir", null)) (listed.get(t.sha) ?? listed.set(t.sha, []).get(t.sha)!).push(entry);
    } else if (entry.startsWith("member:")) {
      const name = entry.slice("member:".length);
      const m = declaration.members.find((x) => x.name === name);
      constrains.push({ entry, granularity: "member", path: m ? m.dir : null, exists: !!m, walked: !!m && rev !== null });
      if (!m) continue;
      memberEntries.push({ entry, name });
      if (!rev) continue;
      // The member's directory, less the members nested inside it.
      const dir = joinPath(workspacePrefix, m.dir);
      const nested = declaration.members.filter((x) => x.name !== m.name && x.dir !== m.dir && (m.dir === "." || x.dir.startsWith(`${m.dir}/`))).map((x) => `:(exclude)${joinPath(workspacePrefix, x.dir)}`);
      const out = tryGit(top, ["log", "--format=%H", rev, "--", dir === "" ? "." : dir, ...nested]);
      for (const sha of (out ?? "").split("\n").map((s) => s.trim()).filter(Boolean)) (listed.get(sha) ?? listed.set(sha, []).get(sha)!).push(entry);
    } else {
      constrains.push({ entry, granularity: /^[^/\s]+\/[^/\s]+#[0-9]+$/.test(entry) ? "issue" : "contract", path: null, exists: null, walked: false });
    }
  }

  // The record's window, and each other decision's, opened the same way.
  const decisionIndex = new Map<string, { kind: LoadedKind; view: RecordView }>();
  for (const k of decisionKinds) for (const v of k.records!.views) if (v.id !== null) decisionIndex.set(`${k.records!.loaded.kind.name}/${v.id}`, { kind: k, view: v });
  const decisionWindow = (k: LoadedKind, v: RecordView) => {
    const from = rev ? windowOpening(top, rev, v) : null;
    const successor = v.supersededBy ? decisionIndex.get(`${k.records!.loaded.kind.name}/${v.supersededBy}`) : undefined;
    const until = rev && successor ? windowOpening(top, rev, successor.view) : null;
    return { from, until, fromSet: from && rev ? descendants(top, from, rev) : new Set<string>(), untilSet: until && rev ? descendants(top, until, rev) : null };
  };
  const inWindow = (w: { fromSet: Set<string>; untilSet: Set<string> | null }, sha: string) => w.fromSet.has(sha) && !w.untilSet?.has(sha);
  const own = decisionWindow(hit.kind, view);
  const shas = [...listed.keys()].filter((sha) => inWindow(own, sha));
  const details = commitDetails(top, shas);
  // Newest first by commit date, as git log lists them.
  const order = (shas.length > 0 ? tryGit(top, ["rev-list", "--no-walk=sorted", "--stdin"], `${shas.join("\n")}\n`) : "")?.split("\n").map((s) => s.trim()).filter(Boolean) ?? shas;
  shas.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  // The files each commit changed in the record's region.
  const inRegion = (f: string) => pathEntries.some((p) => constraintCovers(p.full, f)) || memberEntries.some((m) => memberHolding(fromWorkspace(f), declaration.members) === m.name);
  const files = new Map<string, string[]>();
  if (shas.length > 0) {
    const text = tryGit(top, ["log", "--no-walk=unsorted", "--stdin", "--format=%x00%H", "--name-only", "--no-renames", "--diff-merges=first-parent"], `${shas.join("\n")}\n`) ?? "";
    for (const chunk of text.split("\0")) {
      if (!chunk) continue;
      const [sha, ...names] = chunk.split("\n").map((s) => s.trim());
      files.set(sha, [...new Set(names.filter((f) => f !== "" && inRegion(f)))].map(fromWorkspace));
    }
  }

  // Other decisions with path entries, and work items, with their windows, read once each.
  const pathsOf = (k: LoadedKind, v: RecordView): string[] => {
    const field = k.records!.loaded.kind.constrains?.field;
    const entries = field ? v.data?.[field] : undefined;
    return (Array.isArray(entries) ? entries : []).filter((e): e is string => typeof e === "string" && e.startsWith("path:") && isWorkspacePath(e.slice(5))).map((e) => joinPath(kindPrefix(k), e.slice(5)));
  };
  const allFiles = [...new Set([...files.values()].flat())].map((f) => joinPath(workspacePrefix, f));
  const others: { ref: RecordRef; paths: string[]; window: ReturnType<typeof decisionWindow> }[] = [];
  for (const [, o] of decisionIndex) {
    if (o.view === view) continue;
    const paths = pathsOf(o.kind, o.view);
    if (!paths.some((p) => allFiles.some((f) => constraintCovers(p, f)))) continue;
    others.push({ ref: { recordKind: o.kind.records!.loaded.kind.name, record: o.view.id!, state: o.view.state }, paths, window: decisionWindow(o.kind, o.view) });
  }
  const works: { ref: RecordRef; paths: string[]; implementsRecord: boolean; window: { fromSet: Set<string>; untilSet: Set<string> | null } }[] = [];
  for (const k of kinds.filter((x) => x.records?.loaded.kind.work)) {
    const wk = k.records!.loaded.kind;
    for (const v of k.records!.views) {
      if (v.id === null) continue;
      const dropped = v.state !== null && v.state !== wk.work!.done && (wk.closedStates ?? []).includes(v.state);
      if (dropped) continue;
      const implementsRecord = idList(v.data, wk.work!.implements).includes(view.id!);
      const paths = pathsOf(k, v);
      if (!implementsRecord && !paths.some((p) => allFiles.some((f) => constraintCovers(p, f)))) continue;
      const added = rev ? addingCommit(top, rev, v.path) : null;
      const closing = rev && wk.stateField ? closingCommit(top, rev, v.path, wk.stateField, wk.closedStates ?? []) : null;
      const untilSet = closing && rev ? descendants(top, closing, rev) : null;
      if (closing) untilSet!.delete(closing);
      works.push({ ref: { recordKind: wk.name, record: v.id, state: v.state }, paths, implementsRecord, window: { fromSet: added && rev ? descendants(top, added, rev) : new Set(), untilSet } });
    }
  }

  // Each commit's origin, from the plugins, and its bucket.
  const readAt = (path: string): string | undefined => (isWorkspacePath(path) && located.tree.stat(path) === "file" ? located.tree.read(path) : undefined);
  const listAt = (dir: string): string[] | undefined => {
    const d = dir === "." ? "" : dir.replace(/\/+$/, "");
    if (d !== "" && (!isWorkspacePath(d) || located.tree.stat(d) !== "dir")) return undefined;
    return located.tree.list(d)?.map((e) => `${joinPath(d, e.name)}${e.type === "dir" ? "/" : ""}`).sort();
  };
  const failedPlugins = new Set<string>();
  const constrainedContracts = constrains.filter((c) => c.granularity === "contract").map((c) => c.entry);
  const commits: RecordCommit[] = [];
  // chant's own trailers (#3149): the record named outright, or a work item that implements it.
  const trailerJoins = readTrailerJoins(top, [...details.values()]);
  const recordKinds = new Map(kinds.filter((k) => k.records).map((k) => [k.records!.loaded.kind.name, k]));
  const workKinds = kinds.filter((k) => k.records?.loaded.kind.work);
  const runJoins = await runsForCommits(
    top,
    located.rootOnDisk,
    shas.map((sha) => ({ sha, run: trailerJoins.get(sha)?.joins.run ?? null })),
  );
  const workImplements = (k: LoadedKind, id: string): boolean | undefined => {
    const v = k.records!.views.find((x) => x.id === id);
    return v ? idList(v.data, k.records!.loaded.kind.work!.implements).includes(view.id!) : undefined;
  };
  for (const sha of shas) {
    const c = details.get(sha);
    if (!c) continue;
    let unit: string | null = null;
    let isOwn = false;
    const joins = trailerJoins.get(sha)!.joins;
    for (const r of joins.records) {
      const k = recordKinds.get(r.kind);
      if (!k || !k.records!.views.some((v) => v.id === r.id)) continue;
      r.node = `record:${r.kind}/${r.id}`;
      if (k.records!.loaded.kind.work ? workImplements(k, r.id) : r.kind === kind.name && r.id === view.id) isOwn = true;
    }
    const item = joins.lease?.item;
    if (item) {
      const holding = workKinds.filter((k) => k.records!.views.some((v) => v.id === item));
      if (holding.length === 1 && workImplements(holding[0], item)) isOwn = true;
    }
    for (const k of kinds) {
      if (!k.joins) continue;
      let result;
      try {
        result = await runCommitJoins(k.joins, c, { read: readAt, list: listAt, at: located.at }, k.name);
      } catch (err) {
        const message = `${k.display}: commitJoins failed for ${sha.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`;
        if (!failedPlugins.has(message)) reasons.push({ code: "intent-plugin-failed", message });
        failedPlugins.add(message);
        continue;
      }
      if (!result.unit) continue;
      unit ??= result.unit.id;
      const named = [...entityDecisions(result.unit), ...entityDecisions(result.contract)];
      if (named.some((x) => x === view.id || x === `${kind.name}/${view.id}`)) isOwn = true;
      if (result.contract && constrainedContracts.includes(result.contract.id)) isOwn = true;
    }
    const changed = (files.get(sha) ?? []).map((f) => joinPath(workspacePrefix, f));
    const covers = (paths: string[]) => paths.some((p) => changed.some((f) => constraintCovers(p, f)));
    const workedBy = works.filter((w) => inWindow(w.window, sha) && (w.implementsRecord || covers(w.paths))).map((w) => w.ref);
    const alsoWithin = others.filter((o) => inWindow(o.window, sha) && covers(o.paths)).map((o) => o.ref);
    const pr = c.subject.match(/\(#([0-9]+)\)\s*$/);
    commits.push({
      sha,
      subject: c.subject,
      author: c.author,
      date: c.date,
      trailers: c.trailers,
      pullRequest: pr ? Number(pr[1]) : null,
      unit,
      joins,
      runs: runJoins.refs.get(sha) ?? [],
      entries: listed.get(sha)!,
      files: files.get(sha) ?? [],
      bucket: isOwn ? "own" : workedBy.length > 0 ? "worked" : alsoWithin.length > 0 ? "within-other" : "unexplained",
      workedBy,
      alsoWithin,
    });
  }

  const count = (b: IntentRecordBucket) => commits.filter((c) => c.bucket === b).length;
  return {
    doc: {
      ...head,
      at: located.at,
      workspace: { name: declaration.name, root: located.root },
      record: {
        id: `record:${kind.name}/${view.id}`,
        recordKind: kind.name,
        record: view.id!,
        path: view.path,
        title: stringOr(view.data?.title),
        state: view.state,
        supersededBy: view.supersededBy,
        decidedIn: view.decidedIn ?? null,
        constrains,
      },
      history: { rev, shallow },
      window: { from: own.from, until: own.until },
      kinds: kinds.map((k) => ({ file: k.display, name: k.name, records: k.records?.loaded.kind.name ?? null, joins: k.joins?.form ?? null })),
      commits,
      counts: { commits: commits.length, own: count("own"), worked: count("worked"), withinOther: count("within-other"), unexplained: count("unexplained"), outsideWindow: listed.size - shas.length },
      reasons,
    },
    failed: reasons.some((r) => r.code === "intent-plugin-failed"),
  };
}
