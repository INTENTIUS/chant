/**
 * Cross-stack edges marked stale, current or unknown (#4617).
 *
 * A member here reads a stack that no member of this workspace applies (a
 * Pulumi `StackReference` the pulumi lexicon lists as outside, #4547). When
 * a control repo governs the repositories, its entries say which project
 * owns that stack (an entry's `estates`), and its apply records
 * (./applied.ts) say when that project last applied. The edge is:
 *
 * - `stale`: the owner applied after the reader last updated, so the reader
 *   holds outputs that may have changed since;
 * - `current`: the reader updated after the owner's last apply;
 * - `unknown`: no entry claims the stack, two do, the owner has no apply on
 *   record, the reader has never updated, or the control repo was not read.
 *
 * The reader's last update is the time its stack export records (Pulumi's
 * `deployment.manifest.time`). Only names and times are compared: never an
 * output's value.
 */

import type { ControlEntry } from "./records";
import { CONTROL_DIR_ENV, parseProjectKey } from "./dispatch";
import type { ControlAppliedRecord } from "./applied";

/** One read of a stack outside the workspace, as the plan found it. */
export interface CrossStackRead {
  /** The member that reads it. */
  member: string;
  /** The stack's name as the program wrote it: `<org>/<project>/<stack>`, `<project>/<stack>` or `<stack>`. */
  stack: string;
  /** When the reader last updated, from its export. Absent when it has never updated. */
  lastUpdate?: string;
}

/** A cross-stack edge with its mark. */
export interface CrossStackEdge extends CrossStackRead {
  status: "stale" | "current" | "unknown";
  /** The project the control repo's entries give the stack to. */
  owner?: string;
  /** The owner's newest apply on record. */
  ownerApplied?: { at: string; sha: string; outcome: string };
  /** Why the mark is what it is, in a few words. */
  why: string;
}

/** What the control repo says, as {@link markCrossStackEdges} reads it. */
export interface ControlEdgeFacts {
  entries: readonly ControlEntry[];
  /** Each member's newest apply (`latestControlApplies`). */
  applies: ReadonlyMap<string, ControlAppliedRecord>;
}

/** The trailing `<project>/<stack>` of a stack name, or the bare stack. */
function tail(name: string, parts: number): string {
  return name.split("/").slice(-parts).join("/");
}

/**
 * The projects whose entries claim `stack`: an estate with the same name, or
 * the same `<project>/<stack>` once an org is dropped. A bare stack name
 * matches only an estate of that exact name, since its project is the
 * reader's own.
 */
function ownersOf(stack: string, entries: readonly ControlEntry[]): string[] {
  const depth = stack.split("/").length >= 2 ? 2 : Number.POSITIVE_INFINITY;
  const out = new Set<string>();
  for (const e of entries) {
    if (e.entry !== "project" || !e.project) continue;
    if (e.estates.some((estate) => estate === stack || (estate.split("/").length >= depth && tail(estate, depth) === tail(stack, depth)))) out.add(e.project);
  }
  return [...out].sort();
}

/** The member name a project's dispatch carries: its entry's `settings.member`, else the repository's name. */
export function controlMemberOf(entry: Pick<ControlEntry, "project" | "settings">): string | undefined {
  const named = entry.settings.member;
  if (typeof named === "string" && named !== "") return named;
  if (!entry.project) return undefined;
  try {
    return parseProjectKey(entry.project).name;
  } catch {
    return undefined;
  }
}

