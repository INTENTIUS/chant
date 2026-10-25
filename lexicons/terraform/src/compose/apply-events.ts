/**
 * How each member's part of a composed apply ended (chant#4442, epic #4419),
 * read from the binary's `apply -json` lines: `applied`, `partial`,
 * `failed`, `not-started` or `no-changes`, core's `GroupMemberStatus`
 * (ws-107).
 *
 * Lifted from terragucci's `packages/terragucci/src/compose.ts` at c493e0e
 * (`readApplyEvents`, `memberApply`).
 */

import type { GroupMemberStatus } from "@intentius/chant/components/capability";
import type { Composition } from "../compose";
import { stripModule, topModule } from "./module-address";

/** How one member's part of the apply ended. */
export type MemberApply = GroupMemberStatus;

/** What `apply -json` said of each module: the changes that completed, started, or errored, and the first error. */
export interface ApplyEvents {
  done: Map<string, number>;
  started: Map<string, number>;
  errored: Map<string, string>;
  /** Errors no module's resource names. */
  other: string[];
}

interface ApplyLine {
  type?: string;
  hook?: { resource?: { addr?: string }; error?: string };
  diagnostic?: { severity?: string; summary?: string; detail?: string; address?: string };
  "@message"?: string;
}

/** Read `apply -json` lines into each module's progress. A line that is not JSON is skipped. */
export function readApplyEvents(out: string, modules: readonly string[]): ApplyEvents {
  const ev: ApplyEvents = { done: new Map(), started: new Map(), errored: new Map(), other: [] };
  const known = new Set(modules);
  const moduleOf = (addr: string | undefined): string | undefined => {
    const m = addr !== undefined ? topModule(addr) : undefined;
    return m !== undefined && known.has(m) && addr !== `module.${m}` ? m : undefined;
  };
  const bump = (map: Map<string, number>, m: string) => map.set(m, (map.get(m) ?? 0) + 1);
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: ApplyLine;
    try {
      e = JSON.parse(line) as ApplyLine;
    } catch {
      continue;
    }
    const addr = e.hook?.resource?.addr;
    const m = moduleOf(addr);
    if (e.type === "apply_start" && m) bump(ev.started, m);
    else if (e.type === "apply_complete" && m) bump(ev.done, m);
    else if (e.type === "apply_errored" && m && !ev.errored.has(m)) ev.errored.set(m, `${stripModule(addr!)}: ${e.hook?.error ?? e["@message"] ?? "errored"}`);
    else if (e.type === "diagnostic" && e.diagnostic?.severity === "error") {
      const dm = moduleOf(e.diagnostic.address);
      const text = `${e.diagnostic.summary ?? "Error"}${e.diagnostic.detail ? `: ${e.diagnostic.detail.split("\n")[0]}` : ""}`;
      if (dm && !ev.errored.has(dm)) ev.errored.set(dm, `${stripModule(e.diagnostic.address!)}: Error: ${text}`);
      else if (!dm) ev.other.push(text);
    }
  }
  return ev;
}

/** How a member's part of the apply ended, from its planned changes and the events. */
export function memberApply(m: string, planned: number, ev: ApplyEvents): { apply: MemberApply; done: number } {
  const done = Math.min(ev.done.get(m) ?? 0, planned);
  if (planned === 0) return { apply: "no-changes", done: 0 };
  if (done >= planned) return { apply: "applied", done };
  if (done > 0) return { apply: "partial", done };
  if (ev.errored.has(m) || (ev.started.get(m) ?? 0) > 0) return { apply: "failed", done };
  return { apply: "not-started", done };
}

/** One member's outcome of a composed apply. */
export interface MemberApplyOutcome {
  status: MemberApply;
  /** Its planned changes that completed. */
  done: number;
  /** The first error its part named. */
  error?: string;
}

/**
 * Every member's outcome of a composed apply, by component, from the
 * `apply -json` output and each member's planned changes
 * (`PlanCounts.changes` of its slice).
 */
export function composedApplyOutcomes(c: Pick<Composition, "order" | "modules">, planned: ReadonlyMap<string, number>, out: string): { members: Record<string, MemberApplyOutcome>; other: string[] } {
  const ev = readApplyEvents(out, c.order.map((member) => c.modules.get(member)!));
  const members: Record<string, MemberApplyOutcome> = {};
  for (const member of c.order) {
    const m = c.modules.get(member)!;
    const { apply, done } = memberApply(m, planned.get(member) ?? 0, ev);
    const error = ev.errored.get(m);
    members[member] = { status: apply, done, ...(error && apply !== "applied" ? { error } : {}) };
  }
  return { members, other: ev.other };
}
