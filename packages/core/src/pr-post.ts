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
 *
 * #4628: the note carries the target branch's commit it was posted against
 * (`baseTip`) in a hidden line, and on GitHub and Forgejo the note job adds
 * the note to the job summary (`GITHUB_STEP_SUMMARY`). When the target
 * branch moves, {@link markStaleNotes}, from a job of the push, marks each
 * open pull request's note stale with a line naming the comment that
 * previews again, and sets its plan status back to pending.
 */

import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prNoteMarker, prStatusContext, prStatusDescription, prStatusState, renderPrNote, type PrOverdue, type PrReport } from "./pr-loop";
import { forgePrincipalOf, type PrForge } from "./pr-forge";
import { GITHUB_COMMENT_LIMIT, GITLAB_NOTE_LIMIT } from "./plan-summary";
import { activeProductWords, commentLine, type CiProductWords } from "./ci-product-words";
import { controlEdgeFactsFromEnv, remarkCrossStackEdges, type ControlEdgeFacts } from "./control/edges";
import { checkEvidenceNoteLine } from "./workspace/trust/check-evidence-report";
import { PLAN_RUN_RECORD_FILE, readPlanRunRecord } from "./pr-plan-record";
import type { OpRunRecordInput } from "./op/runtime";
import type { RunOrigin } from "./lifecycle/release-ledger";
import { isPlanNote, planNoteMarker, PR_PLAN_NOTE_CONTRACT, PR_PLAN_NOTE_FILE, PRODUCT_MARKER_BODY, PRODUCT_MARKER_LIMIT, PRODUCT_MARKER_NAME, productMarkerLine, renderPlanNote, type PrPlanNoteHandoff, type PrPlanNoteWords } from "./pr-plan-note";

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
  /**
   * The target branch's commit the pull request's event names (#4628): the
   * note carries it in a hidden line, and {@link markStaleNotes} marks the
   * note stale once the branch has moved past it. Ignored unless a full sha.
   */
  baseTip?: string;
  /**
   * The job summary file (#4628), `GITHUB_STEP_SUMMARY` on GitHub and
   * Forgejo: the note, without its hidden lines, is added to it.
   */
  summaryFile?: string;
  /**
   * The words a product's plan note hand-off renders with (#4799). Default:
   * the JSON in `CHANT_PLAN_NOTE_WORDS`, which the generated note job sets
   * from the pipeline, never from the report.
   */
  noteWords?: PrPlanNoteWords;
  /**
   * Notices the note job's own lines wrote (#4931), each added under a
   * product's plan note hand-off's counts, after its own. Default: the
   * lines of the file `CHANT_PLAN_NOTE_NOTICES` names, which the generated
   * note job sets to a file outside the report the plan job handed on.
   */
  notices?: string[];
  /**
   * Keep the plan job's run record (#4899, ./pr-plan-record.ts), when it
   * wrote one into the hand-off: read as data, with `origin` naming the plan
   * job's run, and handed to `keep`, which appends it to the run ledger and
   * pushes. `keep` returns a warning to say, when there is one.
   */
  recordRun?: PlanRunRecorder;
}

/** How the note job keeps the plan job's run record (#4899). */
export interface PlanRunRecorder {
  /** The plan job's run, as the note job names it. */
  origin?: RunOrigin;
  keep(record: OpRunRecordInput): Promise<string | undefined>;
}

