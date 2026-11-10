/**
 * The product plan workflow on GitHub Actions (#4799): a plan job and a
 * plan-note job per target, from the product pipeline's options with no
 * component graph.
 */
import { describe, expect, test } from "vitest";
import { generateProductPlanPipeline } from "./product-plan-pipeline";

const words = {
  product: "yodel",
  noun: ["environment", "environments"] as [string, string],
  commands: {},
  approve: "yodel approve {target} --plan {digest} {sign}",
  op: "yodel-apply",
  gateName: "yodel-apply-wave-{k}",
  approval: "per-wave" as const,
  bin: "yodel chant",
};

const options = {
  words,
  image: "ghcr.io/intentius/sql-yodeler@sha256:" + "a".repeat(64),
  beforeScript: ["yodel ci --fetch-ledger"],
  productPlan: {
    command: "yodel plan {target} --pr-note {output}",
    workflow: "yodel-pr",
    forks: "skip" as const,
    artifact: "yodel-report",
    targets: [
      { name: "staging", secrets: { STAGING_PG_READER_URL: "STAGING_PG_READER_URL" }, writeProbe: "yodel config check staging --write-probe" },
      { name: "prod", secrets: { PROD_PG_READER_URL: "PROD_PG_READER_URL" }, writeProbe: "yodel config check prod staging --write-probe" },
    ],
  },
};

type Job = { if: string; needs?: string[]; permissions: Record<string, string>; steps: Array<{ name?: string; id?: string; env?: Record<string, string>; run?: string; uses?: string; with?: Record<string, unknown> }> };

