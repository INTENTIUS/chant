/**
 * The two jobs of a split review on GitLab (#4544): `ScheduledOpSpec.reviewAgent`.
 *
 * An Op that runs a `reviewAgent` step in `handoff` mode runs the change's
 * code (`chant run` loads the merge request's Op files) beside a model.
 * GitHub and Forgejo keep the write token out of that job with per-job
 * permissions (`lexicons/github/src/components/review-jobs.ts`). GitLab has
 * none: a merge request pipeline is built from the merge request's own files
 * and every job in it gets the project's unprotected variables. So the token
 * stays out of that pipeline altogether, the way the plan note does (#4328):
 *
 * - the review job runs in the merge request pipeline. Its script starts by
 *   unsetting every forge token variable (`GITLAB_DROP_FORGE_TOKENS`), and it
 *   keeps the review directory as its artifact. `CHANT_FORGE_TOKEN` is a
 *   protected variable, which a merge request pipeline never gets.
 * - the note job runs in a pipeline of the default branch, built from that
 *   branch's files, that a pipeline schedule (or a person, the API or a
 *   trigger) starts with `CHANT_REVIEW_NOTES` set to `1`. It checks nothing
 *   out (`GIT_STRATEGY: none`), installs the chant release this lexicon
 *   belongs to, and runs `postOpenReviewNotes` with the protected token: for
 *   each open merge request whose newest pipeline's review job succeeded it
 *   reads `review.json` from that job's artifacts as data and posts the note.
 *   The Op's name, the review job's name and the branches come from this
 *   file, never from the artifact.
 */

import { readFileSync } from "node:fs";
import { GITLAB_DROP_FORGE_TOKENS } from "@intentius/chant/ci-handover";
import type { OpTrigger } from "@intentius/chant/lexicon";

/** The variable `reviewAgent` reads its handoff directory from (`REVIEW_DIR_ENV`, review-agent.ts). */
export const REVIEW_DIR_ENV = "CHANT_REVIEW_DIR";

/** Where the review job writes the review, from the directory its script runs in. */
export const REVIEW_DIR = ".chant/review";

/** The variable a pipeline of the default branch is started with to run the note jobs. */
export const GITLAB_REVIEW_NOTES_VAR = "CHANT_REVIEW_NOTES";

/** How long a review artifact is kept: long enough for a schedule to come round and post it. */
const REVIEW_ARTIFACT_EXPIRY = "7 days";

/** The name of the note job beside the Op's own job. */
export function reviewNoteJobName(jobName: string): string {
  return `${jobName}-note`;
}

/**
 * The note job's rule: a pipeline of the default branch that a pipeline
 * schedule, a person, the API or a trigger started with `CHANT_REVIEW_NOTES`
 * set to `1`. A merge request pipeline's own trigger job starts a pipeline
 * whose source is `pipeline`, which this rule leaves out.
 */
export const GITLAB_REVIEW_NOTES_RULE = `$CI_PIPELINE_SOURCE =~ /^(schedule|web|api|trigger)$/ && $${GITLAB_REVIEW_NOTES_VAR} == "1" && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH`;

/**
 * Refuse a spec whose review cannot be split the way this shape needs: a
 * trigger with no merge request, a finding-mode that would post from the
 * review job, or an additive scope other than `id-token: write`.
 */
export function assertReviewSplit(name: string, trigger: OpTrigger, findingMode: string, permissions: Record<string, string> | undefined): void {
  if (trigger.kind !== "pull_request") {
    throw new Error(
      `Scheduled Op "${name}" sets reviewAgent, which posts the review as a note on the merge request that triggered the run, but its trigger is "${trigger.kind}". Give it a { kind: "pull_request" } trigger.`,
    );
  }
  if (findingMode !== "report") {
    throw new Error(
      `Scheduled Op "${name}" sets reviewAgent with findingMode "${findingMode}". The review job holds no forge token, and the note job posts from a pipeline of the default branch instead, so the Op's own finding-mode must be "report".`,
    );
  }
  for (const [scope, level] of Object.entries(permissions ?? {})) {
    if (level === "write" && scope !== "id-token") {
      throw new Error(
        `Scheduled Op "${name}" sets reviewAgent and adds the permission "${scope}: write". The review job runs the change's code and may hold only "id-token: write".`,
      );
    }
  }
}

