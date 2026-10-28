/**
 * chant's pull request reports as the harness reads them (chant#4587). A
 * scenario's outcomes come from these and from the run ledger, never from a
 * runner's status or its logs. The jobs write them under `--report-url`, at
 * `<pr>/<commit>/pr-plan.json` and `pr-apply.json` (reportKey).
 */
import { reportKey } from "../pr-report-url";
import type { Bucket, Clock } from "./ports";

export type ReportStage = "plan" | "apply";

/** pr-report/v1, the fields the harness reads. */
export interface PrReportView {
  stage: ReportStage;
  pr: number | null;
  head: string;
  op: string;
  gate: string;
  digest: string;
  status: string;
  refusal?: string;
  message?: string;
  approval?: { status?: string };
  selection: { waves: string[][] };
  members: Array<{ member: string; component: string; status: string; error?: string }>;
}

/** The report file of a stage. */
export const reportFile = (stage: ReportStage): string => `pr-${stage}.json`;

/**
 * The bucket key of a report: `prefix` is the report URL's path below the
 * bucket (`s3://<bucket>/<prefix>`), as the bucket names keys.
 */
export function reportObjectKey(prefix: string, pr: number | null, commit: string, stage: ReportStage): string {
  return `${prefix.replace(/\/+$/, "")}/${reportKey(pr, commit)}/${reportFile(stage)}`;
}

/** The path of an s3:// report URL below its bucket, and the bucket. */
export function splitReportUrl(url: string): { bucket: string; prefix: string } {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url);
  if (!m) throw new Error(`${url} is not an s3:// report URL`);
  return { bucket: m[1]!, prefix: m[2]!.replace(/\/+$/, "") };
}

/** A report, or null while there is none. */
export async function readReport(bucket: Bucket, key: string): Promise<PrReportView | null> {
  const text = await bucket.get(key);
  return text === null ? null : (JSON.parse(text) as PrReportView);
}

/** Wait for a report until `deadline` (clock ms). Resolves with it, or null past the deadline. */
export async function waitForReport(bucket: Bucket, key: string, clock: Clock, deadline: number, pollMs = 2000): Promise<PrReportView | null> {
  for (;;) {
    const r = await readReport(bucket, key);
    if (r) return r;
    if (clock.now() >= deadline) return null;
    await clock.sleep(pollMs);
  }
}

/** Each component's status in a report: failed if a member failed, else the members' one status, else them joined with +. */
export function componentStatuses(report: Pick<PrReportView, "members">): Map<string, string> {
  const byComponent = new Map<string, string[]>();
  for (const m of report.members) {
    const name = m.component || m.member;
    byComponent.set(name, [...(byComponent.get(name) ?? []), m.status]);
  }
  const out = new Map<string, string>();
  for (const [name, statuses] of byComponent) {
    const one = statuses.includes("failed")
      ? "failed"
      : statuses.every((s) => s === statuses[0])
        ? statuses[0]!
        : statuses.join("+");
    out.set(name, one);
  }
  return out;
}
