/**
 * The comment job on GitHub and Forgejo (#4946): every `/<product>` comment
 * no other job takes gets a reply, a merged pull request's apply runs again,
 * and the words' replies and alias refusals reach both forges.
 */
import { describe, expect, test } from "vitest";
import { answerProductComment, commentRuns, RERUN_APPLY_JOBS, type CommentJobs, type AnswerCommentOptions } from "./ci-comment-commands";
import { chantNoteRuns, type NoteCommand } from "./ci-note-commands";
import { assertProductWords, productWordsProblems, resolveProductWords, type CiProductWordsInput } from "./ci-product-words";
import { commentJobsFromEnv } from "./cli/handlers/pr-comment";
import type { ForgeReads, PullRequestDetail, RunJob, WorkflowRun } from "./pr-forge-reads";

const MERGE = "a".repeat(40);
const LATER = "b".repeat(40);

/** terragucci's words, as its comment.ts reads them: the atlantis aliases, and its own sentences. */
const tgInput: CiProductWordsInput = {
  product: "terragucci",
  noun: ["root", "roots"],
  commands: { plan: "plan", apply: "apply", lock: "lock", unlock: "unlock", action: "action", agent: "agent", fmt: "commit" },
  aliases: [
    { from: "atlantis plan", command: "plan", when: "TG_ATLANTIS_COMMENTS", refuse: { "-p": "a root goes by its path, not a project name: write `atlantis plan -d <dir>`", "-w": "`-w` picks a workspace, and terragucci has none" } },
    { from: "atlantis apply", command: "apply", when: "TG_ATLANTIS_COMMENTS", refuse: { "-d": "`atlantis apply -d` applies one root, and terragucci does not" } },
  ],
  replies: {
    apply: "this pipeline does not apply on a comment: re-run the apply job on the forge, or push to the default branch again",
    lock: "this repository applies after merge, so pull requests take no locks",
    unlock: "this repository applies after merge, so no pull request holds a lock and there is nothing to unlock",
    agent: "the agent command is off in this repository; `agent.comment` in terragucci.yml turns it on",
    action: "this pipeline has no action workflow; run `terragucci init` again to write it",
    fork: "a pull request from a fork is not re-planned: its code never runs with this repository's credentials",
    member: "{member} is not a root of this repository. The roots are {members}.",
  },
};
const tg = assertProductWords(tgInput);

interface World {
  permission?: string;
  pr?: Partial<PullRequestDetail>;
  runs?: WorkflowRun[];
  jobs?: Record<number, RunJob[]>;
  branch?: WorkflowRun[];
  statuses?: Record<string, Array<{ context: string; targetUrl?: string }>>;
}

const run = (id: number, sha: string, o: Partial<WorkflowRun> = {}): WorkflowRun => ({ id, event: "push", headSha: sha, status: "completed", conclusion: "failure", done: true, pullRequests: [], workflow: "terragucci-apply.yml", url: `https://github.com/acme/infra/actions/runs/${id}`, ...o });

