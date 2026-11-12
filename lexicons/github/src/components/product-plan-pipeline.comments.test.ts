/**
 * The product plan workflow's comment job and lock jobs (#4946): the job
 * that answers every `/<product>` comment no other job takes, and the plan's
 * locks with the lock and unlock comments.
 */
import { describe, expect, test } from "vitest";
import { generateProductPlanPipeline } from "./product-plan-pipeline";
import { generateForgejoProductPlanPipeline } from "../../../forgejo/src/components/product-plan-pipeline";
import { generateGitlabProductPlanPipeline } from "../../../gitlab/src/components/product-plan-pipeline";

const words = {
  product: "terragucci",
  noun: ["root", "roots"] as [string, string],
  commands: { plan: "plan" as const, apply: "apply" as const, lock: "lock" as const, unlock: "unlock" as const },
  aliases: [{ from: "atlantis plan", command: "plan" as const, when: "TG_ATLANTIS_COMMENTS" }],
  approval: "per-wave" as const,
  op: "tf-apply",
  bin: "npx --no-install terragucci",
};

const wavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  planWave: ["terragucci", "plan-wave", "--runs", "{runs}", "--plans", "{plans}"],
  applyWave: ["terragucci", "apply-wave", "--runs", "{runs}", "--plans", "{plans}"],
  waves: [{ name: "network", runs: [{ target: "envs/dev/network" }] }],
};

const base = {
  words,
  beforeScript: ["npm ci"],
  productPlan: { command: "terragucci plan --pr-report {output}", workflow: "terragucci-pr", replan: true },
};

type Job = { if: string; needs?: string[]; permissions: Record<string, string>; steps: Array<{ name?: string; env?: Record<string, string>; run?: string; uses?: string; with?: Record<string, unknown> }> };

describe("the comment job (#4946)", () => {
  test("starts on the product's comments and its aliases, at the target branch's commit, and names the jobs it leaves comments to", () => {
    const { doc, jobs } = generateProductPlanPipeline("default", { ...base, commentJob: true, waves: wavesSpec });
    const c = doc.jobsDoc.comment as Job;
    expect(c.if).toBe("github.event_name == 'issue_comment' && github.event.issue.pull_request && (startsWith(github.event.comment.body, '/terragucci') || startsWith(github.event.comment.body, 'atlantis plan')) && contains(fromJSON('[\"OWNER\",\"MEMBER\",\"COLLABORATOR\"]'), github.event.comment.author_association)");
    expect(c.steps[0]).toEqual({ name: "Check out the target branch's commit", uses: expect.stringMatching(/^actions\/checkout@/) });
    expect(c.steps[1]!.run).toBe("npm ci");
    const answer = c.steps[2]!;
    expect(answer.run).toBe("npx --no-install terragucci components pr-comment --forge github");
    // #4979: the waves' op and count, for a wave stop on a re-run, and the re-plan's want of flags.
    expect(JSON.parse(answer.env!.CHANT_COMMENT_JOBS!)).toEqual({ preview: true, applyOnMerge: true, waves: { op: "tf-apply", count: 1 }, noPlanFlags: true });
    expect(answer.env!.GITHUB_TOKEN).toBe("${{ github.token }}");
    // With waves on merge it may start their run again, after it wrote the wave stop on chant/lifecycle (#4979).
    expect(c.permissions).toEqual({ actions: "write", contents: "write", "pull-requests": "write", statuses: "read" });
    expect(doc.on).toMatchObject({ issue_comment: { types: ["created"] } });
    expect(jobs.comment!.prefixes).toEqual(["/terragucci", "atlantis plan"]);
  });

  test("without waves it asks for no actions write, and a comment job alone puts the comment trigger on", () => {
    const { doc } = generateProductPlanPipeline("default", { ...base, productPlan: { ...base.productPlan, replan: false }, commentJob: true });
    expect((doc.jobsDoc.comment as Job).permissions.actions).toBe("read");
    expect(doc.on).toMatchObject({ issue_comment: { types: ["created"] } });
    expect(JSON.parse((doc.jobsDoc.comment as Job).steps[2]!.env!.CHANT_COMMENT_JOBS!)).toEqual({});
  });

  test("on Forgejo it reads the pull request flag Forgejo sets, and leaves the commenter to the command", () => {
    const { doc } = generateForgejoProductPlanPipeline("default", { ...base, commentJob: true });
    const c = doc.jobsDoc.comment as Job;
    expect(c.if).toContain("(github.event.issue.pull_request || github.event.is_pull)");
    expect(c.if).not.toContain("author_association");
    expect(c.steps[2]!.run).toBe("npx --no-install terragucci components pr-comment --forge forgejo");
  });

  test("tells the job the re-plan's targets and fork rule, and is refused beside the re-plan's own reply", () => {
    const { doc } = generateProductPlanPipeline("default", { ...base, productPlan: { ...base.productPlan, forks: "skip" as const, targets: [{ name: "staging" }, { name: "prod" }] }, commentJob: true });
    expect(JSON.parse((doc.jobsDoc.comment as Job).steps[2]!.env!.CHANT_COMMENT_JOBS!)).toEqual({ preview: true, targets: ["staging", "prod"], skipForks: true, noPlanFlags: true });
    expect(() => generateProductPlanPipeline("default", { ...base, productPlan: { ...base.productPlan, replan: { reply: true } }, commentJob: true })).toThrow(/drop replan\.reply/);
  });

  test("is refused on GitLab, where the note-commands job answers every note", () => {
    expect(() => generateGitlabProductPlanPipeline("default", { ...base, commentJob: true })).toThrow(/note-commands job/);
  });

  test("leaves the workflow as it was without commentJob, where words naming a command with no job are still refused", () => {
    const { doc } = generateProductPlanPipeline("default", { ...base, words: { ...words, commands: { plan: "plan" as const } } });
    expect(doc.jobsDoc.comment).toBeUndefined();
    expect(Object.keys(doc.jobsDoc)).toEqual(["plan", "plan-note", "replan", "replan-note"]);
    expect(() => generateProductPlanPipeline("default", base)).toThrow(/commands\.apply needs a apply job/);
  });
});

