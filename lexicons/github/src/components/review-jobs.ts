/**
 * The two jobs of a split review (#4326): `ScheduledOpSpec.reviewAgent`.
 *
 * An Op that runs a `reviewAgent` step in `handoff` mode runs the change's
 * code (`chant run` loads the pull request's Op files) beside a model. This
 * generator keeps the forge write token out of that job and posts the note
 * from another one, as terragucci's review does (`render-review.ts`: the
 * `review` and `review-note` jobs):
 *
 * - the review job holds `contents: read` and no forge token in any step's
 *   environment, bar the checkout script's fetches (`checkoutScript`,
 *   ../../../../packages/core/src/ci-handover.ts). Every later step starts
 *   without the token variables (`dropForgeTokens`). The `chant run` step is
 *   its last, and it hands the review directory on as the job's outputs
 *   (`handoverTrap`), in place of an artifact upload that would start beside
 *   whatever the change's code left running.
 * - the note job checks nothing out. It takes the outputs back as data
 *   (`takeOverScript`), installs the chant release this lexicon belongs to
 *   and runs `postReviewNote` with the job's token. The Op's name comes from
 *   this file, not from the review, which the change's code wrote.
 *
 * Forgejo's runner ignores `permissions:` and may put its token in a step's
 * environment, so the review job drops the token variables on both forges.
 */

import { readFileSync } from "node:fs";
import { GITHUB_JOB_TOKEN, GITHUB_RUNNER } from "@intentius/chant/ci-jobs";
import { CHECKOUT_TOKEN_ENV, checkoutScript, dropForgeTokens, handoverOutputs, handoverTrap, takeOverScript } from "@intentius/chant/ci-handover";
import type { OpTrigger, PipelineMember } from "@intentius/chant/lexicon";

/** The variable `reviewAgent` reads its handoff directory from (`REVIEW_DIR_ENV`, review-agent.ts). */
const REVIEW_DIR_ENV = "CHANT_REVIEW_DIR";

/** Where the review job writes the review, from the directory the step starts in. */
const REVIEW_DIR = ".chant/review";

/** The id of the review job's `chant run` step, which its outputs come from. */
const REVIEW_STEP_ID = "chant-review";

/** The name of the note job beside the Op's own job. */
export function reviewNoteJobName(jobName: string): string {
  return `${jobName}-note`;
}

/**
 * Refuse a spec whose review cannot be split the way this shape needs:
 * a trigger with no pull request to post on, a finding-mode that would give
 * the review job a write scope, or an additive scope that would.
 */
export function assertReviewSplit(name: string, trigger: OpTrigger, findingMode: string, permissions: Record<string, string> | undefined): void {
  if (trigger.kind !== "pull_request") {
    throw new Error(
      `Scheduled Op "${name}" sets reviewAgent, which posts the review as a note on the pull request that triggered the run, but its trigger is "${trigger.kind}". Give it a { kind: "pull_request" } trigger.`,
    );
  }
  if (findingMode !== "report") {
    throw new Error(
      `Scheduled Op "${name}" sets reviewAgent with findingMode "${findingMode}". The review job holds no forge write token, and the note job posts instead, so the Op's own finding-mode must be "report".`,
    );
  }
  for (const [scope, level] of Object.entries(permissions ?? {})) {
    if (level === "write" && scope !== "id-token") {
      throw new Error(
        `Scheduled Op "${name}" sets reviewAgent and adds the permission "${scope}: write". The review job runs the change's code and may hold only "id-token: write" beyond contents: read.`,
      );
    }
  }
}

/** The chant release the note job installs: this lexicon's own, which releases in lockstep with `@intentius/chant`. */
function chantVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error("the github lexicon's package.json has no version to pin the review note job's chant to");
  }
  return pkg.version;
}

