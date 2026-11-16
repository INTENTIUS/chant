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

import type { K8sMemberReport } from "./workspace-member";

let lastReport: K8sMemberReport | undefined;

export function setLastMemberReport(report: K8sMemberReport | undefined): void {
  lastReport = report;
}

export function lastMemberReport(): K8sMemberReport | undefined {
  return lastReport;
}
