/**
 * The pulumi member's constants and last-read state (#3179). The plugin and
 * the post-synth rules read these without loading the member reader in
 * ./workspace-member.ts, which a project with no member never needs (#5219).
 */

import type { PulumiMemberReport } from "./workspace-member";

/** The conventional place of the export, in the member's directory. */
export const PULUMI_EXPORT_FILE = "stack-export.json";

/**
 * What the last member read in this process saw, for the post-synth checks
 * PUL003 to PUL015 (`./lint/post-synth/`). It holds the parsed export, so it
 * stays in the process and never reaches the graph's `meta`, which carries
 * only {@link PulumiMemberReport}.
 */
export interface PulumiMemberRead {
  /** The member's directory, absolute. */
  dir: string;
  /** The label the entities are keyed by. */
  label: string;
  /** `pulumi.member.engine`, when the config sets it. */
  engine?: "pulumi" | "plunge";
  /** `pulumi.member.stack`, when the config sets it. */
  stack?: string;
  /** The parsed export, the index store's or the checked-in `stack-export.json`; undefined when there is none or it is not JSON. */
  doc?: unknown;
}

let lastRead: PulumiMemberRead | undefined;

/** Left by the plugin's `buildRoots` beside the report; see {@link PulumiMemberRead}. */
export function setLastMemberRead(read: PulumiMemberRead | undefined): void {
  lastRead = read;
}

export function lastMemberRead(): PulumiMemberRead | undefined {
  return lastRead;
}

let lastReport: PulumiMemberReport | undefined;

/** The report of the read in this process, left for `graphMeta` (see the aws member reader). */
export function setLastMemberReport(report: PulumiMemberReport | undefined): void {
  lastReport = report;
}

export function lastMemberReport(): PulumiMemberReport | undefined {
  return lastReport;
}
