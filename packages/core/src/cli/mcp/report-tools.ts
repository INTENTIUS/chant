/**
 * chant#4555: the report store read of `chant serve mcp`, the `report` tool,
 * and the reader the product tool hook hands a product's tools.
 *
 * The store is the one `pr-plan --report-url` and `pr-apply --report-url`
 * write (../../pr-report-url.ts): the product hook's `reportUrl`, else the
 * workspace declaration's `ci.reportUrl`. `gs://` and `az://` go through
 * chant core's object-store clients (#4554), `s3://` through the AWS CLI,
 * and `file://` through the file system, each with the credentials the
 * server's environment gives. A tool never takes a credential or a URL as
 * an argument, and nothing here writes.
 */

import type { ToolDefinition, ToolHandler } from "./types";
import { parseReportUrl, reportGet, reportKey, type AwsRead, type ReportGet, type ReportStore, type ReportTarget } from "../../pr-report-url";

/** The files a pull request stage keeps under its key. */
export const REPORT_FILES = [
  "pr-plan.json",
  "pr-apply.json",
  "change-set.json",
  "pr-plan.events.jsonl",
  "pr-apply.events.jsonl",
  "pr-record.events.jsonl",
] as const;

/** A key below the report URL: path segments of the characters run paths use, no `.` or `..`, no empty segment. */
const SAFE_KEY = /^[A-Za-z0-9._~@+-]+(\/[A-Za-z0-9._~@+-]+)*$/;

/** Thrown for a key that is not a path below the report URL. */
export class ReportKeyError extends Error {}

/** `key` checked as a path below the report URL. */
export function safeReportKey(key: string): string {
  const k = key.replace(/^\/+|\/+$/g, "");
  if (!SAFE_KEY.test(k) || k.split("/").some((s) => s === "." || s === "..")) throw new ReportKeyError(`${JSON.stringify(key)} is not a path below the report URL`);
  return k;
}

/** A read-only reader of the report store. */
export interface ReportReader {
  /** The store's URL, for messages. */
  readonly url: string;
  /** One object's text below the URL, or null when there is none. */
  read(key: string): Promise<string | null>;
}

/** A reader over `url`. `aws` and `store` replace the AWS CLI and the cloud client in a test. */
export function reportReader(url: string, opts: { aws?: AwsRead; store?: ReportStore } = {}): ReportReader {
  const target = parseReportUrl(url, "the report URL");
  if ("error" in target) throw new Error(target.error);
  const get: ReportGet = reportGet(target as ReportTarget, opts.aws, opts.store);
  return { url: (target as ReportTarget).url, read: (key) => get(safeReportKey(key)) };
}

/** The report store's URL: `given`, else the declared `ci.reportUrl` of the workspace holding `cwd`. */
export async function reportUrlFor(given: string | undefined, cwd: string): Promise<string | undefined> {
  if (given) return given;
  const { declaredReportUrl } = await import("../../workspace/ci-report-url");
  return declaredReportUrl(cwd);
}

export const reportReadTools: ToolDefinition[] = [
  {
    name: "report",
    description:
      "One file a pull request stage kept in the report store (--report-url, or the workspace's ci.reportUrl): " +
      REPORT_FILES.join(", ") +
      ", under <pr>/<commit>[/<member>]. Reads with the server's own credentials and writes nothing. JSON comes back parsed; an events file comes back as its events.",
    inputSchema: {
      type: "object",
      properties: {
        pr: { type: "string", description: "The pull or merge request number, or unknown for a pr-apply that found none." },
        commit: { type: "string", description: "The full commit sha the stage ran on." },
        member: { type: "string", description: "The workspace member, for a member's loop (--member)." },
        file: { type: "string", enum: [...REPORT_FILES], description: "The file to read." },
      },
      required: ["pr", "commit", "file"],
    },
  },
];

class ReportInputError extends Error {}

/** The key the `report` tool reads, from its input. */
export function reportToolKey(params: Record<string, unknown>): string {
  const pr = params.pr;
  const prText = typeof pr === "number" && Number.isInteger(pr) && pr > 0 ? String(pr) : typeof pr === "string" && /^(?:[1-9]\d*|unknown)$/.test(pr) ? pr : undefined;
  if (prText === undefined) throw new ReportInputError("pr must be a pull request number or unknown");
  const commit = params.commit;
  if (typeof commit !== "string" || !/^[0-9a-f]{7,64}$/.test(commit)) throw new ReportInputError("commit must be a commit sha");
  const member = params.member;
  if (member !== undefined && (typeof member !== "string" || !/^[A-Za-z0-9._@+-]+$/.test(member) || member === "." || member === "..")) {
    throw new ReportInputError("member must be a workspace member's name");
  }
  const file = params.file;
  if (typeof file !== "string" || !(REPORT_FILES as readonly string[]).includes(file)) throw new ReportInputError(`file must be one of ${REPORT_FILES.join(", ")}`);
  const known = new Set(["pr", "commit", "member", "file"]);
  for (const k of Object.keys(params)) if (!known.has(k)) throw new ReportInputError(`report takes no argument ${k}`);
  return `${reportKey(prText === "unknown" ? null : Number(prText), commit, member as string | undefined)}/${file}`;
}

/** The `report` tool over the store `reader` opens, made on first call. */
export function createReportTools(options: { cwd: string; reportUrl?: string; reader?: () => Promise<ReportReader | undefined> }): { definition: ToolDefinition; handler: ToolHandler }[] {
  let opened: Promise<ReportReader | undefined> | undefined;
  const open = options.reader ?? (async () => {
    const url = await reportUrlFor(options.reportUrl, options.cwd);
    return url ? reportReader(url) : undefined;
  });
  return reportReadTools.map((definition) => ({
    definition,
    handler: async (params) => {
      const key = reportToolKey(params);
      const reader = await (opened ??= open());
      if (!reader) throw new Error("no report store: pass --report-url to pr-plan and pr-apply, or declare ci.reportUrl in the workspace, and the server reads it from there");
      const text = await reader.read(key);
      if (text === null) throw new Error(`there is no ${key} at ${reader.url}`);
      if (key.endsWith(".jsonl")) {
        const events = text.split("\n").filter((l) => l.trim() !== "").map((l) => {
          try {
            return JSON.parse(l) as unknown;
          } catch {
            return l;
          }
        });
        return { url: reader.url, key, events };
      }
      try {
        return { url: reader.url, key, document: JSON.parse(text) as unknown };
      } catch {
        return { url: reader.url, key, text };
      }
    },
  }));
}