/** What {@link postPlanReport} did. */
export interface PlanPostResult {
  state: "success" | "failure" | "pending";
  description: string;
  /** Whether a note was posted. A refused or missing report posts none. */
  noted: boolean;
  /** Why the report was not used, when it was not. */
  refused?: string;
  /** The id of the plan job's run record kept on chant/lifecycle (#4899), when one was. */
  recorded?: string;
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
export function planNoteFor(report: PrReport, forge: Pick<PrForge, "kind" | "host">, marker: string, baseTip?: string): string {
  const note = renderPrNote(report, {
    limit: forge.kind === "gitlab" ? GITLAB_NOTE_LIMIT : GITHUB_COMMENT_LIMIT,
    approver: forgePrincipalOf(forge.kind, forge.host, "<your-login>"),
  });
  const at = note.indexOf("\n");
  const rest = (at < 0 ? "" : note.slice(at + 1)).split("<!--").join("&lt;!--");
  // #4628: the tip line is written after the defusing, from the caller's sha, never the report's.
  const tip = baseTip && SHA.test(baseTip) ? `${rest.endsWith("\n") ? "" : "\n"}${prNoteTipMarker(baseTip)}\n` : "";
  return `${marker}\n${rest}${tip}`;
}

/** The hidden line a note carries with the target branch's commit it was posted against (#4628). */
export function prNoteTipMarker(sha: string): string {
  return `<!-- chant-pr-tip:${sha} -->`;
}

/** The hidden line a note marked stale carries, with the commit it was marked at (#4628). */
export function prNoteStaleMarker(sha: string): string {
  return `<!-- chant-pr-stale:${sha} -->`;
}

const TIP_LINE = /<!-- chant-pr-tip:([0-9a-f]{40}) -->/;
const STALE_LINE = /<!-- chant-pr-stale:([0-9a-f]{40}) -->/;
const STALE_PREFIX = "> Stale: ";

/** The note as the job summary shows it (#4628): the hidden lines dropped. */
export function planNoteSummary(note: string): string {
  return note
    .split("\n")
    .filter((l) => !/^<!-- chant-pr[-:]/.test(l.trim()))
    .join("\n")
    .replace(/^\n+/, "");
}

const cut = (text: string, max = 140): string => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/**
 * Post the status and the note for the plan report under `input.dir`. A
 * forge that refuses a call is a warning. A report that is missing or not
 * the caller's sets a failed status and posts no note.
 */
export async function postPlanReport(input: PlanPostInput): Promise<PlanPostResult> {
  // #4799: a product's plan verb wrote its plan note hand-off in place of pr-plan's report.
  if (!existsSync(join(input.dir, PR_PLAN_REPORT_FILE)) && existsSync(join(input.dir, PR_PLAN_NOTE_FILE))) return postPlanNoteHandoff(input);
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
      if (!(input.member && report.status === "nothing" && !report.overdue?.length && !report.migrations?.length)) note = planNoteFor(report, input.forge, prNoteMarker(input.env, input.member), input.baseTip);
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
  note = await postOutcome(input, context, state, description, note, refused, warnings);
  if (input.description && "report" in read && !failedJob) {
    try {
      await input.description(read.report);
    } catch (err) {
      warnings.push(`the description check did not run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const recorded = await keepRunRecord(input, warnings);
  return { state, description: cut(description), noted: note !== undefined, ...(refused ? { refused } : {}), ...(recorded ? { recorded } : {}), warnings };
}

/**
 * Keep the plan job's run record on chant/lifecycle (#4899), with
 * `input.recordRun`. A record that is missing, refused or not kept is a
 * warning: the note and the status stand. Returns the record's id once kept.
 */
async function keepRunRecord(input: PlanPostInput, warnings: string[]): Promise<string | undefined> {
  if (!input.recordRun) return undefined;
  const read = readPlanRunRecord(input.dir, {
    env: input.env,
    head: input.head,
    ...(input.member ? { target: input.member } : {}),
    ...(input.result ? { result: input.result } : {}),
    ...(input.recordRun.origin ? { origin: input.recordRun.origin } : {}),
  });
  if (!read) {
    warnings.push("the plan job wrote no run record, so none is kept");
    return undefined;
  }
  if ("refused" in read) {
    warnings.push(`the plan job's run record was not kept: ${read.refused}`);
    return undefined;
  }
  try {
    const said = await input.recordRun.keep(read.record);
    if (said) warnings.push(said);
    return read.record.id;
  } catch (err) {
    warnings.push(`the plan job's run record was not kept on chant/lifecycle: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Set the plan status, post the note when there is one, and add it to the
 * job summary (#4295, #4628). Returns the note, or undefined when posting
 * it failed.
 */
async function postOutcome(
  input: PlanPostInput,
  context: string,
  state: PlanPostResult["state"],
  description: string,
  note: string | undefined,
  refused: string | undefined,
  warnings: string[],
): Promise<string | undefined> {
  try {
    await input.forge.setStatus(input.head, { context, state, description: cut(description), ...(input.forge.runUrl ? { url: input.forge.runUrl } : {}) });
  } catch (err) {
    warnings.push(`could not set the ${context} status: ${err instanceof Error ? err.message : String(err)}`);
  }
  // #4870: the checks the note job signed evidence for, when it signed any.
  const evidence = note !== undefined ? checkEvidenceNoteLine(input.dir) : undefined;
  if (note !== undefined && evidence) note = `${note}${note.endsWith("\n") ? "" : "\n"}\n${evidence}\n`;
  if (note !== undefined) {
    try {
      await upsertPlanNote(input.forge, input.pr, prNoteMarker(input.env, input.member), note);
    } catch (err) {
      warnings.push(`could not post the note on #${input.pr}: ${err instanceof Error ? err.message : String(err)}`);
      note = undefined;
    }
  }
  // #4628: the note in the job summary, on a forge that keeps one.
  if (input.summaryFile && (note !== undefined || refused !== undefined)) {
    try {
      appendFileSync(input.summaryFile, `${note !== undefined ? planNoteSummary(note) : `${context}: ${description}\n`}\n`);
    } catch (err) {
      warnings.push(`could not write the job summary: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return note;
}

/**
 * Read a product's plan note hand-off under `dir` (#4799) and check it is the
 * one the caller ran, as {@link readPlanReport} checks a report.
 */
export function readPlanNoteHandoff(input: Pick<PlanPostInput, "dir" | "pr" | "head" | "env" | "member">): { handoff: PrPlanNoteHandoff } | { refused: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(join(input.dir, PR_PLAN_NOTE_FILE), "utf-8"));
  } catch (err) {
    return { refused: `the plan note does not read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { refused: "the plan note is not an object" };
  const r = doc as Record<string, unknown>;
  if (r.kind !== "plan-note-handoff") return { refused: `the file is not a plan note hand-off (kind ${JSON.stringify(r.kind)})` };
  if (r.contract !== PR_PLAN_NOTE_CONTRACT) return { refused: `the plan note follows contract ${JSON.stringify(r.contract)}, and this chant reads ${PR_PLAN_NOTE_CONTRACT}` };
  if (r.pr !== input.pr) return { refused: `the plan note is for pull request ${JSON.stringify(r.pr)}, not ${input.pr}` };
  if (typeof r.head !== "string" || !SHA.test(r.head) || r.head !== input.head) return { refused: `the plan note is for head ${JSON.stringify(r.head)}, not ${input.head}` };
  if (r.env !== input.env) return { refused: `the plan note is for environment ${JSON.stringify(r.env)}, not ${input.env}` };
  if ((r.member ?? undefined) !== input.member) return { refused: `the plan note is for ${JSON.stringify(r.member ?? null)}, not ${JSON.stringify(input.member ?? null)}` };
  if (r.state !== "success" && r.state !== "failure" && r.state !== "pending") return { refused: `the plan note's state ${JSON.stringify(r.state)} is not success, failure or pending` };
  if (typeof r.description !== "string") return { refused: "the plan note has no description" };
  if (!isPlanNote(r.note) || r.note.head !== r.head || !Array.isArray(r.note.waves) || !Array.isArray(r.note.groups) || !Array.isArray(r.note.named)) {
    return { refused: "the plan note's note is not a plan note for its head" };
  }
  // #4931: the product's hidden line is the change's too, so it holds only plain words.
  if (r.marker !== undefined && (typeof r.marker !== "string" || r.marker.length > PRODUCT_MARKER_LIMIT || (r.marker !== "" && !PRODUCT_MARKER_BODY.test(r.marker)))) {
    return { refused: `the plan note's marker is not words of letters, digits and _.,/@+=:- of at most ${PRODUCT_MARKER_LIMIT} characters` };
  }
  return { handoff: doc as PrPlanNoteHandoff };
}

/** The notices in the file `CHANT_PLAN_NOTE_NOTICES` names (#4931), one a line, or none when unset or unreadable. */
export function noticesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const file = env.CHANT_PLAN_NOTE_NOTICES;
  if (!file || !existsSync(file)) return [];
  try {
    return readFileSync(file, "utf-8").split("\n").map((l) => l.trim()).filter((l) => l !== "");
  } catch {
    return [];
  }
}

/** The note words from `CHANT_PLAN_NOTE_WORDS` (#4799), or undefined when unset or not an object. */
function noteWordsFromEnv(): PrPlanNoteWords | undefined {
  const raw = process.env.CHANT_PLAN_NOTE_WORDS;
  if (!raw) return undefined;
  try {
    const w = JSON.parse(raw) as unknown;
    return w && typeof w === "object" && !Array.isArray(w) ? (w as PrPlanNoteWords) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The note for a product's plan note hand-off (#4799): rendered here with
 * the pipeline's note words, every `<!--` after the marker line defused as
 * {@link planNoteFor} does, except the waves marker chant itself rendered
 * from the note's waves, which the product reads back.
 */
export function planNoteHandoffNote(handoff: PrPlanNoteHandoff, forge: Pick<PrForge, "kind">, marker: string, noteWords?: PrPlanNoteWords, baseTip?: string): string {
  const words = activeProductWords();
  const rendered = renderPlanNote(handoff.note, { limit: forge.kind === "gitlab" ? GITLAB_NOTE_LIMIT : GITHUB_COMMENT_LIMIT, words, ...(noteWords ? { note: noteWords } : {}) });
  let body = rendered.split("<!--").join("&lt;!--");
  const n = handoff.note;
  const previews = n.previews ?? [];
  const waves = planNoteMarker(noteWords?.marker ?? `${words.product}:waves`, { head: n.head, waves: n.waves.map((x) => ({ number: x.number, digest: x.digest ?? null, waits: x.waits === true })), ...(previews.length ? { previews } : {}) });
  body = body.replace(`&lt;!--${waves.slice(4)}`, waves);
  const tip = baseTip && SHA.test(baseTip) ? `${body.endsWith("\n") ? "" : "\n"}${prNoteTipMarker(baseTip)}\n` : "";
  // #4931: the product's own line, from the pipeline's name and the hand-off's checked body, under chant's marker.
  const name = noteWords?.productMarker;
  const own = name !== undefined && PRODUCT_MARKER_NAME.test(name) && handoff.marker !== undefined ? `${productMarkerLine(name, handoff.marker)}\n` : "";
  return `${marker}\n${own}${body}${tip}`;
}

/** {@link postPlanReport} for a product's plan note hand-off (#4799). */
async function postPlanNoteHandoff(input: PlanPostInput): Promise<PlanPostResult> {
  const warnings: string[] = [];
  const context = prStatusContext("plan", input.member);
  const read = readPlanNoteHandoff(input);
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
    state = read.handoff.state;
    description = read.handoff.description;
    // #4931: the overdue Ops (#4289), asked here with the job's token, and the note job's own notices, under the counts.
    const given = read.handoff.note.notices ?? [];
    // An Op the product's own notices already call overdue is not said twice.
    const overdue = input.overdue ? (await input.overdue().catch(() => [] as PrOverdue[])).filter((o) => !given.some((g) => g.includes(`\`${o.op}\``) && g.includes("overdue"))).map((o) => o.message) : [];
    const added = [...overdue, ...(input.notices ?? noticesFromEnv())].filter((n, i, all) => !given.includes(n) && all.indexOf(n) === i);
    const handoff = added.length > 0 ? { ...read.handoff, note: { ...read.handoff.note, notices: [...given, ...added] } } : read.handoff;
    try {
      note = planNoteHandoffNote(handoff, input.forge, prNoteMarker(input.env, input.member), input.noteWords ?? noteWordsFromEnv(), input.baseTip);
    } catch (err) {
      refused = `the plan note does not render: ${err instanceof Error ? err.message : String(err)}`;
      state = "failure";
      description = cut(refused);
    }
    if (failedJob && state !== "failure") {
      state = "failure";
      description = cut(`the plan job failed; ${description}`);
    }
  }
  note = await postOutcome(input, context, state, description, note, refused, warnings);
  const recorded = await keepRunRecord(input, warnings);
  return { state, description: cut(description), noted: note !== undefined, ...(refused ? { refused } : {}), ...(recorded ? { recorded } : {}), warnings };
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
  /** The target branch's commit this pipeline runs at (#4628), for each note's tip line. */
  baseTip?: string;
  /**
   * Keep each plan job's run record (#4899) from its artifacts, the job
   * named as its run origin's `jobId`. `repo` is the project's path.
   */
  recordRun?: { repo?: string; keep: PlanRunRecorder["keep"] };
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
        // #4799: a product's plan verb writes its plan note hand-off in place of the report.
        const handoff = text === undefined ? await forge.jobArtifact(job.id, `${input.artifactDir.replace(/\/+$/, "")}/${PR_PLAN_NOTE_FILE}`) : undefined;
        if (handoff !== undefined) writeFileSync(join(dir, PR_PLAN_NOTE_FILE), handoff);
        // #4899: the plan job's run record, kept with its note.
        const runRecord = input.recordRun ? await forge.jobArtifact(job.id, `${input.artifactDir.replace(/\/+$/, "")}/${PLAN_RUN_RECORD_FILE}`) : undefined;
        if (runRecord !== undefined) writeFileSync(join(dir, PLAN_RUN_RECORD_FILE), runRecord);
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
          ...(input.baseTip ? { baseTip: input.baseTip } : {}),
          ...(input.recordRun
            ? { recordRun: { origin: { forge: "gitlab", ...(input.recordRun.repo ? { repo: input.recordRun.repo } : {}), ...(job.url ? { url: job.url } : {}), jobId: String(job.id) }, keep: input.recordRun.keep } }
            : {}),
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

/** What {@link markStaleNotes} marks. */
export interface StaleMarkInput {
  /** A client that lists open pull requests ({@link PrForge.openPullRequests}). */
  forge: PrForge;
  /** The target branch that moved. */
  branch: string;
  /** Its commit now: the push's. */
  tip: string;
  env: string;
  member?: string;
  /** The pipeline answers the plan comment (`--preview-comment`), so the stale line names it. */
  previewComment?: boolean;
  words?: CiProductWords;
}

/** What {@link markStaleNotes} did for one pull request. */
export interface StaleMark {
  pr: number;
  /** Marked stale, and its status set back to pending. */
  marked?: boolean;
  /** Why it was left alone. */
  skipped?: string;
}

/**
 * Mark stale each open pull request's note into `branch` that was posted
 * against another commit than `tip` (#4628): a line after the marker says
 * the branch moved and names the comment that previews again (or a push,
 * when the pipeline answers no plan comment), and the plan status on the
 * pull request's head goes back to pending. A note with no tip line (posted
 * before #4628), one at `tip`, or one already marked at `tip` is left alone.
 * A forge that refuses one pull request is a warning, and the others go on.
 */
export async function markStaleNotes(input: StaleMarkInput): Promise<{ marks: StaleMark[]; warnings: string[] }> {
  const { forge } = input;
  if (!SHA.test(input.tip)) throw new Error(`the target branch's commit is a full sha, not ${JSON.stringify(input.tip)}`);
  if (!forge.openPullRequests) throw new Error(`marking notes stale lists the open pull requests into ${input.branch}, which this ${forge.kind} client cannot`);
  const words = input.words ?? activeProductWords();
  const marker = prNoteMarker(input.env, input.member);
  const context = prStatusContext("plan", input.member, words);
  const comment = input.previewComment ? commentLine(words, "plan") : undefined;
  const verb = words.verbs.plan[0];
  const again = comment ? `comment \`${comment}\` to ${verb} again` : `push a commit to ${verb} again`;
  const marks: StaleMark[] = [];
  const warnings: string[] = [];
  for (const pr of await forge.openPullRequests(input.branch)) {
    try {
      const found = await forge.findComment(pr.number, marker);
      if (!found) {
        marks.push({ pr: pr.number, skipped: "no note" });
        continue;
      }
      const planned = TIP_LINE.exec(found.body)?.[1];
      if (!planned) {
        marks.push({ pr: pr.number, skipped: "the note names no target branch commit" });
        continue;
      }
      if (planned === input.tip) {
        marks.push({ pr: pr.number, skipped: "the note is current" });
        continue;
      }
      if (STALE_LINE.exec(found.body)?.[1] === input.tip) {
        marks.push({ pr: pr.number, skipped: "already marked" });
        continue;
      }
      const lines = found.body.split("\n");
      const head = lines[0] === marker ? 1 : 0;
      const kept = lines.slice(head).filter((l) => !l.startsWith(STALE_PREFIX) && !STALE_LINE.test(l));
      while (kept[0] === "") kept.shift();
      const line = `${STALE_PREFIX}${input.branch} moved to \`${input.tip.slice(0, 12)}\` since this ${verb} was posted against \`${planned.slice(0, 12)}\`, so it may no longer show what the merge does; ${again}.`;
      await forge.upsertNote(pr.number, marker, [marker, line, prNoteStaleMarker(input.tip), "", ...kept].join("\n"));
      try {
        await forge.setStatus(pr.headSha, { context, state: "pending", description: cut(`stale: ${input.branch} moved; ${again.replace(/`/g, "")}`) });
      } catch (err) {
        warnings.push(`#${pr.number}: could not set the ${context} status back to pending: ${err instanceof Error ? err.message : String(err)}`);
      }
      marks.push({ pr: pr.number, marked: true });
    } catch (err) {
      warnings.push(`#${pr.number}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { marks, warnings };
}