function setup(w: World, jobs: CommentJobs, body: string, o: { forge?: "github" | "forgejo"; event?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  const posted: string[] = [];
  const reran: number[] = [];
  const dispatched: Array<[string, string]> = [];
  const reads = {
    kind: o.forge ?? "github",
    permission: async () => w.permission ?? "write",
    pullRequest: async (n: number) => ({ number: n, title: "", body: "", state: "merged", head: "feature", headSha: "c".repeat(40), base: "main", sameRepo: true, mergeCommit: MERGE, ...w.pr }) as PullRequestDetail,
    headRuns: async (sha: string) => (w.runs ?? []).filter((r) => r.headSha === sha),
    runJobs: async (id: number) => w.jobs?.[id] ?? [],
    branchRuns: async () => w.branch ?? [],
  } as unknown as ForgeReads;
  const opts: AnswerCommentOptions = {
    forge: o.forge ?? "github",
    event: {
      action: "created",
      comment: { id: 7, body, user: { login: "alice" } },
      issue: { number: 12, pull_request: {} },
      repository: { full_name: "acme/infra", default_branch: "main", permissions: { push: true } },
      sender: { login: "alice" },
      ...o.event,
    },
    repo: "acme/infra",
    reads,
    poster: {
      addComment: async (_n: number, text: string) => {
        posted.push(text);
        return { id: 1 } as never;
      },
      commitStatuses: async (sha: string) => (w.statuses?.[sha] ?? []) as never,
    },
    runs: { rerunFailed: async (id) => (reran.push(id), {}), dispatch: async (wf, ref) => (dispatched.push([wf, ref]), {}) },
    words: tg,
    base: "main",
    jobs,
    ...(o.env ? { env: o.env } : {}),
  };
  return { opts, posted, reran, dispatched };
}

describe("the comment job replies to what no other job takes (#4946)", () => {
  test("a comment the grammar refuses gets the grammar's reason", async () => {
    const s = setup({}, { preview: true }, "/terragucci frob");
    const got = await answerProductComment(s.opts);
    expect(got.replied).toBe(true);
    expect(s.posted).toEqual([expect.stringMatching(/^terragucci: the commands are `\/terragucci plan`/)]);
  });

  test("a command another job answers is left to it, and a commit word to the commit job", async () => {
    for (const body of ["/terragucci plan", "/terragucci plan envs/dev", "/terragucci lock", "/terragucci fmt", "/terragucci fmt x y"]) {
      const s = setup({}, { preview: true, locks: true, commits: true }, body);
      const got = await answerProductComment(s.opts);
      expect(got.replied, body).toBe(false);
      expect(s.posted, body).toEqual([]);
    }
  });

  test("a command the pipeline runs no job for gets the product's sentence", async () => {
    const cases: Array<[string, string]> = [
      ["/terragucci apply", tgInput.replies!.apply!],
      ["/terragucci lock", tgInput.replies!.lock!],
      ["/terragucci unlock", tgInput.replies!.unlock!],
      ["/terragucci agent fix the tags", tgInput.replies!.agent!],
      ["/terragucci action envs/dev action.aws_lambda_invoke.rotate", tgInput.replies!.action!],
    ];
    for (const [body, text] of cases) {
      const s = setup({}, { preview: true }, body);
      await answerProductComment(s.opts);
      expect(s.posted, body).toEqual([`terragucci: ${text}`]);
    }
  });

  test("chant's own sentences, in a repository's words, when the product gives none", async () => {
    const s = setup({}, {}, "/plywood up");
    s.opts.words = resolveProductWords({ product: "plywood", commands: { preview: "plan", up: "apply" }, verbs: { plan: ["preview", "previewed"], apply: ["update", "updated"] } });
    await answerProductComment(s.opts);
    expect(s.posted).toEqual(["plywood: this repository does not update on a comment: re-run the update job on the forge, or push to the default branch again"]);
    const p = setup({}, {}, "/plywood preview");
    p.opts.words = s.opts.words;
    await answerProductComment(p.opts);
    expect(p.posted).toEqual(["plywood: this repository previews a pull request on each push to it, and no job previews on a comment"]);
  });

  test("an alias's flag the product has no counterpart for is refused with the product's reason, only where the alias is on", async () => {
    const on = { TG_ATLANTIS_COMMENTS: "1" };
    const p = setup({}, { preview: true }, "atlantis plan -p orders", { env: on });
    await answerProductComment(p.opts);
    expect(p.posted).toEqual(["terragucci: a root goes by its path, not a project name: write `atlantis plan -d <dir>`"]);
    const a = setup({}, { preview: true }, "atlantis apply -d envs/dev", { env: on });
    await answerProductComment(a.opts);
    expect(a.posted).toEqual(["terragucci: `atlantis apply -d` applies one root, and terragucci does not"]);
    const off = setup({}, { preview: true }, "atlantis plan -p orders");
    expect((await answerProductComment(off.opts)).replied).toBe(false);
    // The alias's -d still names the root where it is not refused.
    const d = setup({}, { preview: true }, "atlantis plan -d envs/dev", { env: on });
    expect((await answerProductComment(d.opts)).reason).toBe("another job answers this comment");
  });

  test("someone without write access gets no reply, on GitHub from the forge and on Forgejo from the event", async () => {
    const gh = setup({ permission: "read" }, {}, "/terragucci frob");
    expect((await answerProductComment(gh.opts)).replied).toBe(false);
    expect(gh.posted).toEqual([]);
    const fj = setup({}, {}, "/terragucci frob", { forge: "forgejo", event: { repository: { full_name: "acme/infra", permissions: { push: false, admin: false } } } });
    expect((await answerProductComment(fj.opts)).replied).toBe(false);
    const other = setup({}, {}, "/terragucci frob", { forge: "forgejo", event: { sender: { login: "mallory" } } });
    expect((await answerProductComment(other.opts)).replied).toBe(false);
    const fine = setup({}, {}, "/terragucci frob", { forge: "forgejo" });
    expect((await answerProductComment(fine.opts)).replied).toBe(true);
  });

  test("a plan the product plan's re-plan skips without a word gets the reason: a target that is none of its own, a fork's with forks: skip", async () => {
    const jobs: CommentJobs = { preview: true, targets: ["staging", "prod"], skipForks: true };
    const qa = setup({}, jobs, "/terragucci plan qa");
    await answerProductComment(qa.opts);
    expect(qa.posted).toEqual(["terragucci: qa is not a root of this repository. The roots are `prod`, `staging`."]);
    const fork = setup({ pr: { state: "open", sameRepo: false } }, jobs, "/terragucci plan");
    await answerProductComment(fork.opts);
    expect(fork.posted).toEqual([`terragucci: ${tgInput.replies!.fork}`]);
    const fine = setup({ pr: { state: "open" } }, jobs, "/terragucci plan prod");
    expect((await answerProductComment(fine.opts)).replied).toBe(false);
  });

  test("a comment not addressed to the product, or not on a pull request, gets nothing", async () => {
    expect((await answerProductComment(setup({}, {}, "looks good").opts)).replied).toBe(false);
    expect((await answerProductComment(setup({}, {}, "/terragucci frob", { event: { issue: { number: 12 } } }).opts)).replied).toBe(false);
  });
});

describe("a merged pull request's apply runs again (#4946)", () => {
  const waves = { 10: [{ id: 1, name: "wave-1-network", status: "completed", conclusion: "success", done: true }, { id: 2, name: "wave-2-apps", status: "completed", conclusion: "failure", done: true }] } as Record<number, RunJob[]>;

  test("on GitHub the failed jobs of the push run at the merge commit run again", async () => {
    const s = setup({ runs: [run(10, MERGE)], jobs: waves, branch: [run(10, MERGE)] }, { applyOnMerge: true }, "/terragucci apply");
    const got = await answerProductComment(s.opts);
    expect(s.reran).toEqual([10]);
    expect(got.ran).toBe(true);
    expect(s.posted[0]).toBe("terragucci: started the failed jobs of workflow run 10 (https://github.com/acme/infra/actions/runs/10) at pull request 12's merge commit aaaaaaaa again for alice; each wave's gate decides again, and the waves after it follow, each behind its own gate");
  });

  test("a later apply on the default branch refuses it, and names that run", async () => {
    const s = setup({ runs: [run(10, MERGE)], jobs: waves, branch: [run(11, LATER), run(10, MERGE)], statuses: { [LATER]: [{ context: "terragucci/apply", targetUrl: "https://github.com/acme/infra/actions/runs/11" }] } }, { applyOnMerge: true }, "/terragucci apply");
    await answerProductComment(s.opts);
    expect(s.reran).toEqual([]);
    expect(s.posted[0]).toBe("terragucci: a later apply already ran on main at bbbbbbbb (https://github.com/acme/infra/actions/runs/11), so the merge commit aaaaaaaa of pull request 12 is not applied: comment on the pull request that commit came from, or push again");
  });

  test("an open, closed, forked or wave-n apply is refused by name, and a run that succeeded is left alone", async () => {
    const replies = async (w: World, body = "/terragucci apply"): Promise<string> => {
      const s = setup({ runs: [run(10, MERGE)], jobs: waves, ...w }, { applyOnMerge: true }, body);
      await answerProductComment(s.opts);
      expect(s.reran).toEqual([]);
      return s.posted[0]!;
    };
    expect(await replies({ pr: { state: "open" } })).toMatch(/^terragucci: pull request 12 is not merged: `\/terragucci apply` runs the apply of a merged pull request again/);
    expect(await replies({ pr: { state: "closed" } })).toBe("terragucci: pull request 12 was closed without merging, so there is nothing of it to apply");
    expect(await replies({ pr: { sameRepo: false } })).toBe(`terragucci: ${tgInput.replies!.fork}`);
    expect(await replies({}, "/terragucci apply wave-2")).toMatch(/cannot stop them; write `\/terragucci apply`/);
    expect(await replies({ pr: { base: "release" } })).toBe("terragucci: pull request 12 was merged into release, not the default branch main, so nothing applied from it");
    expect(await replies({ jobs: { 10: [{ id: 1, name: "wave-1-network", status: "completed", conclusion: "success", done: true }] } })).toBe("terragucci: every apply job of pull request 12's merge commit aaaaaaaa already succeeded");
    expect(await replies({ runs: [run(10, MERGE, { done: false, status: "in_progress" })] })).toBe("terragucci: workflow run 10 at aaaaaaaa is in_progress already, so it is not started again");
    expect(await replies({ runs: [] })).toBe("terragucci: no workflow run at the merge commit aaaaaaaa of pull request 12 has an apply job, so there is nothing to run again; push to main again");
  });

  test("on Forgejo the waves workflow is dispatched on the default branch, only while the merge commit is its newest push", async () => {
    const head = setup({ runs: [run(10, MERGE)], jobs: waves, branch: [run(10, MERGE)] }, { applyOnMerge: true }, "/terragucci apply", { forge: "forgejo" });
    await answerProductComment(head.opts);
    expect(head.dispatched).toEqual([["terragucci-apply.yml", "main"]]);
    const moved = setup({ runs: [run(10, MERGE)], jobs: waves, branch: [run(11, LATER), run(10, MERGE)] }, { applyOnMerge: true }, "/terragucci apply", { forge: "forgejo" });
    await answerProductComment(moved.opts);
    expect(moved.dispatched).toEqual([]);
    expect(moved.posted[0]).toBe("terragucci: Forgejo starts a workflow again only at the head of main, which is now bbbbbbbb, so the merge commit aaaaaaaa of pull request 12 is not applied again: push to main again");
  });

  test("the apply before merge answers an open pull request's apply comment", async () => {
    const s = setup({ pr: { state: "open" } }, { applyBeforeMerge: true }, "/terragucci apply");
    expect((await answerProductComment(s.opts)).replied).toBe(false);
  });

  test("the apply jobs a re-run looks for are op waves' and the pull request loop's", () => {
    for (const name of ["wave-1-network", "wave-2-apps-share-1", "wave-3-db-decide", "apply", "apply-wave-2", "orders-apply-wave-1-share-2"]) expect(RERUN_APPLY_JOBS.test(name), name).toBe(true);
    for (const name of ["plan", "plan-note", "comment", "wave-x"]) expect(RERUN_APPLY_JOBS.test(name), name).toBe(false);
  });

  test("the writes call GitHub's re-run and Forgejo's dispatch", async () => {
    const calls: Array<[string, string]> = [];
    const runs = commentRuns({ apiBase: "https://api.github.com/", repo: "acme/infra", token: "t", fetch: (async (url: string, init: { body: string }) => (calls.push([url, init.body]), { ok: true, status: 204, text: async () => "" })) as never });
    await runs.rerunFailed(10);
    await runs.dispatch("terragucci-apply.yml", "main");
    expect(calls).toEqual([
      ["https://api.github.com/repos/acme/infra/actions/runs/10/rerun-failed-jobs", "{}"],
      ["https://api.github.com/repos/acme/infra/actions/workflows/terragucci-apply.yml/dispatches", '{"ref":"main"}'],
    ]);
  });
});

describe("the GitLab note poll takes the same replies (#4946)", () => {
  const mr = (o: Partial<PullRequestDetail> = {}): PullRequestDetail => ({ number: 3, title: "", body: "", state: "open", head: "feature", base: "main", sameRepo: true, ...o });
  const ask = (body: string, m = mr()): Omit<NoteCommand, "parsed"> => ({ mr: m, note: { id: 41, body, system: false }, role: "developer", base: "main", words: tg });

  test("a root outside the pipeline's is refused before anything starts, and a fork gets the product's sentence", async () => {
    const runs = chantNoteRuns({ preview: true, members: ["envs/dev", "envs/prod"] });
    expect(await runs({ ...ask("/terragucci plan envs/qa"), parsed: { kind: "plan", member: "envs/qa" } })).toEqual({ kind: "reply", text: "envs/qa is not a root of this repository. The roots are `envs/dev`, `envs/prod`." });
    expect((await runs({ ...ask("/terragucci plan envs/dev"), parsed: { kind: "plan", member: "envs/dev" } })).kind).toBe("pipeline");
    expect(await runs({ ...ask("/terragucci plan", mr({ sameRepo: false })), parsed: { kind: "plan" } })).toEqual({ kind: "reply", text: tgInput.replies!.fork });
  });

  test("a command with no job gets the product's sentence, and chant's GitLab sentences stay without one", async () => {
    const runs = chantNoteRuns({});
    expect(await runs({ ...ask("/terragucci lock"), parsed: { kind: "lock" } })).toEqual({ kind: "reply", text: tgInput.replies!.lock });
    expect(await runs({ ...ask("/terragucci apply"), parsed: { kind: "apply" } })).toEqual({ kind: "reply", text: tgInput.replies!.apply });
    const plain = resolveProductWords({ product: "plywood", commands: { preview: "plan", up: "apply", lock: "lock" } });
    expect(await runs({ ...ask("/plywood lock"), words: plain, parsed: { kind: "lock" } })).toEqual({ kind: "reply", text: "`/plywood lock` does not run here: this project takes no locks" });
  });
});

describe("the words' replies and alias refusals are checked (#4946)", () => {
  test("a reply is one line, names only its own placeholders, and fills a known slot", () => {
    const problems = productWordsProblems(resolveProductWords({ ...tgInput, replies: { apply: "two\nlines", lock: "no {member} here", member: "{member} of {roots}", nope: "x" } as never }));
    expect(problems).toEqual(expect.arrayContaining([
      "replies.apply is one line of text",
      "replies.lock names {member}, which chant does not fill",
      "replies.member names {roots}, which chant does not fill",
      expect.stringMatching(/^replies\.nope is not one of plan, apply/),
    ]));
    expect(productWordsProblems(tg)).toEqual([]);
  });

  test("a refused flag is a flag, with a one-line reply", () => {
    const problems = productWordsProblems(resolveProductWords({ ...tgInput, aliases: [{ from: "atlantis plan", command: "plan", refuse: { "p": "x", "-w": "" } }] }));
    expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(/refuses "p", and a flag is/), "the alias \"atlantis plan\" refuses -w with no one-line reply"]));
  });

  test("the comment job reads its jobs from CHANT_COMMENT_JOBS and refuses anything else", () => {
    expect(commentJobsFromEnv('{"preview":true,"locks":false}')).toEqual({ preview: true });
    expect(commentJobsFromEnv('{"targets":["staging","prod"],"skipForks":true}')).toEqual({ targets: ["staging", "prod"], skipForks: true });
    expect(() => commentJobsFromEnv('{"targets":["a b"]}')).toThrow(/list of target names/);
    expect(commentJobsFromEnv(undefined)).toEqual({});
    expect(() => commentJobsFromEnv('{"everything":true}')).toThrow(/not one of/);
    expect(() => commentJobsFromEnv('{"locks":"yes"}')).toThrow(/true or false/);
  });
});

