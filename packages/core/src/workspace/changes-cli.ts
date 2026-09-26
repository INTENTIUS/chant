/**
 * `chant workspace check --changes <base>..<head> [--work <id>] [--severity
 * off|warn|fail] [--kind <kind file>...] [--json]` (#2773): the forward
 * coverage check (`changes.ts`), printed as JSON with `--json` or as one line
 * per changed path, then the findings.
 */

import { resolve } from "node:path";
import { formatError } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { CHANGE_SEVERITIES, checkChanges, type ChangesDocument } from "./changes";
import type { ChangeSeverity } from "./declaration";

const USAGE = "chant workspace check --changes <base>..<head> [--work <id>] [--severity off|warn|fail] [--kind <kind file>...] [--json]";

type Result = Exclude<ChangesDocument, { error: unknown }>;

/** One line per changed path, then the findings and a summary. */
export function formatChanges(doc: Result): string {
  const out: string[] = [];
  const work = doc.work ? `, work item ${doc.work.record} in hand` : "";
  out.push(`changes   ${doc.range.base.slice(0, 8)}..${doc.range.head.slice(0, 8)} (${doc.range.spec}), severity ${doc.severity}${work}`);
  for (const p of doc.paths) {
    const why =
      p.status === "covered"
        ? `by ${p.coveredBy.map((c) => `${c.record} (${c.entry})`).join(", ")}`
        : p.status === "out-of-scope"
          ? `by ${p.outOfScopeBy.map((c) => `${c.record} (${c.entry})`).join(", ")}`
          : p.status === "ignored"
            ? `by ${p.ignoredBy}`
            : "";
    out.push(`${p.status.padEnd(12)} ${p.change.padEnd(8)} ${p.path}${p.from ? ` (from ${p.from})` : ""}${why ? `; ${why}` : ""}`);
  }
  for (const f of doc.findings) out.push(`${f.severity === "fail" ? "error  " : "warning"}   ${f.code}: ${f.message}`);
  const s = doc.summary;
  out.push(`${s.paths} changed paths: ${s.covered} covered, ${s.uncovered} uncovered, ${s.outOfScope} out of scope, ${s.ignored} ignored, ${s.records} records; ${doc.findings.length} findings`);
  return out.join("\n");
}

export async function runWorkspaceChanges(ctx: CommandContext, cwd: string): Promise<number> {
  const { args } = ctx;
  const severity = args.severity as ChangeSeverity | undefined;
  if (severity !== undefined && !(CHANGE_SEVERITIES as readonly string[]).includes(severity)) {
    console.error(formatError({ message: `--severity ${severity} is not off, warn or fail`, hint: USAGE }));
    return 1;
  }
  const kinds = args.kinds ?? (args.kind !== undefined ? [args.kind] : undefined);
  const { doc, failed } = await checkChanges({ cwd, range: args.changes!, kinds: kinds?.map((k) => resolve(k)), work: args.work, severity });
  if (args.json || args.format === "json") console.log(JSON.stringify(doc, null, 2));
  if ("error" in doc) {
    console.error(formatError({ message: `${doc.error.code}: ${doc.error.message}`, hint: USAGE }));
    return 1;
  }
  if (!args.json && args.format !== "json") console.log(formatChanges(doc));
  return failed ? 1 : 0;
}