describe("the product plan workflow on GitHub (#4799)", () => {
  const { yaml, doc, jobs } = generateProductPlanPipeline("default", options);
  const job = (name: string) => doc.jobsDoc[name] as Job;

  test("writes a plan job and a note job per target, on pull requests into main, under the product's name", () => {
    expect(Object.keys(doc.jobsDoc)).toEqual(["plan-staging", "plan-note-staging", "plan-prod", "plan-note-prod"]);
    expect(doc.name).toBe("yodel-pr");
    expect(doc.on).toEqual({ pull_request: { branches: ["main"] } });
    expect(yaml.startsWith("name: yodel-pr\n")).toBe(true);
    expect(jobs.productPlan).toHaveLength(2);
  });

  test("each plan job holds only its target's secret, on its probe and its plan step, and no forge token", () => {
    const staging = job("plan-staging");
    const probe = staging.steps.find((s) => s.name === "This job cannot write")!;
    const plan = staging.steps.find((s) => s.id === "plan")!;
    expect(probe.run).toContain("yodel config check staging --write-probe");
    expect(plan.env).toEqual({ BASE_SHA: "${{ github.event.pull_request.base.sha }}", PR_NUMBER: "${{ github.event.pull_request.number }}", STAGING_PG_READER_URL: "${{ secrets.STAGING_PG_READER_URL }}" });
    expect(probe.env).toEqual(plan.env);
    expect(plan.run).toContain("yodel plan staging --pr-note .chant/pr");
    expect(JSON.stringify(staging)).not.toContain("PROD_PG_READER_URL");
    expect(staging.permissions).toEqual({ contents: "read" });
    // The plan step is the job's last, and every step after the checkout starts without the forge tokens.
    expect(staging.steps[staging.steps.length - 1]).toBe(plan);
    const drop = staging.steps[1]!.run!.split("\n")[0]!;
    expect(drop).toContain("CHANT_NO_FORGE_TOKEN");
    for (const s of staging.steps.slice(1)) expect(s.run!.startsWith(drop)).toBe(true);
  });

  test("the note job checks out the target branch's commit and posts the target's note through the product's bin", () => {
    const note = job("plan-note-prod");
    expect(note.needs).toEqual(["plan-prod"]);
    expect(note.permissions).toMatchObject({ "pull-requests": "write", statuses: "write" });
    expect(note.steps[0]!.with).toEqual({ ref: "${{ github.event.pull_request.base.sha }}" });
    const keep = note.steps.find((s) => s.name === "Keep the plan report")!;
    expect(keep.with!.name).toBe("yodel-report-prod");
    const post = note.steps[note.steps.length - 1]!;
    expect(post.name).toBe("Post the plan note and yodel/plan/prod");
    expect(post.run).toBe('yodel chant components pr-post --pr "$PR_NUMBER" --head "$HEAD_SHA" --env default --output .chant/pr --forge github --member prod --result "$PLAN_RESULT"');
    expect(post.env!.PLAN_RESULT).toBe("${{ needs.plan-prod.result }}");
  });

  test("with forks: skip, neither job runs for a fork's pull request", () => {
    expect(job("plan-staging").if).toBe("github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository");
    expect(job("plan-note-staging").if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    const open = generateProductPlanPipeline("default", { ...options, productPlan: { ...options.productPlan, forks: undefined } });
    expect((open.doc.jobsDoc["plan-staging"] as Job).if).toBe("github.event_name == 'pull_request'");
  });

  test("without targets, one plan and one plan-note job, as the pull request loop names them", () => {
    const one = generateProductPlanPipeline("default", { words: { ...words, product: "terragucci", bin: "terragucci chant" }, productPlan: { command: "terragucci plan --pr-note {output}" } });
    expect(Object.keys(one.doc.jobsDoc)).toEqual(["plan", "plan-note"]);
    expect(one.doc.name).toBe("chant-pr-default");
    // chant's default image gets the engine setup lines.
    expect(one.yaml).toContain("container: node:22");
  });
});

describe("the product plan's steps beside the plan verb on GitHub (#4899, #4931)", () => {
  const login = { aws: { role: "arn:aws:iam::123456789012:role/yodel-reader" } };
  const full = {
    ...options,
    words: { ...words, commands: { plan: "plan" as const } },
    productPlan: {
      ...options.productPlan,
      env: { YODEL_LOG: "info" },
      pending: true,
      setup: [{ name: "Restore the cache", uses: "actions/cache/restore@v4", with: { path: "~/.cache/yodel", key: "yodel" } }, { name: "Warm up", run: "yodel warm" }],
      report: "yodel report {target} --out {output}/report",
      concurrency: { group: "yodel-pr", cancelInProgress: true },
      replan: true,
      noteSteps: { before: ['yodel notices >> "$CHANT_PLAN_NOTE_NOTICES"'], after: ["yodel approval-status"] },
      targets: [{ ...options.productPlan.targets[0]!, login }, options.productPlan.targets[1]!],
    },
  };
  const { yaml, doc } = generateProductPlanPipeline("default", full);
  const job = (name: string) => doc.jobsDoc[name] as Job & { env?: Record<string, string>; outputs?: Record<string, string> };

  test("a config without the new options renders as before: no concurrency, no comment trigger, no extra step", () => {
    const plain = generateProductPlanPipeline("default", options);
    expect(plain.doc.concurrency).toBeUndefined();
    expect(plain.doc.on).toEqual({ pull_request: { branches: ["main"] } });
    expect(plain.yaml).not.toMatch(/pending|replan|id-token|Cloud login|CHANT_PLAN_NOTE_NOTICES/);
  });

  test("the pending status is the first step, before the checkout, and the one that holds the token for it", () => {
    const staging = job("plan-staging");
    expect(staging.steps[0]!.name).toBe("Say on the head that the plan started");
    expect(staging.steps[0]!.env).toMatchObject({ CHANT_PENDING_TOKEN: "${{ github.token }}", CHANT_PENDING_SHA: "${{ github.sha }}", CHANT_PENDING_CONTEXT: "yodel/plan/staging" });
    expect(staging.steps[1]!.name).toBe("Check out the change");
    expect(staging.permissions).toEqual({ contents: "read", statuses: "write", "id-token": "write" });
    expect(job("plan-prod").permissions).toEqual({ contents: "read", statuses: "write" });
    expect(staging.env).toEqual({ YODEL_LOG: "info" });
  });

  test("the setup steps come after the checkout, the login after the setup lines and before the probe, and the plan step stays last", () => {
    const names = job("plan-staging").steps.map((s) => s.name ?? s.uses ?? s.run!.split("\n").pop());
    expect(names).toEqual(["Say on the head that the plan started", "Check out the change", "Restore the cache", "Warm up", "yodel ci --fetch-ledger", "Cloud login (chant ci-login: aws)", "This job cannot write", "Plan staging"]);
    const steps = job("plan-staging").steps;
    expect(steps[2]!.uses).toBe("actions/cache/restore@v4");
    expect(steps[3]!.run!.split("\n")[0]).toContain("CHANT_NO_FORGE_TOKEN");
    expect(job("plan-prod").steps.some((s) => s.name?.startsWith("Cloud login"))).toBe(false);
  });

  test("the report line runs after the plan verb whatever its exit, and the step exits with the verb's status", () => {
    const run = job("plan-staging").steps.at(-1)!.run!.split("\n");
    expect(run.slice(-4)).toEqual([
      "chant_plan_exit=0",
      "yodel plan staging --pr-note .chant/pr || chant_plan_exit=$?",
      'yodel report staging --out .chant/pr/report || echo "chant: the report line exited $?" >&2',
      '[ "$chant_plan_exit" -eq 0 ] || exit "$chant_plan_exit"',
    ]);
  });

  test("one run per pull request; a comment's run has its own group", () => {
    expect(doc.concurrency).toEqual({ group: "yodel-pr-${{ github.event.pull_request.number || format('comment-{0}', github.event.comment.id) }}", "cancel-in-progress": true });
    const noReplan = generateProductPlanPipeline("default", { ...options, productPlan: { ...options.productPlan, concurrency: { group: "yodel-pr", cancelInProgress: true } } });
    expect(noReplan.yaml).toContain("group: yodel-pr-${{ github.event.pull_request.number }}\n  cancel-in-progress: true");
  });

  test("the note job runs the product's lines around pr-post, with the notices file named in the shell", () => {
    const note = job("plan-note-staging");
    const names = note.steps.map((s) => s.name);
    expect(names.slice(-3)).toEqual(["The product's lines before the note", "Post the plan note and yodel/plan/staging", "The product's lines after the note"]);
    const before = note.steps.at(-3)!;
    expect(before.run).toBe('export CHANT_PLAN_NOTE_NOTICES="${RUNNER_TEMP:-/tmp}/chant-plan-note-notices"\nyodel notices >> "$CHANT_PLAN_NOTE_NOTICES"');
    expect(before.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
    expect(note.steps.at(-2)!.run!.split("\n")[0]).toBe('export CHANT_PLAN_NOTE_NOTICES="${RUNNER_TEMP:-/tmp}/chant-plan-note-notices"');
  });

  test("a comment re-plans: a job per target that decides from the event file before the checkout, and a note job", () => {
    expect(doc.on).toMatchObject({ issue_comment: { types: ["created"] } });
    expect(Object.keys(doc.jobsDoc)).toEqual(["plan-staging", "plan-note-staging", "plan-prod", "plan-note-prod", "replan-staging", "replan-note-staging", "replan-prod", "replan-note-prod"]);
    const r = job("replan-staging");
    expect(r.if).toContain("startsWith(github.event.comment.body, '/yodel plan')");
    expect(r.if).toContain("github.event.comment.author_association");
    const decide = r.steps[0]!;
    expect(decide.id).toBe("decide");
    expect(decide.env).toMatchObject({ CHANT_REPLAN_TOKEN: "${{ github.token }}", CHANT_REPLAN_COMMANDS: '["/yodel plan"]', CHANT_REPLAN_TARGET: "staging", CHANT_REPLAN_TARGETS: '["staging","prod"]', CHANT_REPLAN_FORKS: "skip" });
    expect(decide.env).not.toHaveProperty("CHANT_REPLAN_PERMISSION");
    // Nothing in a script reads the comment as an expression.
    for (const s of r.steps) expect(JSON.stringify(s)).not.toContain("github.event.comment");
    for (const s of r.steps.slice(1)) expect((s as { if?: string }).if).toBe("steps.decide.outputs.go == '1'");
    const checkout = r.steps.find((s) => s.name === "Check out the pull request's head")!;
    expect(checkout.env).toMatchObject({ CHANT_REPLAN_REF: "refs/pull/${{ steps.decide.outputs.pr }}/head" });
    const plan = r.steps.at(-1)!;
    expect(plan.env).toMatchObject({ BASE_SHA: "${{ steps.decide.outputs.base }}", PR_NUMBER: "${{ steps.decide.outputs.pr }}", CHANT_PLAN_ARGUMENT: "${{ steps.decide.outputs.argument }}" });
    const note = job("replan-note-staging");
    expect(note.if).toContain("needs.replan-staging.outputs.go == '1'");
    const post = note.steps.find((s) => s.name?.startsWith("Post the plan note"))!;
    expect(post.env).toMatchObject({ PR_NUMBER: "${{ needs.replan-staging.outputs.pr }}", HEAD_SHA: "${{ needs.replan-staging.outputs.head }}", PLAN_RESULT: "${{ needs.replan-staging.result }}" });
    expect(yaml).toContain("name: yodel-report-staging-replan");
  });

  test("a words' alias for the plan command is answered behind its variable", () => {
    const tg = generateProductPlanPipeline("default", {
      words: { ...words, product: "terragucci", bin: "terragucci chant", commands: { plan: "plan" as const }, aliases: [{ from: "atlantis plan", command: "plan" as const, when: "TG_ATLANTIS_COMMENTS" }] },
      productPlan: { command: "terragucci plan --pr-note {output}", replan: true, env: { TG_ATLANTIS_COMMENTS: "1" } },
    });
    const r = tg.doc.jobsDoc["replan"] as Job;
    expect(r.if).toContain("(startsWith(github.event.comment.body, '/terragucci plan') || startsWith(github.event.comment.body, 'atlantis plan'))");
    expect(r.steps[0]!.env).toMatchObject({ CHANT_REPLAN_COMMANDS: '["/terragucci plan"]', CHANT_REPLAN_GATED: '[{"comment":"atlantis plan","when":"TG_ATLANTIS_COMMENTS"}]' });
    expect(r.steps[0]!.env).not.toHaveProperty("CHANT_REPLAN_TARGET");
  });
});

describe("the re-plan decision script (#4899)", () => {
  test("decides from the event file and the forge: open, same repository, the target the comment names", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createServer } = await import("node:http");
    const { REPLAN_DECIDE_JS } = await import("@intentius/chant/components/product-plan");
    const head = "b".repeat(40);
    const base = "c".repeat(40);
    let pull: Record<string, unknown> = { state: "open", head: { sha: head, repo: { full_name: "o/r" } }, base: { sha: base } };
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "token t") return void res.writeHead(401).end("{}");
      if (req.url === "/repos/o/r/pulls/7") return void res.end(JSON.stringify(pull));
      if (req.url === "/repos/o/r/collaborators/alice/permission") return void res.end(JSON.stringify({ permission: "read" }));
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "chant-replan-"));
    const run = async (body: string, env: Record<string, string> = {}): Promise<Record<string, string>> => {
      writeFileSync(join(dir, "event.json"), JSON.stringify({ comment: { body, user: { login: "alice" } }, issue: { number: 7, pull_request: {} } }));
      writeFileSync(join(dir, "out"), "");
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve, reject) =>
        execFile(process.execPath, ["-e", REPLAN_DECIDE_JS], {
          env: { PATH: process.env.PATH ?? "", GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_OUTPUT: join(dir, "out"), GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_REPOSITORY: "o/r", CHANT_REPLAN_TOKEN: "t", CHANT_REPLAN_COMMANDS: '["/yodel plan"]', ...env },
        }, (err) => (err ? reject(err) : resolve())),
      );
      return Object.fromEntries(readFileSync(join(dir, "out"), "utf8").split("\n").filter(Boolean).map((l) => l.split("=") as [string, string]));
    };
    try {
      const target = { CHANT_REPLAN_TARGET: "prod", CHANT_REPLAN_TARGETS: '["staging","prod"]' };
      expect(await run("/yodel plan", target)).toEqual({ go: "1", pr: "7", head, base, argument: "" });
      expect(await run("/yodel plan prod", target)).toMatchObject({ go: "1", argument: "prod" });
      expect(await run("/yodel plan staging", target)).toEqual({});
      expect(await run("/yodel plan nowhere", target)).toEqual({});
      expect(await run("/yodel plans")).toEqual({});
      expect(await run("/yodel plan a; touch x")).toEqual({});
      expect(await run("/yodel plan live/app")).toMatchObject({ go: "1", argument: "live/app" });
      // Forgejo: the commenter must be able to write.
      expect(await run("/yodel plan", { CHANT_REPLAN_PERMISSION: "1" })).toEqual({});
      pull = { ...pull, head: { sha: head, repo: { full_name: "fork/r" } } };
      expect(await run("/yodel plan", { CHANT_REPLAN_FORKS: "skip" })).toEqual({});
      expect(await run("/yodel plan")).toMatchObject({ go: "1" });
      pull = { ...pull, state: "closed" };
      expect(await run("/yodel plan")).toEqual({});
    } finally {
      server.close();
    }
  });
});

