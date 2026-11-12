/**
 * #5027: the product pipeline names its comment job and its waves' jobs as
 * the product does. The comment job takes `commentJob.jobName` (terragucci's
 * `apply-comment`), and a merged pull request's re-run looks for the waves'
 * jobs under the same `jobNames` the Op waves generator renders (#5022), so
 * terragucci's `apply-wave-<k>`, its shares, its group jobs and `apply-rest`
 * run again. Without them the job is `comment` and the re-run's pattern is
 * `RERUN_APPLY_JOBS`, as before.
 */
import { describe, expect, test } from "vitest";
import type { OpWavesSpec } from "../op/op-waves";
import type { OpWavesJobRef } from "../op/op-waves-names";
import { answerProductComment, RERUN_APPLY_JOBS, rerunApplyJobs, type AnswerCommentOptions, type CommentJobs } from "../ci-comment-commands";
import { assertProductWords } from "../ci-product-words";
import { commentJobsFromEnv } from "../cli/handlers/pr-comment";
import type { ForgeReads, PullRequestDetail, RunJob, WorkflowRun } from "../pr-forge-reads";
import { PR_COMMENT_JOB } from "../ci-comment-commands";
import { productPipelineJobs } from "./product-pipeline";

const words = { product: "terragucci", noun: ["root", "roots"] as [string, string], commands: { plan: "plan" as const, apply: "apply" as const }, approval: "per-wave" as const, op: "tf-apply", bin: "terragucci" };

/** The waves of PR 5026's names goldens: a canary, a wide wave with shares, a wave of job groups (one with shares) and a rest wave. */
const waves = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "{runs}", "{plans}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "canary", runs: [], discover: true },
    { name: "wide", runs: [], discover: true, shares: 2 },
    { name: "regions", runs: [], discover: true, jobs: [{ name: "east", runs: ["east/*"] }, { name: "west", runs: ["west/*"], shares: 2 }] },
    { name: "rest", runs: [], discover: true, rest: true },
  ],
} as unknown as OpWavesSpec;

/** terragucci's names, as PR 5026's names goldens give them. */
const terragucciJob = (j: OpWavesJobRef): string | undefined => {
  const w = j.rest ? "apply-rest" : `apply-wave-${j.wave}`;
  const part = `${j.group !== undefined ? `-${j.group}` : ""}${j.share !== undefined ? `-share-${j.share}` : ""}`;
  switch (j.role) {
    case "wave":
    case "decide":
      return w;
    case "share":
    case "group":
    case "apply":
      return `${w}${part}`;
    case "plan":
    case "gate":
    case "record":
      return `${w}-${j.role}`;
    case "apply-status":
      return j.wave === waves.waves.length ? "apply-done" : `${w}-status`;
    case "before-merge-done":
      return "pr-merge";
    case "control":
      return "control";
    default:
      return undefined;
  }
};

const PUSH_JOBS = ["apply-wave-1", "apply-wave-2", "apply-wave-2-share-1", "apply-wave-2-share-2", "apply-wave-3", "apply-wave-3-east", "apply-wave-3-west-share-1", "apply-wave-3-west-share-2", "apply-rest"];
const productPlan = { command: "terragucci plan --out {output}", replan: true };
const env = (jobs: { comment?: { env: Record<string, string> } }): CommentJobs => JSON.parse(jobs.comment!.env.CHANT_COMMENT_JOBS!);

describe("the comment job's name (#5027)", () => {
  test("is the product's, and comment by default", () => {
    const named = productPipelineJobs("github", "default", { words, waves, productPlan, commentJob: { jobName: "apply-comment" } });
    expect(named.comment!.jobName).toBe("apply-comment");
    for (const commentJob of [true, {}] as const) expect(productPipelineJobs("github", "default", { words, waves, productPlan, commentJob }).comment!.jobName).toBe(PR_COMMENT_JOB);
    expect(PR_COMMENT_JOB).toBe("comment");
  });

  test("a name the forge cannot take is refused", () => {
    expect(() => productPipelineJobs("github", "default", { words, waves, productPlan, commentJob: { jobName: "apply comment" } })).toThrow(/commentJob\.jobName "apply comment" is not a job name/);
    expect(() => productPipelineJobs("forgejo", "default", { words, waves, productPlan, commentJob: { jobName: "1st" } })).toThrow(/not a job name/);
  });
});

