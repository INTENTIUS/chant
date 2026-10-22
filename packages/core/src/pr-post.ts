/**
 * Post a pull request's plan note and its `chant/plan` status from the plan
 * report (#4295), in a job or a process that runs none of the change's code.
 *
 * The plan job runs the pull request's code and holds no forge token
 * (./ci-handover.ts), so `pr-plan --no-status` only writes its report. Then
 * `chant components pr-post` in the `plan-note` job, or `chant ci run plan`
 * once its steps settle, reads the report and posts.
 *
 * The report is the change's: its code could write anything into it. So it
 * is read as data. The pull request, the head, the environment and the
 * member come from the caller, never the report, and a report that names
 * others is refused. The note is rendered again here from the report, and
 * every hidden HTML comment after its first line is defused, so a forged
 * marker cannot claim another environment's note. A plan job that failed
 * fails the status whatever its report says.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prNoteMarker, prStatusContext, prStatusDescription, prStatusState, renderPrNote, type PrReport } from "./pr-loop";
import { forgePrincipalOf, type PrForge } from "./pr-forge";
import { GITHUB_COMMENT_LIMIT, GITLAB_NOTE_LIMIT } from "./plan-summary";

/** The plan report's file under the report directory. */
export const PR_PLAN_REPORT_FILE = "pr-plan.json";

/** What {@link postPlanReport} posts for. */
export interface PlanPostInput {
  forge: PrForge;
  /** The report directory the plan job wrote, `.chant/pr`. */
  dir: string;
  /** The pull request, from the forge's event. */
  pr: number;
  /** The commit the plan job checked out, from the forge's event. */
  head: string;
  env: string;
  member?: string;
  /** The plan job's own result (`needs.plan.result`). `failure` fails the status. */
  result?: string;
}

/** What {@link postPlanReport} did. */
export interface PlanPostResult {
  state: "success" | "failure" | "pending";
  description: string;
  /** Whether a note was posted. A refused or missing report posts none. */
  noted: boolean;
  /** Why the report was not used, when it was not. */
  refused?: string;
  warnings: string[];
}

const SHA = /^[0-9a-f]{40}$/;

/**
 * Read the plan report under `dir` and check it is the one the caller ran:
 * a plan report for the same pull request, head, environment and member.
 * Returns the report, or why it is not used.
 */
export function readPlanReport(input: Pick<PlanPostInput, "dir" | "pr" | "head" | "env" | "member">): { report: PrReport } | { refused: string } {
  const file = join(input.dir, PR_PLAN_REPORT_FILE);
  if (!existsSync(file)) return { refused: "the plan job wrote no report" };
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    return { refused: `the plan report does not read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { refused: "the plan report is not an object" };
  const r = doc as Record<string, unknown>;
  if (r.stage !== "plan") return { refused: `the report is not a plan report (stage ${JSON.stringify(r.stage)})` };
  if (r.pr !== input.pr) return { refused: `the report is for pull request ${JSON.stringify(r.pr)}, not ${input.pr}` };
  if (typeof r.head !== "string" || !SHA.test(r.head) || r.head !== input.head) return { refused: `the report is for head ${JSON.stringify(r.head)}, not ${input.head}` };
  if (r.env !== input.env) return { refused: `the report is for environment ${JSON.stringify(r.env)}, not ${input.env}` };
  if ((r.member ?? undefined) !== input.member) return { refused: `the report is for member ${JSON.stringify(r.member ?? null)}, not ${JSON.stringify(input.member ?? null)}` };
  if (!Array.isArray(r.members) || !r.changeSet || typeof r.changeSet !== "object" || !r.selection || typeof r.selection !== "object" || !r.approval || typeof r.approval !== "object") {
    return { refused: "the plan report is missing its members, change set, selection or approval" };
  }
  return { report: doc as PrReport };
}

/**
 * The note for `report`, rendered here, with every `<!--` after the marker
 * line written as `&lt;!--`, so the note carries no hidden marker but its own.
 */
export function planNoteFor(report: PrReport, forge: Pick<PrForge, "kind" | "host">, marker: string): string {
  const note = renderPrNote(report, {
    limit: forge.kind === "gitlab" ? GITLAB_NOTE_LIMIT : GITHUB_COMMENT_LIMIT,
    approver: forgePrincipalOf(forge.kind, forge.host, "<your-login>"),
  });
  const at = note.indexOf("\n");
  const rest = (at < 0 ? "" : note.slice(at + 1)).split("<!--").join("&lt;!--");
  return `${marker}\n${rest}`;
}

const cut = (text: string, max = 140): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/**
 * Post the status and the note for the plan report under `input.dir`. A
 * forge that refuses a call is a warning. A report that is missing or not
 * the caller's sets a failed status and posts no note.
 */
export async function postPlanReport(input: PlanPostInput): Promise<PlanPostResult> {
  const warnings: string[] = [];
  const context = prStatusContext("plan", input.member);
  const read = readPlanReport(input);
  const failedJob = input.result === "failure" || input.result === "cancelled";
  let state: PlanPostResult["state"];
  let description: string;
  let note: string | undefined;
  let refused: string | undefined;
  if ("refused" in read) {
    refused = read.refused;
    state = "failure";
    description = cut(read.refused);
  } else {
    const report = read.report;
    try {
      state = prStatusState(report);
      description = prStatusDescription(report);
      // A member the change does not reach has nothing to say on the pull request (as pr-plan's own publish).
      if (!(input.member && report.status === "nothing")) note = planNoteFor(report, input.forge, prNoteMarker(input.env, input.member));
    } catch (err) {
      refused = `the plan report does not render: ${err instanceof Error ? err.message : String(err)}`;
      state = "failure";
      description = cut(refused);
      note = undefined;
    }
    if (failedJob && state !== "failure") {
      state = "failure";
      description = cut(`the plan job failed; ${description}`);
    }
  }
  try {
    await input.forge.setStatus(input.head, { context, state, description: cut(description), ...(input.forge.runUrl ? { url: input.forge.runUrl } : {}) });
  } catch (err) {
    warnings.push(`could not set the ${context} status: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (note !== undefined) {
    try {
      await input.forge.upsertNote(input.pr, prNoteMarker(input.env, input.member), note);
    } catch (err) {
      warnings.push(`could not post the note on #${input.pr}: ${err instanceof Error ? err.message : String(err)}`);
      note = undefined;
    }
  }
  return { state, description: cut(description), noted: note !== undefined, ...(refused ? { refused } : {}), warnings };
}
