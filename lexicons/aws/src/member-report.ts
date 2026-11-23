/**
 * The report of the workspace member read in this process (#3179).
 * `graphMeta` receives only the entities, so the hook that read the member
 * leaves its report here for the hook that publishes it; `chant graph` runs
 * the two in order in one process.
 *
 * Kept apart from ./workspace-member.ts so the plugin can clear and read the
 * report without loading the member reader, which a project with no member
 * never needs (#5219).
 */

import type { AwsMemberReport } from "./workspace-member";

let lastReport: AwsMemberReport | undefined;

export function setLastMemberReport(report: AwsMemberReport | undefined): void {
  lastReport = report;
}

export function lastMemberReport(): AwsMemberReport | undefined {
  return lastReport;
}

/** One stack a member names, and the declared entities the live read asks it for. */
export interface MemberStackRead {
  stack: string;
  region?: string;
  /** Entity name (the member's node id, `<member>/<LogicalId>`) to the stack's logical id. */
  logicalIds: Map<string, string>;
}

/**
 * The stacks a live read of a member that names deployed stacks
 * (`cloudformation-stacks.json`, #5455) asks, from the report its build left
 * here (#5504). Each node the build drew from a stack is read from that stack,
 * in the stack's region, by its logical id: the node's own id carries the
 * member's name and does not match the stack's `LogicalResourceId`. `rest` is
 * every other entity asked about (a template file beside the stacks), read as
 * before. Undefined when the report names no stack or names none of the
 * entities asked about, such as a report another project's build left.
 */
export function memberStackReads(
  report: AwsMemberReport | undefined,
  entityNames: string[],
): { reads: MemberStackRead[]; rest: string[] } | undefined {
  if (!report?.stacks?.length) return undefined;
  const asked = new Set(entityNames);
  const claimed = new Set<string>();
  const reads: MemberStackRead[] = [];
  for (const s of report.stacks) {
    if (!s.read) continue;
    const logicalIds = new Map<string, string>();
    for (const r of s.resources) {
      if (!asked.has(r.node) || claimed.has(r.node)) continue;
      logicalIds.set(r.node, r.logicalId);
      claimed.add(r.node);
    }
    if (logicalIds.size > 0) reads.push({ stack: s.name, ...(s.region ? { region: s.region } : {}), logicalIds });
  }
  if (reads.length === 0) return undefined;
  return { reads, rest: entityNames.filter((n) => !claimed.has(n)) };
}
