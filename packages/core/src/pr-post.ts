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
 *
 * On GitLab the post runs in a pipeline of the target branch (#4328): a
 * merge request pipeline is built from the merge request's own files, so a
 * job there that holds `CHANT_FORGE_TOKEN` runs whatever the change wrote.
 * `pr-post --open` ({@link postOpenPlanReports}) asks GitLab for each open
 * merge request's plan job and reads the report from its artifacts.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prNoteMarker, prStatusContext, prStatusDescription, prStatusState, renderPrNote, type PrOverdue, type PrReport } from "./pr-loop";
import { forgePrincipalOf, type PrForge } from "./pr-forge";
import { GITHUB_COMMENT_LIMIT, GITLAB_NOTE_LIMIT } from "./plan-summary";
import { activeProductWords, type CiProductWords } from "./ci-product-words";
import { controlEdgeFactsFromEnv, remarkCrossStackEdges, type ControlEdgeFacts } from "./control/edges";

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
  /**
   * The scheduled Ops that stopped running (#4289), asked here since the plan
   * job held no token to ask with. It replaces any `overdue` in the report.
   */
  overdue?: () => Promise<PrOverdue[]>;
  /**
   * The control repo's entries and apply records (#4617), which mark the
   * report's cross-stack edges stale, current or unknown. Default: read
   * from the checkout `CHANT_CONTROL_DIR` names, when it names one.
   */
  controlFacts?: () => Promise<ControlEdgeFacts | undefined>;
  /**
   * The description check (#4629, `../ci-respond-run.ts`), run once the
   * note is posted, on the report's change set. Its finding is a comment of
   * its own; it never changes the status.
   */
  description?: (report: PrReport) => Promise<void>;
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
    let report = read.report;
    if (input.overdue) {
      const { overdue: _forged, ...rest } = report;
      const found = await input.overdue().catch(() => [] as PrOverdue[]);
      report = (found.length > 0 ? { ...rest, overdue: found } : rest) as PrReport;
    }
    // #4617: the marks come from the control repo, read here; the plan job's never show.
    if (report.crossStackEdges?.length) {
      const facts = await (input.controlFacts ?? (() => controlEdgeFactsFromEnv()))().catch(() => undefined);
      report = remarkCrossStackEdges(report, facts);
    }
    try {
      state = prStatusState(report);
      description = prStatusDescription(report);
      // A member the change does not reach has nothing to say on the pull request (as pr-plan's own publish).
      if (!(input.member && report.status === "nothing" && !report.overdue?.length && !report.migrations?.length)) note = planNoteFor(report, input.forge, prNoteMarker(input.env, input.member));
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
      await upsertPlanNote(input.forge, input.pr, prNoteMarker(input.env, input.member), note);
    } catch (err) {
      warnings.push(`could not post the note on #${input.pr}: ${err instanceof Error ? err.message : String(err)}`);
      note = undefined;
    }
  }
  if (input.description && "report" in read && !failedJob) {
    try {
      await input.description(read.report);
    } catch (err) {
      warnings.push(`the description check did not run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { state, description: cut(description), noted: note !== undefined, ...(refused ? { refused } : {}), warnings };
}

/**
 * Post the plan note, or update it. Under a product's words that carry
 * `adoptMarkers` (#4550), a pull request with no chant note yet but a note the
 * product posted before it moved onto chant's pipeline gets that note
 * updated, with the old marker kept at its end, so the pull request keeps one
 * note across the switch.
 */
export async function upsertPlanNote(forge: Pick<PrForge, "upsertNote" | "findComment" | "upsertComment">, pr: number, marker: string, note: string, words: CiProductWords = activeProductWords()): Promise<void> {
  if (words.adoptMarkers.length > 0 && !(await forge.findComment(pr, marker))) {
    for (const old of words.adoptMarkers) {
      if (!(await forge.findComment(pr, old, { match: "anywhere" }))) continue;
      await forge.upsertComment(pr, old, `${note}${note.endsWith("\n") ? "" : "\n"}${old}\n`, { match: "anywhere" });
      return;
    }
  }
  await forge.upsertNote(pr, marker, note);
}

/** What {@link postOpenPlanReports} posts for. */
export interface OpenPlanPostInput {
  /** A GitLab client with {@link PrForge.mergeRequestJobs}, {@link PrForge.jobArtifact} and {@link PrForge.statusUrl}. */
  forge: PrForge;
  /** The branch the merge requests merge into: the pipeline's own. */
  branch: string;
  /** The plan job's name in the merge request pipeline: `plan`, or `<member>-plan`. */
  job: string;
  /** The report directory from the repository root, as the plan job kept it as its artifact. */
  artifactDir: string;
  env: string;
  member?: string;
  overdue?: () => Promise<PrOverdue[]>;
  /** The description check, as {@link PlanPostInput.description}. */
  description?: (report: PrReport) => Promise<void>;
}

/** What {@link postOpenPlanReports} did for one merge request. */
export interface OpenPlanPost {
  pr: number;
  head: string;
  /** What was posted, or why nothing was: the plan job has not settled, or its result is already posted. */
  posted?: PlanPostResult;
  skipped?: string;
}

/**
 * Post the plan note and status of every open merge request into `branch`
 * whose plan job settled (#4328), from a pipeline of `branch`. GitLab says
 * which merge requests are open, their heads, and their newest pipeline's
 * plan job; the report is the one file `pr-plan.json` of that job's
 * artifacts, read as data as {@link postPlanReport} reads any. The status
 * links to the plan job, and a status that already links to it is the
 * job's result posted, so a job is posted for once. The overdue check runs
 * once for every merge request.
 */
export async function postOpenPlanReports(input: OpenPlanPostInput): Promise<{ posts: OpenPlanPost[]; warnings: string[] }> {
  const { forge } = input;
  if (!forge.mergeRequestJobs || !forge.jobArtifact || !forge.statusUrl) {
    throw new Error(`pr-post --open reads the plan jobs of open merge requests, which ${forge.kind} cannot say; it is for GitLab`);
  }
  const context = prStatusContext("plan", input.member);
  const warnings: string[] = [];
  let overdue: Promise<PrOverdue[]> | undefined;
  const overdueOnce = input.overdue ? () => (overdue ??= input.overdue!()) : undefined;
  const posts: OpenPlanPost[] = [];
  for (const job of await forge.mergeRequestJobs(input.branch, input.job)) {
    const settled = job.status === "success" ? "success" : job.status === "failed" ? "failure" : job.status === "canceled" ? "cancelled" : undefined;
    if (!settled) {
      posts.push({ pr: job.pr, head: job.head, skipped: `the plan job is ${job.status}` });
      continue;
    }
    try {
      if (job.url && (await forge.statusUrl(job.head, context)) === job.url) {
        posts.push({ pr: job.pr, head: job.head, skipped: "this plan job's result is already posted" });
        continue;
      }
      const dir = mkdtempSync(join(tmpdir(), "chant-pr-post-"));
      try {
        const text = await forge.jobArtifact(job.id, `${input.artifactDir.replace(/\/+$/, "")}/${PR_PLAN_REPORT_FILE}`);
        if (text !== undefined) writeFileSync(join(dir, PR_PLAN_REPORT_FILE), text);
        const posted = await postPlanReport({
          // The status links to the plan job it reports on, which is how the next run knows it is posted.
          forge: job.url ? { ...forge, runUrl: job.url } : forge,
          dir,
          pr: job.pr,
          head: job.head,
          env: input.env,
          ...(input.member ? { member: input.member } : {}),
          result: settled,
          ...(overdueOnce ? { overdue: overdueOnce } : {}),
          ...(input.description ? { description: input.description } : {}),
        });
        posts.push({ pr: job.pr, head: job.head, posted });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      warnings.push(`!${job.pr}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { posts, warnings };
}
