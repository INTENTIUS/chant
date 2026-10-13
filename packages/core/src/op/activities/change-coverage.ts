/**
 * changeCoverage — the forward coverage check (#2773) as an Op activity, for
 * an Op that changes the checkout (#2748) to run on its own diff.
 *
 * Such an Op's leased steps work in a worktree of their own on
 * `chant/work/[<member>/]<item>`. Given that worktree as `cwd`
 * (`workLeaseOutput("worktree")`) and no `range`, the activity checks the
 * commits the branch holds beyond the main worktree's HEAD, with the branch's
 * item as the work item in hand, exactly as `chant workspace check --changes
 * <base>..HEAD --work <item>` would. A `range` or `work` given replaces what
 * the branch says.
 *
 * The step fails when the check's severity is `fail` and it has a finding,
 * or when the check can't run; otherwise it returns the document's findings
 * and summary for later steps. The workspace code loads on first call, so
 * importing core's activities loads nothing under `workspace/` (#2525 rule 5).
 */

import type { ChangeFinding, ChangesDocument } from "../../workspace/changes";

export interface ChangeCoverageArgs {
  /** The checkout to check: the Op's worktree. Default: the working directory. */
  cwd?: string;
  /** `<base>..<head>`, `<base>...<head>` or `<base>`. Default: the work branch's own commits. */
  range?: string;
  /** The work item in hand. Default: the work branch's item. */
  work?: string;
  /** In place of the declaration's `changes.severity`. */
  severity?: "off" | "warn" | "fail";
}

export interface ChangeCoverageResult {
  ok: boolean;
  range: { spec: string; base: string; head: string };
  work: string | null;
  severity: "off" | "warn" | "fail";
  findings: Pick<ChangeFinding, "code" | "path" | "message" | "severity" | "records" | "triage">[];
  summary: Exclude<ChangesDocument, { error: unknown }>["summary"];
}

export async function changeCoverage(args: ChangeCoverageArgs = {}): Promise<ChangeCoverageResult> {
  const { checkChanges, workBranchChanges } = await import("../../workspace/changes");
  const cwd = args.cwd ?? process.cwd();
  const branch = args.range === undefined ? workBranchChanges(cwd) : undefined;
  const range = args.range ?? branch?.range;
  if (range === undefined) throw new Error(`changeCoverage: ${cwd} is not on a chant/work/ branch, so give the range to check`);
  const work = args.work ?? branch?.work;
  const { doc } = await checkChanges({ cwd, range, ...(work !== undefined ? { work } : {}), ...(args.severity ? { severity: args.severity } : {}) });
  if ("error" in doc) throw new Error(`changeCoverage: ${doc.error.code}: ${doc.error.message}`);
  const result: ChangeCoverageResult = {
    ok: doc.ok,
    range: doc.range,
    work: doc.work?.record ?? null,
    severity: doc.severity,
    findings: doc.findings.map(({ code, path, message, severity, records, triage }) => ({ code, path, message, severity, records, triage })),
    summary: doc.summary,
  };
  if (!doc.ok) throw new Error(`changeCoverage: ${doc.findings.length} change ${doc.findings.length === 1 ? "finding" : "findings"} at severity fail: ${doc.findings.map((f) => `${f.code} ${f.path}`).join(", ")}`);
  return result;
}
