/**
 * `chant workspace search <query> [--member <name>] [--env <name>]
 * [--snapshot <ref> | --live] [--at <rev>] [--explain] [--count-by ...]
 * [--show a,b] [--json]` (#4374): `chant search` over every member of a
 * declared workspace, as one `search` document of the read contract.
 *
 * Members are read the way `chant workspace graph` reads them, through the same
 * fan-out (`readMembers` in `graph-cli.ts`): the same plan, each member under
 * its own chant (ws-021), one process per toolchain, `--at <rev>` from an
 * export of the tree at that commit, and a member of a package's kind in its
 * reader project. Each member runs its own `chant search ... --json`, so the
 * terms evaluate in the member, under the member's chant, over the graph that
 * member's `chant graph` draws. Ids are then `<member>/<id>`, the rule
 * `workspace graph` composes with (`composedId`), so a row names the node the
 * graph names.
 *
 * Each member's answer stands alone: a path that crosses from one member into
 * another is not walked, and every searched member says so with `alone: true`.
 * A member that could not be searched is listed with a reason code and no
 * answer, never as zero matches. Members are stamped by the rule of ws-059.
 *
 * Two times stay apart. `--at <rev>` is the git revision, as for every
 * contract read, and the document's `at` is that commit. `--snapshot <ref>`
 * replays a recorded lifecycle snapshot, and `source.snapshot` names it. The
 * two are not taken together, and `--at` given a snapshot ref such as
 * `latest` is refused with a hint naming `--snapshot`.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext, ParsedArgs } from "../cli/registry";
import { composedId } from "./compose-graph";
import { readerVersion, WorkspaceReadError } from "./declaration";
import { readMembers } from "./graph-cli";
import type { GraphIR } from "../graph-ir";
import type { Toolchain, UnitResult } from "./member-commands";
import {
  SEARCH_CONTRACT_VERSION,
  SEARCH_ERROR_CODES,
  SEARCH_MEMBER_REASON_CODES,
  SEARCH_OUTPUT_SCHEMA_ID,
  type SearchErrorCode,
  type SearchHead,
  type SearchMemberReasonCode,
  type WorkspaceSearchErrorCode,
} from "./search-contract";
import { handToRootChant } from "./which-chant";

const USAGE =
  'chant workspace search "<query>" [--member <name>] [--env <name>] [--snapshot <ref> | --live] [--at <rev>] [--explain] [--count-by kind|module|attr:<name>] [--show a,b] [--json]';

/** The flags of `chant search` a member gets as they were given. */
type SearchFlags = Pick<
  Partial<ParsedArgs>,
  "env" | "snapshot" | "live" | "ambient" | "explain" | "countBy" | "show" | "checkLive" | "checkSnapshot" | "failOnDrift"
>;

export interface WorkspaceSearchQuery {
  /** Where the walk up to the declaration starts. */
  cwd: string;
  query: string;
  /** The git revision to search the source at (`--at`). */
  at?: string;
  /** Only these members. */
  members?: string[];
  flags?: SearchFlags;
  /** The chant for members with none of their own; the running chant by default. */
  reader?: Toolchain;
  /** Called with each member's stderr. */
  onStderr?: (text: string) => void;
}

/** A row as a member's `chant search --json` prints it. */
interface MemberMatch {
  id: string;
  displayId: string;
  kind?: string;
  physicalId?: string;
  unobserved?: string;
  show?: Record<string, unknown>;
  paths: {
    term: string;
    dir: "out" | "in";
    hops: { from: string; fromAttr?: string; to: string; toAttr?: string; edge?: string }[];
    /** On a `cap:` term (#4375): the sets the match relied on, each with its path. */
    because?: { capability: string; id: string; hops: { from: string; to: string }[] }[];
  }[];
}

/** The answer of one member's `chant search --json`, rows or groups. */
interface MemberAnswer {
  query: string;
  source: Record<string, unknown>;
  matches?: MemberMatch[];
  countBy?: string;
  groups?: { group: string; count: number; ids?: string[] }[];
  total?: number;
  provenance?: string;
  liveFailures?: string[];
  explain?: {
    universe: { matched: number; of: number; kinds: string[] };
    evidence: { id: string; attr: string; via: string }[];
    nearMisses: { id: string; fails?: string }[];
    moreExcluded: number;
  };
  drift?: Record<string, unknown>;
}