describe("the re-run's jobs follow the waves' names (#5027)", () => {
  test("by default the comment job carries no list and the re-run keeps RERUN_APPLY_JOBS", () => {
    const jobs = productPipelineJobs("github", "default", { words, waves, productPlan, commentJob: true });
    expect(env(jobs).applyJobs).toBeUndefined();
    expect(jobs.comment!.jobs.applyJobs).toBeUndefined();
    expect(jobs.waves!.pipeline.jobNames).toBeUndefined();
    expect(jobs.waves!.jobs.map((j) => j.jobName)).toEqual(["wave-1-canary", "wave-2-wide-decide", "wave-2-wide-share-1", "wave-2-wide-share-2", "wave-3-regions-decide", "wave-3-regions-east", "wave-3-regions-west-share-1", "wave-3-regions-west-share-2", "wave-4-rest"]);
    expect(rerunApplyJobs({})).toBe(RERUN_APPLY_JOBS);
    expect(rerunApplyJobs({ applyJobs: [] })).toBe(RERUN_APPLY_JOBS);
  });

  test("with terragucci's names the comment job looks for apply-wave-<k>, its shares, its groups and apply-rest", () => {
    const jobs = productPipelineJobs("github", "default", { words, waves, productPlan, commentJob: { jobName: "apply-comment" }, wavesJobNames: terragucciJob });
    expect(env(jobs).applyJobs).toEqual(PUSH_JOBS);
    expect(jobs.waves!.jobs.map((j) => j.jobName)).toEqual(PUSH_JOBS);
    expect(jobs.waves!.jobs.find((j) => j.jobName === "apply-wave-2-share-1")!.needs).toEqual(["apply-wave-2"]);
    // The generator is handed the same names, so the jobs it renders are the ones the re-run looks for.
    expect(jobs.waves!.pipeline.jobNames).toBe(terragucciJob);
    const pattern = rerunApplyJobs(env(jobs));
    for (const name of PUSH_JOBS) expect(pattern.test(name), name).toBe(true);
    for (const name of ["apply-comment", "apply-wave-1-evidence", "apply-wave-1-status", "apply-done", "stale-notes", "control", "apply-wave-10", "xapply-rest", "wave-1-canary"]) expect(pattern.test(name), name).toBe(false);
    // chant's pattern skips the group jobs and the rest wave, which is what #5027 is about.
    expect(["apply-wave-3-east", "apply-wave-3-west-share-1", "apply-rest"].filter((n) => RERUN_APPLY_JOBS.test(n))).toEqual([]);
  });

  test("before merge the split jobs are looked for too, by the same names", () => {
    const jobs = productPipelineJobs("github", "default", { words, waves, productPlan, commentJob: { jobName: "apply-comment" }, wavesJobNames: terragucciJob, wavesBeforeMerge: { workflowFile: "terragucci.yml", dispatchInputs: { pr: "apply_pr", head: "apply_head", digest: "apply_digest" } } });
    const names = env(jobs).applyJobs!;
    for (const name of [...PUSH_JOBS, "apply-wave-1-plan", "apply-wave-1-gate", "apply-wave-1-record", "apply-wave-2-share-2", "apply-wave-3-west-share-1", "apply-rest-plan", "apply-rest-record"]) expect(names, name).toContain(name);
    expect(new Set(names).size).toBe(names.length);
    expect(jobs.waves!.pipeline).toMatchObject({ workflowFile: "terragucci.yml", jobNames: terragucciJob });
  });

  test("is refused without waves, and the generator's checks hold", () => {
    expect(() => productPipelineJobs("github", "default", { words, productPlan, commentJob: true, wavesJobNames: terragucciJob })).toThrow(/wavesJobNames names the waves' jobs, and there are none/);
    expect(() => productPipelineJobs("github", "default", { words, waves, productPlan, commentJob: true, wavesJobNames: () => "apply" })).toThrow(/names two jobs apply/);
  });

  test("the job reads the list from CHANT_COMMENT_JOBS, and refuses one that is not job names", () => {
    expect(commentJobsFromEnv(JSON.stringify({ applyOnMerge: true, applyJobs: PUSH_JOBS })).applyJobs).toEqual(PUSH_JOBS);
    expect(commentJobsFromEnv(JSON.stringify({ applyJobs: [] })).applyJobs).toBeUndefined();
    expect(() => commentJobsFromEnv(JSON.stringify({ applyJobs: ["apply-rest", "a b"] }))).toThrow(/applyJobs is a list of job names/);
    expect(() => commentJobsFromEnv(JSON.stringify({ applyJobs: "apply-rest" }))).toThrow(/applyJobs is a list of job names/);
  });
});

describe("a merged pull request's apply runs terragucci's jobs again (#5027)", () => {
  const MERGE = "a".repeat(40);
  const run: WorkflowRun = { id: 10, event: "push", headSha: MERGE, status: "completed", conclusion: "failure", done: true, pullRequests: [], workflow: "terragucci.yml", url: "https://github.com/acme/infra/actions/runs/10" };
  const job = (id: number, name: string, conclusion: string): RunJob => ({ id, name, status: "completed", conclusion, done: true }) as RunJob;

  const answer = async (jobs: CommentJobs, runJobs: RunJob[], forge: "github" | "forgejo" = "github") => {
    const posted: string[] = [];
    const reran: number[] = [];
    const dispatched: string[] = [];
    const reads = {
      kind: forge,
      permission: async () => "write",
      pullRequest: async (n: number) => ({ number: n, title: "", body: "", state: "merged", head: "feature", headSha: "c".repeat(40), base: "main", sameRepo: true, mergeCommit: MERGE }) as PullRequestDetail,
      headRuns: async () => [run],
      runJobs: async () => runJobs,
      branchRuns: async () => [run],
    } as unknown as ForgeReads;
    const opts: AnswerCommentOptions = {
      forge,
      event: { action: "created", comment: { id: 7, body: "/terragucci apply", user: { login: "alice" } }, issue: { number: 12, pull_request: {} }, repository: { full_name: "acme/infra", permissions: { push: true } }, sender: { login: "alice" } },
      repo: "acme/infra",
      reads,
      poster: { addComment: async (_n: number, text: string) => (posted.push(text), { id: 1 } as never), commitStatuses: async () => [] as never },
      runs: { rerunFailed: async (id) => (reran.push(id), {}), dispatch: async (wf) => (dispatched.push(wf), {}) },
      words: assertProductWords(words),
      base: "main",
      jobs,
    };
    const got = await answerProductComment(opts);
    return { got, posted, reran, dispatched };
  };

  test("a run whose only failure is apply-rest is started again, where chant's pattern would see the earlier waves' successes alone", async () => {
    const jobs = productPipelineJobs("github", "default", { words, waves, productPlan, commentJob: { jobName: "apply-comment" }, wavesJobNames: terragucciJob });
    const runJobs = [...PUSH_JOBS.slice(0, -1).map((n, i) => job(i + 1, n, "success")), job(99, "apply-rest", "failure"), job(100, "apply-comment", "failure")];
    const named = await answer(commentJobsFromEnv(jobs.comment!.env.CHANT_COMMENT_JOBS), runJobs);
    expect(named.reran).toEqual([10]);
    expect(named.got.ran).toBe(true);
    const chant = await answer({ applyOnMerge: true }, runJobs);
    expect(chant.reran).toEqual([]);
    expect(chant.posted[0]).toMatch(/already succeeded/);
  });

  test("on Forgejo a failed group job dispatches the workflow again", async () => {
    const jobs = productPipelineJobs("forgejo", "default", { words, waves, productPlan, commentJob: { jobName: "apply-comment" }, wavesJobNames: terragucciJob });
    const runJobs = [job(1, "apply-wave-1", "success"), job(2, "apply-wave-3-east", "failure")];
    const got = await answer(commentJobsFromEnv(jobs.comment!.env.CHANT_COMMENT_JOBS), runJobs, "forgejo");
    expect(got.dispatched).toEqual(["terragucci.yml"]);
  });
});