/** What the note job runs under node: `postReviewNote` over the review the review job handed on. Plain JavaScript, no `${{ }}`. */
const NOTE_SCRIPT = [
  'import { postReviewNote } from "@intentius/chant/op/activities/review-agent";',
  `const { CHANT_OP: op, ${REVIEW_DIR_ENV}: dir } = process.env;`,
  "const result = await postReviewNote({ op, dir });",
  "console.log(result.reason);",
  "if (!result.posted) process.exitCode = 1;",
].join("\n");

/** Where the note job puts the review it took back: outside any checkout, which it has none of. */
const NOTE_DIR = '"${RUNNER_TEMP:-/tmp}/chant-review"';

/** The note step's shell: install the pinned chant beside the review and run {@link NOTE_SCRIPT} with tsx. */
function noteScript(version: string): string {
  return [
    `review=${NOTE_DIR}`,
    'dir="${RUNNER_TEMP:-/tmp}/chant-review-note"',
    'mkdir -p "$dir"',
    'cd "$dir"',
    "echo '{\"private\":true}' > package.json",
    `npm install --omit=peer --no-audit --no-fund --loglevel=error @intentius/chant@${version}`,
    "cat > note.mjs <<'NOTE'",
    NOTE_SCRIPT,
    "NOTE",
    `${REVIEW_DIR_ENV}="$review" node --import tsx note.mjs`,
  ].join("\n");
}

export interface ReviewJobsInput {
  /** The Op's name: what `chant run` targets and what keys the note. */
  name: string;
  /** The Op's job name. */
  jobName: string;
  image: string;
  /** The invocation of the Op, `chant run <name>` by default. */
  invocation: string;
  /** Setup steps, as built by `setupStepDoc`. */
  setup: Array<Record<string, unknown>>;
  beforeScript: readonly string[];
  extraScript: readonly string[];
  /** The Op's own per-job environment (`ScheduledOpSpec.variables`). */
  variables?: Record<string, string>;
  member?: PipelineMember;
}

/** The review job and the note job of one split review. */
export function reviewJobs(i: ReviewJobsInput): { review: Record<string, unknown>; note: Record<string, unknown> } {
  const drop = dropForgeTokens("sh");
  const rooted = !i.member || i.member.dir === "." || i.member.dir === "";
  const headStep = (line: string): Record<string, unknown> => ({ run: `${drop}\n${line}` });
  const review = {
    "runs-on": GITHUB_RUNNER,
    container: i.image,
    ...(i.variables && Object.keys(i.variables).length > 0 ? { env: i.variables } : {}),
    outputs: handoverOutputs(REVIEW_STEP_ID, "github"),
    steps: [
      // A script, not actions/checkout: the token reaches the fetches alone, and the base branch's history comes with them for the diff.
      {
        name: "Check out the change",
        ...(rooted ? {} : { "working-directory": "." }),
        env: { [CHECKOUT_TOKEN_ENV]: GITHUB_JOB_TOKEN },
        run: checkoutScript(true),
      },
      ...i.setup,
      ...i.beforeScript.map(headStep),
      // The job's last step: it hands the review directory on as the job's outputs when it ends, however it ends.
      {
        id: REVIEW_STEP_ID,
        name: "Run the Op and keep its review",
        env: { [REVIEW_DIR_ENV]: REVIEW_DIR },
        run: [drop, ...handoverTrap(REVIEW_DIR, "github"), i.invocation, ...i.extraScript].join("\n"),
      },
    ],
  };
  const note = {
    needs: i.jobName,
    if: `needs.${i.jobName}.result == 'success'`,
    "runs-on": GITHUB_RUNNER,
    container: i.image,
    permissions: { "pull-requests": "write" },
    steps: [
      { name: "Take the review from the review job", run: takeOverScript(i.jobName, NOTE_DIR, "github") },
      { name: "Post the review as a note", env: { GITHUB_TOKEN: GITHUB_JOB_TOKEN, CHANT_OP: i.name }, run: noteScript(chantVersion()) },
    ],
  };
  return { review, note };
}