export interface SearchMember {
  name: string;
  dir: string;
  kind: string;
  /** `searched` when the member answered, `skipped` when its kind isn't run, `failed` when it has no answer. */
  status: "searched" | "skipped" | "failed";
  reason: { code: SearchMemberReasonCode; message: string } | null;
  /** The chant version that read the member, when its toolchain said. */
  chant: string | null;
  /** The member's stamp, by the rule of ws-059, or null. */
  stamp: string | null;
  /** On a searched member: its terms and paths saw only its own graph. */
  alone?: true;
  source?: Record<string, unknown>;
  /** The member's matched ids, `<member>/<id>`. */
  matches?: string[];
  groups?: { group: string; count: number; ids?: string[] }[];
  total?: number;
  provenance?: string;
  liveFailures?: string[];
  explain?: MemberAnswer["explain"];
  drift?: Record<string, unknown>;
}

interface WorkspaceHead extends SearchHead {
  workspace: { name: string; root: string };
  /** The commit searched, or null for the working tree. */
  at: string | null;
  query: string;
  /** Which observation answered: `declared`, `live` or `snapshot`, with `env` and the `snapshot` ref asked for. */
  source: { kind: "declared" | "live" | "snapshot"; env?: string; snapshot?: string };
  members: SearchMember[];
}

export type WorkspaceSearchDocument =
  | (WorkspaceHead & { matches: (MemberMatch & { member: string })[] })
  | (WorkspaceHead & { countBy: string; groups: { group: string; count: number; ids?: string[] }[]; total: number })
  | (SearchHead & { query: string; error: { code: WorkspaceSearchErrorCode | SearchErrorCode; message: string; hint?: string } });

export interface WorkspaceSearchResult {
  doc: WorkspaceSearchDocument;
  /** The search was refused, or a member failed, had a failed live read, or failed its drift check. */
  failed: boolean;
}

/** The command line each member runs: its own `chant search`, the query after `--` so one opening with `-` stays a query. */
export function memberSearchArgv(query: string, flags: SearchFlags = {}): string[] {
  return [
    "search",
    ...(flags.env ? ["--env", flags.env] : []),
    ...(flags.snapshot ? ["--snapshot", flags.snapshot] : []),
    ...(flags.live ? ["--live"] : []),
    ...(flags.ambient ? ["--ambient"] : []),
    ...(flags.explain ? ["--explain"] : []),
    ...(flags.countBy ? ["--count-by", flags.countBy] : []),
    ...(flags.show ? ["--show", flags.show] : []),
    ...(flags.checkLive ? ["--check-live"] : []),
    ...(flags.checkSnapshot ? ["--check-snapshot"] : []),
    ...(flags.failOnDrift ? ["--fail-on-drift"] : []),
    "--json",
    "--",
    query,
  ];
}

/** The last line of `stdout` that parses as a JSON object, or undefined. */
function lastJsonObject(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const v = JSON.parse(lines[i]) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {
      // Not this line.
    }
  }
  return undefined;
}

const KNOWN_REFUSALS = new Set<string>(SEARCH_ERROR_CODES);

/**
 * Read one member's run: its answer, or why it has none. A chant that prints
 * no `search` document of the contract is `member-chant-too-old` when it
 * predates `workspace member-run`, says it has no such command or flag, or
 * prints `search --json` from before the contract (no `contract` field).
 */
export function readMemberSearch(r: Pick<UnitResult, "exitCode" | "stdout" | "stderr" | "chant">): { answer: MemberAnswer } | { reason: { code: SearchMemberReasonCode; message: string } } {
  const doc = lastJsonObject(r.stdout);
  if (doc && doc.$schema === SEARCH_OUTPUT_SCHEMA_ID && doc.contract === SEARCH_CONTRACT_VERSION) {
    const error = doc.error as { code?: unknown; message?: unknown; hint?: unknown } | undefined;
    if (error && typeof error === "object") {
      const code = String(error.code);
      const message = `${String(error.message)}${typeof error.hint === "string" ? `; ${error.hint}` : ""}`;
      return KNOWN_REFUSALS.has(code)
        ? { reason: { code: code as SearchMemberReasonCode, message } }
        : { reason: { code: "output-unreadable", message: `the member's search refused with ${code}, which this chant does not know: ${message}` } };
    }
    if (!Array.isArray(doc.matches) && !Array.isArray(doc.groups)) {
      return { reason: { code: "output-unreadable", message: "the member's search document has neither matches nor groups" } };
    }
    return { answer: doc as unknown as MemberAnswer };
  }
  const version = r.chant ? `chant ${r.chant}` : "a chant older than workspace member-run";
  const unknownSurface = /Unknown (command|flag)/i.test(r.stderr);
  const preContract = doc !== undefined && doc.contract === undefined && ("matches" in doc || "groups" in doc || "error" in doc);
  if (r.chant === null || unknownSurface || preContract) {
    return {
      reason: {
        code: "member-chant-too-old",
        message: `the member runs ${version}, which prints no search document of the read contract (#4374); install a newer @intentius/chant for this member`,
      },
    };
  }
  const tail = r.stderr.trim().split("\n").slice(-5).join("\n");
  if (r.exitCode !== 0) return { reason: { code: "command-failed", message: `chant search exited ${r.exitCode}${tail ? `: ${tail}` : ""}` } };
  return { reason: { code: "output-unreadable", message: "the member's chant search printed no search document" } };
}