/** Each read marked from the control repo's facts; with no facts, every edge is unknown. Sorted by member, then stack. */
export function markCrossStackEdges(reads: readonly CrossStackRead[], facts: ControlEdgeFacts | undefined): CrossStackEdge[] {
  const out: CrossStackEdge[] = [];
  for (const read of reads) {
    const base: CrossStackRead = { member: read.member, stack: read.stack, ...(read.lastUpdate ? { lastUpdate: read.lastUpdate } : {}) };
    if (!facts) {
      out.push({ ...base, status: "unknown", why: "the control repo was not read" });
      continue;
    }
    const owners = ownersOf(read.stack, facts.entries);
    if (owners.length === 0) {
      out.push({ ...base, status: "unknown", why: "no control entry claims the stack" });
      continue;
    }
    if (owners.length > 1) {
      out.push({ ...base, status: "unknown", why: `claimed by ${owners.join(" and ")}` });
      continue;
    }
    const owner = owners[0]!;
    const entry = facts.entries.find((e) => e.project === owner)!;
    const member = controlMemberOf(entry);
    const applied = member ? facts.applies.get(member) : undefined;
    if (!applied) {
      out.push({ ...base, status: "unknown", owner, why: "the owner has no apply on record" });
      continue;
    }
    const ownerApplied = { at: applied.at, sha: applied.sha, outcome: applied.outcome };
    if (!read.lastUpdate || Number.isNaN(Date.parse(read.lastUpdate))) {
      out.push({ ...base, status: "unknown", owner, ownerApplied, why: "the reader has not updated yet" });
      continue;
    }
    const stale = Date.parse(applied.at) > Date.parse(read.lastUpdate);
    out.push({ ...base, status: stale ? "stale" : "current", owner, ownerApplied, why: stale ? "the owner applied after the reader last updated" : "the reader updated after the owner's last apply" });
  }
  return out.sort((a, b) => (a.member < b.member ? -1 : a.member > b.member ? 1 : a.stack < b.stack ? -1 : a.stack > b.stack ? 1 : 0));
}

/**
 * The control repo's facts read from a checkout of it (`dir`, with its
 * `chant/lifecycle` fetched), or undefined when it cannot be read. Entries
 * are read leniently: the note marks what it can.
 */
export async function readControlEdgeFacts(dir: string): Promise<ControlEdgeFacts | undefined> {
  try {
    const { gitControlLedger, readControlEntries } = await import("./records");
    const { gitControlAppliedLedger, latestControlApplies, parseControlApplied } = await import("./applied");
    const entries = await readControlEntries(gitControlLedger({ cwd: dir }), { lenient: true });
    const { records } = parseControlApplied(await gitControlAppliedLedger({ cwd: dir }).read());
    return { entries, applies: latestControlApplies(records) };
  } catch {
    return undefined;
  }
}

/** The variable naming a checkout of the control repo a note job reads the facts from ({@link controlNoteCheckout} sets it). */
export { CONTROL_DIR_ENV };

/**
 * A report with its cross-stack edges marked again from `facts` (#4617).
 * Only each edge's reader, stack and last update are taken from the report;
 * the mark, the owner and the owner's apply come from the facts, so a
 * report that names a mark of its own never shows it.
 */
export function remarkCrossStackEdges<T extends { crossStackEdges?: CrossStackEdge[] }>(report: T, facts: ControlEdgeFacts | undefined): T {
  const edges = report.crossStackEdges;
  if (!Array.isArray(edges) || edges.length === 0) return report;
  const reads: CrossStackRead[] = [];
  for (const e of edges) {
    if (!e || typeof e.member !== "string" || typeof e.stack !== "string") continue;
    reads.push({ member: e.member, stack: e.stack, ...(typeof e.lastUpdate === "string" ? { lastUpdate: e.lastUpdate } : {}) });
  }
  return { ...report, crossStackEdges: markCrossStackEdges(reads, facts) };
}

/** The facts from the checkout {@link CONTROL_DIR_ENV} names, or undefined when it names none or it cannot be read. */
export async function controlEdgeFactsFromEnv(env: Record<string, string | undefined> = process.env): Promise<ControlEdgeFacts | undefined> {
  const dir = env[CONTROL_DIR_ENV];
  return dir ? readControlEdgeFacts(dir) : undefined;
}