describe("the comment job under the product's name (#5027)", () => {
  test("renders as apply-comment, the same job, and the workflow keeps every other job", () => {
    const named = generateProductPlanPipeline("default", { ...base, commentJob: { jobName: "apply-comment" }, waves: wavesSpec });
    const chant = generateProductPlanPipeline("default", { ...base, commentJob: true, waves: wavesSpec });
    expect(named.doc.jobsDoc.comment).toBeUndefined();
    expect(named.doc.jobsDoc["apply-comment"]).toEqual(chant.doc.jobsDoc.comment);
    expect(Object.keys(named.doc.jobsDoc)).toEqual(Object.keys(chant.doc.jobsDoc).map((k) => (k === "comment" ? "apply-comment" : k)));
    const forgejo = generateForgejoProductPlanPipeline("default", { ...base, commentJob: { jobName: "apply-comment" } });
    expect((forgejo.doc.jobsDoc["apply-comment"] as Job).steps[2]!.run).toBe("npx --no-install terragucci components pr-comment --forge forgejo");
  });

  test("a name another job of the workflow has is refused", () => {
    for (const jobName of ["plan", "replan-note"]) expect(() => generateProductPlanPipeline("default", { ...base, commentJob: { jobName } }), jobName).toThrow(/is the name of another job of the workflow/);
    for (const jobName of ["lock", "unlock", "comment-lock"]) expect(() => generateProductPlanPipeline("default", { ...base, locks: "plan", commentJob: { jobName } }), jobName).toThrow(/is the name of another job of the workflow/);
  });
});

describe("the product plan's locks (#4946)", () => {
  const { doc } = generateProductPlanPipeline("default", { ...base, locks: "plan", commentJob: true });
  const job = (name: string) => doc.jobsDoc[name] as Job;

  test("the pull request trigger fires on close, and the plan skips a close", () => {
    expect(doc.on).toMatchObject({ pull_request: { branches: ["main"], types: ["opened", "synchronize", "reopened", "closed"] } });
    expect(job("plan").if).toBe("github.event_name == 'pull_request' && github.event.action != 'closed'");
  });

  test("a lock job after the plan takes what its report selected, at the target branch's commit", () => {
    const lock = job("lock");
    expect(lock.needs).toEqual(["plan"]);
    expect(lock.steps[0]!.with).toEqual({ ref: "${{ github.event.pull_request.base.sha }}", "fetch-depth": 0 });
    const take = lock.steps[lock.steps.length - 1]!;
    expect(take.run).toBe('if [ -f .chant/pr/pr-plan.json ]; then npx --no-install terragucci lock --from-report .chant/pr/pr-plan.json --pr "$PR_NUMBER" --head "$HEAD_SHA" --stage plan --forge github; else echo "The plan wrote no .chant/pr/pr-plan.json, so it selected nothing to lock."; fi');
    expect(lock.permissions).toEqual({ contents: "write", "pull-requests": "read", statuses: "write" });
  });

  test("the unlock job releases the locks on close, and the comment jobs answer lock and unlock", () => {
    expect(job("unlock").if).toBe("github.event_name == 'pull_request' && github.event.action == 'closed'");
    expect(job("unlock").steps[2]!.run).toBe('npx --no-install terragucci unlock --pr "$PR_NUMBER"');
    expect(job("comment-lock").if).toContain("startsWith(github.event.comment.body, '/terragucci lock')");
    expect(job("comment-lock").steps[2]!.run).toBe('npx --no-install terragucci lock --keep --pr "$PR_NUMBER" --forge github');
    expect(job("comment-unlock").steps[2]!.run).toBe('npx --no-install terragucci unlock --pr "$PR_NUMBER"');
    // The comment job leaves lock and unlock to them.
    expect(JSON.parse(job("comment").steps[2]!.env!.CHANT_COMMENT_JOBS!)).toEqual({ preview: true, locks: true, noPlanFlags: true });
  });
});