describe("a wave stop on a re-run, and a re-plan comment with flags (#4979)", () => {
  const waves = { 10: [{ id: 1, name: "wave-1-network", status: "completed", conclusion: "failure", done: true }, { id: 2, name: "wave-2-apps", status: "completed", conclusion: "skipped", done: true }, { id: 3, name: "wave-3-edge", status: "completed", conclusion: "skipped", done: true }] } as Record<number, RunJob[]>;
  const jobs: CommentJobs = { applyOnMerge: true, waves: { op: "tf-apply", count: 3 } };
  const withStops = (s: ReturnType<typeof setup>) => {
    const stops: Array<[string, string, unknown]> = [];
    s.opts.stops = async (op, sha, stop) => {
      stops.push([op, sha, stop]);
    };
    s.opts.now = () => "2026-11-10T00:00:00.000Z";
    return stops;
  };

  test("wave-n writes the stop for the merge commit before the run starts, and the reply says the waves after it wait", async () => {
    const s = setup({ runs: [run(10, MERGE)], jobs: waves, branch: [run(10, MERGE)] }, jobs, "/terragucci apply wave-2");
    const stops = withStops(s);
    const got = await answerProductComment(s.opts);
    expect(stops).toEqual([["tf-apply", MERGE, { through: 2, at: "2026-11-10T00:00:00.000Z", by: "alice", pr: 12 }]]);
    expect(s.reran).toEqual([10]);
    expect(got.ran).toBe(true);
    expect(s.posted[0]).toMatch(/again for alice; .*; it stops after `wave-2`, and the waves after it wait until `\/terragucci apply` runs it again$/);
  });

  test("an apply without a wave clears the stop, and the last wave stops nothing after it", async () => {
    const plain = setup({ runs: [run(10, MERGE)], jobs: waves, branch: [run(10, MERGE)] }, jobs, "/terragucci apply");
    const cleared = withStops(plain);
    await answerProductComment(plain.opts);
    expect(cleared).toEqual([["tf-apply", MERGE, null]]);
    expect(plain.posted[0]).not.toMatch(/stops after/);
    const last = setup({ runs: [run(10, MERGE)], jobs: waves, branch: [run(10, MERGE)] }, jobs, "/terragucci apply wave-3");
    withStops(last);
    await answerProductComment(last.opts);
    expect(last.posted[0]).not.toMatch(/stops after/);
  });

  test("a wave the waves do not have is refused, and no run starts or stop is written", async () => {
    const s = setup({ runs: [run(10, MERGE)], jobs: waves, branch: [run(10, MERGE)] }, jobs, "/terragucci apply wave-4");
    const stops = withStops(s);
    await answerProductComment(s.opts);
    expect(s.posted[0]).toBe("terragucci: the apply of this repository runs in 3 waves, so there is no `wave-4`");
    expect(stops).toEqual([]);
    expect(s.reran).toEqual([]);
  });

  test("a stop that cannot be written fails the job, and nothing is started", async () => {
    const s = setup({ runs: [run(10, MERGE)], jobs: waves, branch: [run(10, MERGE)] }, jobs, "/terragucci apply wave-1");
    s.opts.stops = async () => {
      throw new Error("push refused");
    };
    const got = await answerProductComment(s.opts);
    expect(got.fail).toBe(true);
    expect(got.reason).toMatch(/could not write the wave stop for aaaaaaaa, so nothing was started \(push refused\)/);
    expect(s.reran).toEqual([]);
  });

  test("on Forgejo the dispatch carries the stop the same way", async () => {
    const s = setup({ runs: [run(10, MERGE)], jobs: waves, branch: [run(10, MERGE)] }, jobs, "/terragucci apply wave-1", { forge: "forgejo" });
    const stops = withStops(s);
    await answerProductComment(s.opts);
    expect(stops).toHaveLength(1);
    expect(s.dispatched).toEqual([["terragucci-apply.yml", "main"]]);
  });

  test("without the waves' op a wave-n is still refused, as before", async () => {
    const s = setup({ runs: [run(10, MERGE)], jobs: waves }, { applyOnMerge: true }, "/terragucci apply wave-2");
    withStops(s);
    await answerProductComment(s.opts);
    expect(s.posted[0]).toMatch(/cannot stop them/);
  });

  test("the product plan's re-plan takes no flags, so a plan comment with them gets the reason", async () => {
    for (const body of ["/terragucci plan --target aws_s3_bucket.logs", "/terragucci plan --refresh"]) {
      const s = setup({}, { preview: true, noPlanFlags: true }, body);
      const got = await answerProductComment(s.opts);
      expect(got.replied, body).toBe(true);
      expect(s.posted[0], body).toBe("terragucci: `/terragucci plan` plans whole roots again, every one or the one named after it, so it takes no `--target`, `--refresh` or `--target-dependents`; write `/terragucci plan` or `/terragucci plan <root>`");
    }
    // A plain re-plan is the re-plan's, and a comment preview takes the flags.
    expect((await answerProductComment(setup({}, { preview: true, noPlanFlags: true }, "/terragucci plan envs/dev").opts)).replied).toBe(false);
    expect((await answerProductComment(setup({}, { preview: true }, "/terragucci plan --target aws_s3_bucket.logs").opts)).replied).toBe(false);
  });

  test("CHANT_COMMENT_JOBS carries the waves and noPlanFlags", () => {
    expect(commentJobsFromEnv('{"waves":{"op":"tf-apply","count":2},"noPlanFlags":true}')).toEqual({ waves: { op: "tf-apply", count: 2 }, noPlanFlags: true });
    expect(() => commentJobsFromEnv('{"waves":{"op":"a b","count":2}}')).toThrow(/waves is \{ op, count \}/);
    expect(() => commentJobsFromEnv('{"waves":{"op":"tf-apply","count":0}}')).toThrow(/waves is \{ op, count \}/);
  });
});