/** `ids` with each one prefixed by its member. */
const prefixAll = (member: string, ids: unknown): unknown => (Array.isArray(ids) ? ids.map((id) => (typeof id === "string" ? composedId(member, id) : id)) : ids);

/** A member's drift, with every node id in it `<member>/<id>`. */
function prefixDrift(member: string, drift: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...drift };
  for (const key of ["missing", "orphan", "disappeared", "newlyObserved"]) if (key in out) out[key] = prefixAll(member, out[key]);
  const rows = (key: string, fields: string[]) => {
    if (!Array.isArray(out[key])) return;
    out[key] = (out[key] as Record<string, unknown>[]).map((row) => {
      const copy = { ...row };
      for (const f of fields) if (typeof copy[f] === "string") copy[f] = composedId(member, copy[f] as string);
      return copy;
    });
  };
  rows("drifted", ["id"]);
  rows("unobserved", ["id"]);
  rows("runtimeChildren", ["id", "owner"]);
  return out;
}

/** A member's row, with its id and each hop's ends `<member>/<id>`, as `workspace graph` names them. */
function prefixMatch(member: string, m: MemberMatch): MemberMatch & { member: string } {
  return {
    ...m,
    id: composedId(member, m.id),
    member,
    paths: (m.paths ?? []).map((p) => ({
      ...p,
      hops: p.hops.map((h) => ({ ...h, from: composedId(member, h.from), to: composedId(member, h.to) })),
      ...(p.because
        ? { because: p.because.map((b) => ({ ...b, id: composedId(member, b.id), hops: b.hops.map((h) => ({ ...h, from: composedId(member, h.from), to: composedId(member, h.to) })) })) }
        : {}),
    })),
  };
}

/**
 * Sort groups by count, highest first, then by name: the order `--count-by`
 * prints. A group carries `ids` (#4382) when every member that counted into it
 * listed its own; a member on an older chant lists none, and then the merged
 * group has a count and no ids, rather than ids that fall short of it.
 */