/** The chant release the note job installs: this lexicon's own, which releases in lockstep with `@intentius/chant`. */
function chantVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string" || pkg.version === "") {
    throw new Error("the gitlab lexicon's package.json has no version to pin the review note job's chant to");
  }
  return pkg.version;
}

/** What the note job runs under node. The inputs are JSON literals from this file; nothing comes from the merge request. */
function noteModule(op: string, job: string, artifactDir: string, branches: readonly string[] | undefined): string {
  return [
    'import { forgeFromEnv } from "@intentius/chant/pr-forge";',
    'import { postOpenReviewNotes } from "@intentius/chant/op/activities/review-agent";',
    `const branches = ${JSON.stringify(branches ?? null)} ?? [process.env.CI_DEFAULT_BRANCH];`,
    "const forge = forgeFromEnv(\"gitlab\");",
    "let failed = false;",
    "for (const branch of branches) {",
    `  const { posts, warnings } = await postOpenReviewNotes({ forge, branch, job: ${JSON.stringify(job)}, artifactDir: ${JSON.stringify(artifactDir)}, op: ${JSON.stringify(op)} });`,
    "  for (const p of posts) console.log(`!${p.pr} at ${p.head.slice(0, 12)}: ${p.skipped ?? `posted, risk ${p.risk}`}`);",
    "  for (const w of warnings) { console.error(w); failed = true; }",
    "}",
    "if (failed) process.exitCode = 1;",
  ].join("\n");
}

/** The note job's script: install the pinned chant outside any checkout and run {@link noteModule} with tsx. */
function noteScript(version: string, module: string): string[] {
  return [
    'dir="${TMPDIR:-/tmp}/chant-review-note"',
    'mkdir -p "$dir"',
    'cd "$dir"',
    "echo '{\"private\":true}' > package.json",
    `npm install --omit=peer --no-audit --no-fund --loglevel=error @intentius/chant@${version}`,
    ["cat > note.mjs <<'NOTE'", module, "NOTE"].join("\n"),
    "node --import tsx note.mjs",
  ];
}

export interface GitlabReviewJobsInput {
  /** The Op's name: what `chant run` targets and what keys the note. */
  name: string;
  /** The review job's name: the Op's job name. */
  jobName: string;
  stage: string;
  image: string;
  /** The review job's `rules:`, the Op's merge request rules. */
  rules: unknown[];
  /** The review job's script after the token unset: cd, setup, before-script, the invocation and the extra script. */
  script: string[];
  /** The Op's own per-job environment (`ScheduledOpSpec.variables`). */
  variables?: Record<string, string>;
  idTokens?: Record<string, unknown>;
  /** The review directory from the repository root: `.chant/review`, under a workspace member's directory for a member. */
  artifactDir: string;
  /** The branches the merge requests merge into, from the trigger; the default branch when absent. */
  branches?: readonly string[];
}

/** The review job and the note job of one split review. */
export function gitlabReviewJobs(i: GitlabReviewJobsInput): { review: Record<string, unknown>; note: Record<string, unknown> } {
  const review = {
    stage: i.stage,
    image: i.image,
    resource_group: i.jobName,
    ...(i.idTokens ? { id_tokens: i.idTokens } : {}),
    variables: { ...(i.variables ?? {}), [REVIEW_DIR_ENV]: REVIEW_DIR },
    rules: i.rules,
    // The merge request's code runs in this job, so its shell drops every forge token first.
    script: [GITLAB_DROP_FORGE_TOKENS, ...i.script],
    artifacts: { paths: [i.artifactDir], expire_in: REVIEW_ARTIFACT_EXPIRY },
  };
  const note = {
    stage: i.stage,
    image: i.image,
    resource_group: reviewNoteJobName(i.jobName),
    // Nothing of the repository is needed: the review is read from the review job's artifacts through the API.
    variables: { GIT_STRATEGY: "none" },
    rules: [{ if: GITLAB_REVIEW_NOTES_RULE }],
    script: noteScript(chantVersion(), noteModule(i.name, i.jobName, i.artifactDir, i.branches)),
  };
  return { review, note };
}