describe("what terragucci's and sql-yodeler's plan jobs need of the product plan on GitHub (#4963)", () => {
  const tgWords = { ...words, product: "terragucci", bin: "terragucci chant", commands: { plan: "plan" as const } };
  const trade = { aws: { region: "us-east-1", audience: "sts.amazonaws.com", role: "arn:aws:iam::123456789012:role/tg-plan" } };
  const tg = generateProductPlanPipeline("default", {
    words: tgWords,
    productPlan: {
      command: "terragucci plan --pr-note {output}",
      forks: "skip",
      pending: true,
      trade,
      replan: { dispatch: { argument: "root" }, reply: { others: ["/terragucci apply"] }, notAffected: true },
      concurrency: {},
      noteSteps: { before: ["terragucci plan-note-notices"], pullRequest: true },
    },
  });
  const job = (name: string) => tg.doc.jobsDoc[name] as Job & { outputs?: Record<string, string> };
  const names = (j: Job) => j.steps.map((s) => s.name ?? s.uses ?? "");

  test("the trade runs before the checkout, in the plan job and in the re-plan, and the later steps drop the token request variables", () => {
    expect(names(job("plan")).slice(0, 3)).toEqual(["Say on the head that the plan started", "Trade the job's OIDC token for the plan identities", "Check out the change"]);
    const r = names(job("replan"));
    expect(r.indexOf("Trade the job's OIDC token for the plan identities")).toBeLessThan(r.indexOf("Check out the pull request's head"));
    const traded = job("plan").steps[1]!;
    expect(traded.env).toEqual({ CHANT_CLOUD_TRADE: JSON.stringify(trade) });
    expect(traded.run).toContain('"$GITHUB_ENV" github-env');
    expect(job("plan").permissions).toMatchObject({ "id-token": "write" });
    expect(job("plan").steps.at(-1)!.run!.split("\n")[0]).toContain("-u ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  });

  test("a dispatch with a pr input re-plans, with the argument from the input the re-plan names", () => {
    expect(tg.doc.on).toMatchObject({ workflow_dispatch: { inputs: { pr: { type: "string", required: false }, root: { type: "string", required: false } } } });
    expect(job("replan").if).toMatch(/\|\| \(github\.event_name == 'workflow_dispatch' && github\.event\.inputs\.pr != ''\)$/);
    expect(job("replan-note").if).toContain("(github.event_name == 'issue_comment' || github.event_name == 'workflow_dispatch')");
    expect(job("replan").steps[0]!.env).toMatchObject({ CHANT_REPLAN_DISPATCH_ARGUMENT: "root" });
    expect(tg.doc.concurrency!.group).toContain("format('dispatch-{0}', github.run_id)");
  });

  test("the re-plan job also takes the /terragucci comments no other job takes, and may reply", () => {
    const r = job("replan");
    expect(r.if).toContain("(startsWith(github.event.comment.body, '/terragucci') && !startsWith(github.event.comment.body, '/terragucci apply'))");
    expect(r.permissions["pull-requests"]).toBe("write");
    expect(r.steps[0]!.env).toMatchObject({ CHANT_REPLAN_PRODUCT: "/terragucci", CHANT_REPLAN_OTHERS: '["/terragucci apply"]' });
  });

  test("the re-plan's note job answers not affected for the argument, and the note's lines read the pull request and head", () => {
    expect(job("replan").outputs).toMatchObject({ argument: "${{ steps.decide.outputs.argument }}" });
    const post = job("replan-note").steps.find((s) => s.name?.startsWith("Post the plan note"))!;
    expect(post.run).toContain('--not-affected "$CHANT_PLAN_ARGUMENT"');
    expect(post.env).toMatchObject({ CHANT_PLAN_ARGUMENT: "${{ needs.replan.outputs.argument }}" });
    expect(job("plan-note").steps.find((s) => s.name?.startsWith("Post the plan note"))!.run).not.toContain("--not-affected");
    const lines = job("replan-note").steps.find((s) => s.name === "The product's lines before the note")!;
    expect(lines.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}", PR_NUMBER: "${{ needs.replan.outputs.pr }}", HEAD_SHA: "${{ needs.replan.outputs.head }}" });
  });

  test("with targets, the first target's re-plan job replies", () => {
    const y = generateProductPlanPipeline("default", { ...options, words: { ...words, commands: { plan: "plan" as const } }, productPlan: { ...options.productPlan, replan: { reply: true } } });
    expect((y.doc.jobsDoc["replan-staging"] as Job).steps[0]!.env).toHaveProperty("CHANT_REPLAN_PRODUCT", "/yodel");
    expect((y.doc.jobsDoc["replan-prod"] as Job).steps[0]!.env).not.toHaveProperty("CHANT_REPLAN_PRODUCT");
  });

  test("sql-yodeler's plan step reads the previous note's marker, from a step before the checkout", () => {
    const y = generateProductPlanPipeline("default", { ...options, productPlan: { ...options.productPlan, previousMarker: true, noteWords: { productMarker: "yodel:plan" } } });
    const steps = (y.doc.jobsDoc["plan-prod"] as Job).steps;
    expect(steps[0]!.name).toBe("Read the previous note's marker");
    expect(steps[0]!.env).toMatchObject({ CHANT_PREVIOUS_TOKEN: "${{ github.token }}", CHANT_PREVIOUS_PR: "${{ github.event.pull_request.number }}", CHANT_PREVIOUS_NOTE: "<!-- chant-pr:default:prod -->", CHANT_PREVIOUS_NAME: "yodel:plan" });
    expect(steps[1]!.name).toBe("Check out the change");
    expect(() => generateProductPlanPipeline("default", { ...options, productPlan: { ...options.productPlan, previousMarker: true } })).toThrow(/productMarker/);
  });

  test("a job gives one of login and trade", () => {
    expect(() => generateProductPlanPipeline("default", { words: tgWords, productPlan: { command: "x", trade, login: { aws: { role: "arn:aws:iam::1:role/r" } } } })).toThrow(/both login and trade/);
  });
});

describe("the re-plan decision with dispatch and reply (#4963)", () => {
  test("without them the script is the one before; with them a dispatch plans, and a comment no other job takes gets a reply", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createServer } = await import("node:http");
    const { REPLAN_DECIDE_JS, replanDecideJs } = await import("@intentius/chant/components/product-plan");
    expect(replanDecideJs()).toBe(REPLAN_DECIDE_JS);
    const head = "b".repeat(40);
    const base = "c".repeat(40);
    let pull: Record<string, unknown> = { state: "open", head: { sha: head, repo: { full_name: "o/r" } }, base: { sha: base } };
    const replies: string[] = [];
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "token t") return void res.writeHead(401).end("{}");
      if (req.url === "/repos/o/r/pulls/7") return void res.end(JSON.stringify(pull));
      if (req.method === "POST" && req.url === "/repos/o/r/issues/7/comments") {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
          replies.push((JSON.parse(data) as { body: string }).body);
          res.writeHead(201).end("{}");
        });
        return;
      }
      res.writeHead(404).end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "chant-replan-4963-"));
    const js = replanDecideJs({ dispatch: true, reply: true });
    // The step runs it as `node -e '<js>'`.
    for (const o of [{ dispatch: true }, { reply: true }, { dispatch: true, reply: true }]) expect(replanDecideJs(o)).not.toContain("'");
    const run = async (event: Record<string, unknown>, env: Record<string, string> = {}): Promise<{ out: Record<string, string>; code: number }> => {
      writeFileSync(join(dir, "event.json"), JSON.stringify(event));
      writeFileSync(join(dir, "out"), "");
      const { execFile } = await import("node:child_process");
      const code = await new Promise<number>((resolve) =>
        execFile(process.execPath, ["-e", js], {
          env: { PATH: process.env.PATH ?? "", GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_OUTPUT: join(dir, "out"), GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_REPOSITORY: "o/r", CHANT_REPLAN_TOKEN: "t", CHANT_REPLAN_COMMANDS: '["/terragucci plan"]', CHANT_REPLAN_PRODUCT: "/terragucci", CHANT_REPLAN_OTHERS: '["/terragucci apply"]', CHANT_REPLAN_DISPATCH_ARGUMENT: "root", ...env },
        }, (err) => resolve(err ? ((err as { code?: number }).code ?? 1) : 0)),
      );
      return { out: Object.fromEntries(readFileSync(join(dir, "out"), "utf8").split("\n").filter(Boolean).map((l) => l.split("=") as [string, string])), code };
    };
    const comment = (body: string) => ({ comment: { body, user: { login: "alice" } }, issue: { number: 7, pull_request: {} } });
    try {
      // A dispatch: the pr input and the argument input, no comment.
      expect(await run({ inputs: { pr: "7", root: "live/app" } }, { GITHUB_EVENT_NAME: "workflow_dispatch" })).toEqual({ out: { go: "1", pr: "7", head, base, argument: "live/app" }, code: 0 });
      expect(await run({ inputs: { pr: "7" } }, { GITHUB_EVENT_NAME: "workflow_dispatch" })).toMatchObject({ out: { go: "1", argument: "" } });
      expect(await run({ inputs: { pr: "" } }, { GITHUB_EVENT_NAME: "workflow_dispatch" })).toEqual({ out: {}, code: 0 });
      expect((await run({ inputs: { pr: "seven" } }, { GITHUB_EVENT_NAME: "workflow_dispatch" })).code).not.toBe(0);
      expect((await run({ inputs: { pr: "7", root: "a; b" } }, { GITHUB_EVENT_NAME: "workflow_dispatch" })).code).not.toBe(0);
      // A comment is answered as before.
      expect((await run(comment("/terragucci plan live/app"))).out).toMatchObject({ go: "1", argument: "live/app" });
      expect(replies).toEqual([]);
      // A /terragucci comment no job takes gets the commands; another job's comment and someone else's get nothing.
      expect((await run(comment("/terragucci plans"))).out).toEqual({});
      expect(replies).toEqual(["terragucci: the commands are `/terragucci plan`, `/terragucci apply`"]);
      expect((await run(comment("/terragucci apply"))).out).toEqual({});
      expect((await run(comment("/terraguccix plan"))).out).toEqual({});
      expect((await run(comment("hello"))).out).toEqual({});
      expect(replies).toHaveLength(1);
      // A target that is none of the plan's.
      expect((await run(comment("/terragucci plan nowhere"), { CHANT_REPLAN_TARGET: "prod", CHANT_REPLAN_TARGETS: '["staging","prod"]' })).out).toEqual({});
      expect(replies.at(-1)).toBe("terragucci: nowhere is none of staging, prod, so nothing is planned again");
      // A fork's pull request, with forks: skip.
      pull = { ...pull, head: { sha: head, repo: { full_name: "fork/r" } } };
      expect((await run(comment("/terragucci plan"), { CHANT_REPLAN_FORKS: "skip" })).out).toEqual({});
      expect(replies.at(-1)).toMatch(/^terragucci: pull request 7 is from a fork/);
      expect(replies).toHaveLength(3);
    } finally {
      server.close();
    }
  });
});