function sortGroups(groups: Map<string, { count: number; ids: string[] | null }>): { group: string; count: number; ids?: string[] }[] {
  return [...groups]
    .map(([group, g]) => ({ group, count: g.count, ...(g.ids ? { ids: g.ids } : {}) }))
    .sort((a, b) => b.count - a.count || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
}

/** The source the document's top names, from the flags: which observation answered. */
function topSource(flags: SearchFlags): WorkspaceHead["source"] {
  if (flags.live) return { kind: "live", ...(flags.env ? { env: flags.env } : {}) };
  if (flags.snapshot) return { kind: "snapshot", ...(flags.env ? { env: flags.env } : {}), snapshot: flags.snapshot };
  return { kind: "declared" };
}

/** Search every member and compose the document. Never throws a {@link WorkspaceReadError}. */
export async function workspaceSearch(q: WorkspaceSearchQuery): Promise<WorkspaceSearchResult> {
  const head: SearchHead = { $schema: SEARCH_OUTPUT_SCHEMA_ID, contract: SEARCH_CONTRACT_VERSION, chant: readerVersion() };
  const flags = q.flags ?? {};
  const query = q.query.trim();
  const refuse = (code: WorkspaceSearchErrorCode | SearchErrorCode, message: string, hint?: string): WorkspaceSearchResult => ({
    doc: { ...head, query, error: { code, message, ...(hint ? { hint } : {}) } },
    failed: true,
  });

  // The two times (#4374): --at is the git revision, --snapshot the recorded estate.
  if (flags.snapshot !== undefined && q.at !== undefined) {
    return refuse(
      "snapshot-at-revision",
      `--snapshot ${flags.snapshot} replays a recorded snapshot over the source in the working tree, and --at ${q.at} reads the source at a revision; chant workspace search takes one of them`,
      "search the source at a commit with --at <rev>, or answer from a recorded snapshot with --snapshot <ref>",
    );
  }
  if (flags.live && q.at !== undefined) {
    return refuse("live-at-revision", "--live reads the account as it stands now, and --at reads the source at a revision; chant workspace search takes one of them");
  }
  // The query and flags are refused once, here, with the codes a member would give.
  const { checkSearchArgs } = await import("../cli/handlers/search");
  const checked = checkSearchArgs(flags, query, { ref: flags.snapshot, flag: "--snapshot" });
  if ("error" in checked) return refuse(checked.error.code, checked.error.message, checked.error.hint);
  // Capability terms (#4375) run once, over the composed graph.
  const { usesCapability } = await import("../cli/handlers/search");
  if (checked.terms.some(usesCapability)) {
    if (flags.live || flags.snapshot !== undefined || checked.countBy || flags.checkLive || flags.checkSnapshot) {
      return refuse(
        "usage-invalid",
        "a capability term over a workspace answers from the composed declared graph, so it takes no --live, --snapshot, --check-live, --check-snapshot or --count-by",
        "search a member's own project for a live answer: chant search \"cap:...\" --live --env <name>",
      );
    }
    return composedCapabilitySearch(q, head, query, checked.terms);
  }

  try {
    const read = await readMembers(
      { cwd: q.cwd, at: q.at, members: q.members, reader: q.reader, onStderr: q.onStderr, args: {} },
      { cache: false, argvFor: () => memberSearchArgv(query, flags) },
    );
    const { located, declaration, plan, results, stamps } = read;
    const byId = new Map(results.map((r) => [r.id, r]));
    const members: SearchMember[] = [];
    const matches: (MemberMatch & { member: string })[] = [];
    const groups = new Map<string, { count: number; ids: string[] | null }>();
    let failed = plan.unreadable.length > 0;
    for (const m of declaration.members) {
      if (q.members?.length && !q.members.includes(m.name)) continue;
      const entry: SearchMember = { name: m.name, dir: m.dir, kind: m.kind, status: "skipped", reason: null, chant: null, stamp: stamps.get(m.name) ?? null };
      const r = byId.get(m.name);
      if (!r) {
        const unreadable = plan.unreadable.find((s) => s.name === m.name);
        const skipped = plan.skipped.find((s) => s.name === m.name);
        const why = unreadable ?? skipped;
        entry.status = unreadable ? "failed" : "skipped";
        entry.reason = why ? { code: why.reason.code as SearchMemberReasonCode, message: why.reason.message } : null;
        members.push(entry);
        continue;
      }
      entry.chant = r.chant;
      const got = readMemberSearch(r);
      if ("reason" in got) {
        failed = true;
        entry.status = "failed";
        entry.reason = got.reason;
        members.push(entry);
        continue;
      }
      const a = got.answer;
      // A member that answered and still exited 1 had a failed live read, or failed --fail-on-drift.
      if (r.exitCode !== 0) failed = true;
      entry.status = "searched";
      entry.alone = true;
      entry.source = a.source;
      if (Array.isArray(a.matches)) {
        const rows = a.matches.map((x) => prefixMatch(m.name, x));
        matches.push(...rows);
        entry.matches = rows.map((x) => x.id);
      }
      if (Array.isArray(a.groups)) {
        // Each group's ids (#4382) as `workspace graph` gives the same nodes: `<member>/<id>`.
        entry.groups = a.groups.map((g) => (Array.isArray(g.ids) ? { ...g, ids: g.ids.map((id) => composedId(m.name, id)) } : g));
        entry.total = a.total ?? a.groups.reduce((n, g) => n + g.count, 0);
        // A module is a member's own: `module.vpc` in two members is two modules.
        for (const g of entry.groups) {
          const name = checked.countBy?.by === "module" ? composedId(m.name, g.group) : g.group;
          const was = groups.get(name);
          const ids = Array.isArray(g.ids) && (!was || was.ids) ? [...(was?.ids ?? []), ...g.ids] : null;
          groups.set(name, { count: (was?.count ?? 0) + g.count, ids });
        }
      }
      if (a.provenance !== undefined) entry.provenance = a.provenance;
      if (a.liveFailures?.length) entry.liveFailures = a.liveFailures;
      if (a.explain) {
        entry.explain = {
          ...a.explain,
          evidence: a.explain.evidence.map((e) => ({ ...e, id: composedId(m.name, e.id) })),
          nearMisses: a.explain.nearMisses.map((n) => ({ ...n, id: composedId(m.name, n.id) })),
        };
      }
      if (a.drift) entry.drift = prefixDrift(m.name, a.drift);
      members.push(entry);
    }
    const top: WorkspaceHead = {
      ...head,
      workspace: { name: declaration.name, root: located.root },
      at: located.at,
      query,
      source: topSource(flags),
      members,
    };
    if (checked.countBy) {
      const merged = sortGroups(groups);
      return { doc: { ...top, countBy: flags.countBy!.trim(), groups: merged, total: merged.reduce((n, g) => n + g.count, 0) }, failed };
    }
    matches.sort((a, b) => a.id.localeCompare(b.id));
    return { doc: { ...top, matches }, failed };
  } catch (err) {
    if (!(err instanceof WorkspaceReadError)) throw err;
    // --at is a git revision here; a snapshot ref such as `latest` names no commit (#4374).
    const hint =
      err.code === "revision-unknown" && q.at !== undefined
        ? `--at is a git revision in the read contract; to answer from a recorded snapshot, use --snapshot ${q.at === "true" ? "latest" : q.at} --env <name>`
        : undefined;
    return refuse(err.code as WorkspaceSearchErrorCode, err.message, hint);
  }
}

/**
 * A query with capability terms (#4375): the rules run once, under this
 * chant, over the graph `chant workspace graph` composes, so a path may cross
 * from one member into another wherever the composed graph has an edge. Each
 * member's graph is read under its own chant, as `workspace graph` reads it
 * (`readMembers`); the lexicon mappings are this chant's, loaded for every
 * lexicon a chant member uses. A member is `searched` without `alone`.
 */
async function composedCapabilitySearch(
  q: WorkspaceSearchQuery,
  head: SearchHead,
  query: string,
  terms: Parameters<typeof import("../cli/handlers/search").answerOverGraph>[1],
): Promise<WorkspaceSearchResult> {
  const { answerOverGraph } = await import("../cli/handlers/search");
  const { workspaceGraph } = await import("./graph-cli");
  const { workspaceLexicons } = await import("./capabilities-contract");
  const { loadPlugin } = await import("../cli/plugins");
  // Detail 3: each member's full property trees, which the rules read
  // (a policy document, an inline ingress block).
  const { doc: graph, failed: graphFailed } = await workspaceGraph({ cwd: q.cwd, at: q.at, members: q.members, reader: q.reader, onStderr: q.onStderr, args: { detail: 3 } });
  if ("error" in graph) {
    const e = graph.error as { code: string; message: string };
    return { doc: { ...head, query, error: { code: e.code as WorkspaceSearchErrorCode, message: e.message } }, failed: true };
  }
  const packs = [];
  for (const name of await workspaceLexicons(q.cwd)) {
    try {
      const pack = (await loadPlugin(name)).capabilityPack;
      if (pack) packs.push(pack);
    } catch {
      // Not installed here: the catalog's lexicons say so (lexicon-not-loaded).
    }
  }
  const g = graph as unknown as {
    workspace: { name: string; root: string };
    at: string | null;
    nodes: GraphIR["nodes"];
    edges: GraphIR["edges"];
    members: { name: string; dir: string; kind: string; status: string; reason: { code: string; message: string } | null; chant?: string | null; stamp?: string | null }[];
  };
  const ir: GraphIR = { nodes: g.nodes, edges: g.edges, groups: {} } as GraphIR;
  const answer = answerOverGraph(ir, terms, query, packs);
  if ("error" in answer) {
    return { doc: { ...head, query, error: { code: "query-invalid", message: answer.error.message, ...(answer.error.hint ? { hint: answer.error.hint } : {}) } }, failed: true };
  }
  const known = new Set<string>(SEARCH_MEMBER_REASON_CODES);
  const members: SearchMember[] = g.members.map((m) => ({
    name: m.name,
    dir: m.dir,
    kind: m.kind,
    status: m.status === "composed" ? "searched" : m.reason ? "failed" : "skipped",
    reason: m.reason
      ? { code: (known.has(m.reason.code) ? m.reason.code : "output-unreadable") as SearchMemberReasonCode, message: m.reason.message }
      : null,
    chant: m.chant ?? null,
    stamp: m.stamp ?? null,
    ...(m.status === "composed"
      ? {
          source: { kind: "declared" },
          matches: answer.matches.filter((x) => x.id.startsWith(`${m.name}/`)).map((x) => x.id),
          provenance: "declared only · capabilities evaluated once over the composed workspace graph",
        }
      : {}),
  }));
  const matches = answer.matches
    .map((x) => {
      const member = x.id.slice(0, x.id.indexOf("/"));
      return { ...x, member, displayId: x.id.slice(member.length + 1) };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const doc = {
    ...head,
    workspace: g.workspace,
    at: g.at,
    query,
    source: { kind: "declared" },
    members,
    matches,
    capabilities: answer.capabilities,
  } as unknown as WorkspaceSearchDocument;
  return { doc, failed: graphFailed };
}

/** The text form: one row per match, or the merged groups, then each member that has no answer. */
function printText(doc: WorkspaceSearchDocument): void {
  if ("error" in doc) return;
  if ("groups" in doc) {
    const width = String(doc.groups[0]?.count ?? 0).length;
    for (const g of doc.groups) console.log(`${String(g.count).padStart(width)}  ${g.group}`);
    console.log(`— ${doc.total} total · ${doc.groups.length} group${doc.groups.length === 1 ? "" : "s"} by ${doc.countBy}`);
  } else if (doc.matches.length === 0) {
    console.log("(no matches)");
  } else {
    for (const m of doc.matches) {
      const show = Object.entries(m.show ?? {}).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      console.log([`${m.member}/${m.displayId}`, m.kind ?? "", ...(m.physicalId ? [m.physicalId] : []), ...show].join("  "));
    }
  }
  const searched = doc.members.filter((m) => m.status === "searched").length;
  // Capability terms (#4375) ran once over the composed graph, not per member.
  const caps = (doc as { capabilities?: { name: string; notEvaluated: string[] }[] }).capabilities;
  for (const c of caps ?? []) if (c.notEvaluated.length > 0) console.log(`— ${c.name} does not evaluate: ${c.notEvaluated.join("; ")}`);
  const together = searched > 0 && doc.members.every((m) => m.status !== "searched" || !m.alone);
  for (const m of doc.members) if (m.status === "failed" && m.reason) console.error(formatError({ message: `member ${m.name}: ${m.reason.code}: ${m.reason.message}` }));
  const failed = doc.members.filter((m) => m.status === "failed").length;
  const skipped = doc.members.filter((m) => m.status === "skipped").length;
  console.error(`chant workspace search: ${searched} member${searched === 1 ? "" : "s"} searched, ${together ? "together over the composed graph" : "each alone"}; ${failed} failed; ${skipped} skipped`);
}

export async function runWorkspaceSearch(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  const cwd = resolve(".");
  if (!existsSync(cwd)) {
    console.error(formatError({ message: `${cwd} does not exist`, hint: USAGE }));
    return 1;
  }
  // The root's chant reads the declaration (ws-021).
  const handed = await handToRootChant(cwd, args.at);
  if (handed !== undefined) return handed;
  // The capability catalog (#4375): rules run once, under the workspace's
  // chant, so the catalog is this chant's, for every lexicon a member loads.
  if (args.capabilities) {
    const { printCapabilities } = await import("../cli/handlers/search");
    const { workspaceLexicons } = await import("./capabilities-contract");
    return printCapabilities(args, args.extraPositional ?? "", await workspaceLexicons(cwd));
  }
  const { doc, failed } = await workspaceSearch({
    cwd,
    query: args.extraPositional ?? "",
    at: args.at,
    members: args.members,
    flags: {
      env: args.env,
      snapshot: args.snapshot,
      live: args.live,
      ambient: args.ambient,
      explain: args.explain,
      countBy: args.countBy,
      show: args.show,
      checkLive: args.checkLive,
      checkSnapshot: args.checkSnapshot,
      failOnDrift: args.failOnDrift,
    },
    onStderr: (text) => process.stderr.write(text),
  });
  if (args.json) console.log(JSON.stringify(doc));
  if ("error" in doc) {
    console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: doc.error.hint ?? USAGE }));
    return 1;
  }
  if (!args.json) printText(doc);
  return failed ? 1 : 0;
}
