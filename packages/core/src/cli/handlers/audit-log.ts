/**
 * `chant audit-log attribute` and `chant audit-log unrecorded` (#4632): the
 * CI core reads of `../../ci-audit`. `attribute` reads a drift document
 * (`chant workspace drift -o <file>`) and names who changed each drifted
 * attribute; `unrecorded` reads the audit log's writes over a window and
 * reports those no recorded apply on the run ledger made. Both read the
 * log with the credentials the job holds and write nothing.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatError } from "../format";
import type { CommandContext } from "../registry";

const fail = (message: string, hint?: string): number => {
  console.error(formatError({ message, ...(hint ? { hint } : {}) }));
  return 1;
};

export async function runAuditLogAttribute(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (!args.input) return fail("audit-log attribute reads a drift document: --input <file>", "Write one with chant workspace drift -o <file>.");
  const audit = await import("../../ci-audit");
  const { parseDriftDocument } = await import("../../drift-record");
  let doc;
  try {
    doc = parseDriftDocument(JSON.parse(readFileSync(resolve(args.input), "utf-8")));
  } catch (err) {
    return fail(`--input ${args.input} is not a drift document: ${err instanceof Error ? err.message : String(err)}`);
  }
  let auditLogs: import("../../ci-audit").AuditLogSettings | undefined;
  if (args.auditLog) {
    const setting = audit.parseAuditLogSetting(args.auditLog);
    if ("error" in setting) return fail(setting.error);
    auditLogs = { "*": setting };
  }
  const attributed = await audit.attributeDrift(doc, { ...(auditLogs ? { auditLogs } : {}) });
  if (args.json) {
    console.log(JSON.stringify(attributed, null, 2));
    return 0;
  }
  for (const n of attributed.notes) console.error(n);
  const routed = audit.routeAttributions(attributed.attributions);
  console.log(routed.lines.length > 0 ? routed.lines.join("\n") : "no drifted attribute to attribute");
  return 0;
}

export async function runAuditLogUnrecorded(ctx: CommandContext): Promise<number> {
  const { args } = ctx;
  if (!args.auditLog) return fail("audit-log unrecorded reads a cloud's audit log: --audit-log aws[:<region>]");
  if (!args.op) return fail("audit-log unrecorded compares against the applies of the ops named: --op <op>[,<op>...]");
  if (!args.since || !Number.isFinite(Date.parse(args.since))) return fail("audit-log unrecorded reads the writes since a time: --since <ISO-8601>");
  const audit = await import("../../ci-audit");
  const setting = audit.parseAuditLogSetting(args.auditLog);
  if ("error" in setting) return fail(setting.error);
  const { readRunLedger } = await import("../../lifecycle/run-ledger");
  const { requireLifecycleLedger } = await import("../../lifecycle/git");
  const env = args.env ?? "local";
  const windows: import("../../ci-audit").ApplyWindow[] = [];
  try {
    await requireLifecycleLedger({ cwd: process.cwd() });
    for (const op of args.op.split(",").map((o) => o.trim()).filter(Boolean)) {
      windows.push(...audit.applyWindowsFromRuns((await readRunLedger(env, op)).records));
    }
  } catch (err) {
    return fail(`could not read the run ledger: ${err instanceof Error ? err.message : String(err)}`);
  }
  const until = new Date().toISOString();
  const report = await audit.unrecordedWrites(audit.auditLogOf(setting), windows, { since: new Date(args.since).toISOString(), until });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(audit.renderUnrecorded(report));
  if (report.unavailable) return 1;
  return report.unrecorded.length > 0 ? 2 : 0;
}