describe("the previous note's marker read (#4963)", () => {
  test("finds the note by chant's marker and hands on the product's line's body, empty when there is none", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createServer } = await import("node:http");
    const { PREVIOUS_MARKER_JS } = await import("@intentius/chant/components/product-plan");
    expect(PREVIOUS_MARKER_JS).not.toContain("'");
    let comments: Array<{ body: string }> = [];
    const server = createServer((req, res) => {
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "token t") return void res.writeHead(401).end("[]");
      const url = new URL(req.url ?? "", "http://x");
      if (url.pathname !== "/repos/o/r/issues/7/comments") return void res.writeHead(404).end("[]");
      const page = Number(url.searchParams.get("page"));
      res.end(JSON.stringify(page === 1 ? comments : []));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), "chant-previous-4963-"));
    const run = async (): Promise<string> => {
      writeFileSync(join(dir, "env"), "");
      const { execFile } = await import("node:child_process");
      await new Promise<void>((resolve, reject) =>
        execFile(process.execPath, ["-e", PREVIOUS_MARKER_JS], {
          env: { PATH: process.env.PATH ?? "", GITHUB_ENV: join(dir, "env"), GITHUB_API_URL: `http://127.0.0.1:${port}`, GITHUB_REPOSITORY: "o/r", CHANT_PREVIOUS_TOKEN: "t", CHANT_PREVIOUS_PR: "7", CHANT_PREVIOUS_NOTE: "<!-- chant-pr:default:prod -->", CHANT_PREVIOUS_NAME: "yodel:plan" },
        }, (err) => (err ? reject(err) : resolve())),
      );
      return readFileSync(join(dir, "env"), "utf8");
    };
    try {
      expect(await run()).toBe("CHANT_PLAN_PREVIOUS_MARKER=\n");
      comments = [
        { body: "<!-- chant-pr:default:staging -->\n<!-- yodel:plan env=staging subject=s1 -->\n" },
        { body: "<!-- chant-pr:default:prod -->\n<!-- yodel:plan env=prod subject=p_2 -->\nthe note" },
      ];
      expect(await run()).toBe("CHANT_PLAN_PREVIOUS_MARKER=env=prod subject=p_2\n");
      comments = [{ body: "<!-- chant-pr:default:prod -->\n<!-- yodel:plan env=prod $(touch x) -->\n" }];
      expect(await run()).toBe("CHANT_PLAN_PREVIOUS_MARKER=\n");
    } finally {
      server.close();
    }
  });
});
