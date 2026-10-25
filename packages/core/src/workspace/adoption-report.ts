/**
 * The adoption report `chant workspace promote <member> --state` shows on the
 * `terraform` to `choudoufu` rung (INTENTIUS/behold#999): choudoufu's
 * `live-import` ratification report, read off the text it prints.
 *
 * `choudoufu live-import -state=<file> -estate=<name>` without `-approve` is
 * read-only and has no JSON view (choudoufu internal/command/views/
 * live_import.go: "There is no JSON implementation, matching live-mv"). Its
 * human view prints one group per status, each resource on two lines:
 *
 *   VERIFIED (2) - verified against the live system:
 *     aws_s3_bucket.logs                         aws_s3_bucket            live id: logs-123
 *       <detail>
 *
 * This module turns that text into one entry per resource, so `promote
 * --json` can carry it and a reader (behold) never parses choudoufu's output
 * itself. VERIFIED and DRIFTED are stamped by `live-import -approve`; MISSING,
 * UNTAGGABLE and UNADMITTED_TYPE never are.
 */

/** The statuses choudoufu's ratification gives, in the order it prints them. */
export const ADOPTION_STATUSES = ["VERIFIED", "DRIFTED", "MISSING", "UNTAGGABLE", "UNADMITTED_TYPE"] as const;
export type AdoptionStatus = (typeof ADOPTION_STATUSES)[number];

/** The statuses `live-import -approve` stamps. */
export const CLAIMED_STATUSES: readonly AdoptionStatus[] = ["VERIFIED", "DRIFTED"];

export interface AdoptionEntry {
  /** The resource instance address, with its module path. */
  address: string;
  type: string;
  status: AdoptionStatus;
  /** The live id the state recorded, or null when choudoufu printed `-`. */
  liveId: string | null;
  /** choudoufu's reason for the status, verbatim. */
  detail: string;
  /** True when `live-import -approve` stamps it (VERIFIED or DRIFTED). */
  claimed: boolean;
}

export interface AdoptionReport {
  /** The estate name the report was made for (`-estate`). */
  estate: string | null;
  /** The state file it read (`-state`). */
  state: string | null;
  entries: AdoptionEntry[];
  /** How many entries `-approve` stamps. */
  claimed: number;
  total: number;
}

const HEADER = /^Ratifying (.+) for estate "(.*)" against the live system\./;
const GROUP = /^([A-Z_]+) \((\d+)\) - .*:$/;
const ROW = /^ {2}(\S.*?)\s+(\S+)\s+live id: (.*)$/;
const DETAIL = /^ {4}(.*)$/;

const isStatus = (s: string): s is AdoptionStatus => (ADOPTION_STATUSES as readonly string[]).includes(s);

/**
 * Read choudoufu's ratification report out of `text` (the step's combined
 * output, so diagnostics may sit around it). Undefined when the text holds no
 * report: no `Ratifying` line and no status group.
 */
export function parseLiveImportReport(text: string): AdoptionReport | undefined {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/);
  let estate: string | null = null;
  let state: string | null = null;
  let status: AdoptionStatus | undefined;
  let seen = false;
  const entries: AdoptionEntry[] = [];
  for (const line of lines) {
    const h = HEADER.exec(line);
    if (h) {
      state = h[1];
      estate = h[2];
      seen = true;
      continue;
    }
    const g = GROUP.exec(line);
    if (g) {
      status = isStatus(g[1]) ? g[1] : undefined;
      seen = true;
      continue;
    }
    if (line.trim() === "") continue;
    if (!status) continue;
    const r = ROW.exec(line);
    if (r && !line.startsWith("    ")) {
      entries.push({ address: r[1], type: r[2], status, liveId: r[3].trim() === "-" ? null : r[3].trim(), detail: "", claimed: CLAIMED_STATUSES.includes(status) });
      continue;
    }
    const d = DETAIL.exec(line);
    if (d && entries.length > 0) {
      const last = entries[entries.length - 1];
      last.detail = last.detail ? `${last.detail} ${d[1].trim()}` : d[1].trim();
      continue;
    }
    // A line at the margin ends the group: the summary lines that follow the last one.
    status = undefined;
  }
  if (!seen) return undefined;
  return { estate, state, entries, claimed: entries.filter((e) => e.claimed).length, total: entries.length };
}
