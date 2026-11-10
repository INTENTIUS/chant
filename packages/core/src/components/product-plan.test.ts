/**
 * The product plan (#4799): a product's plan verb in place of `pr-plan`,
 * with a plan job and a note job per target, each holding only its target's
 * values.
 */
import { describe, expect, test } from "vitest";
import { productPipelineJobs } from "./product-pipeline";
import { PR_PLAN_NOTE_WORDS_ENV } from "./product-plan";
import { PLAN_WATCHES_ENV } from "../op/schedule-overdue";
import { TERRAGUCCI, TERRAGUCCI_NOTE, YODEL } from "../__fixtures__/product-words";
import type { CiProductCommand } from "../ci-product-words";

const yodel = { ...YODEL, commands: {} as Record<string, CiProductCommand> };
const terragucci = { ...TERRAGUCCI, commands: { plan: "plan" as const }, aliases: [] };

const environments = {
  command: "yodel plan {target} --pr-note {output}",
  targets: [
    { name: "staging", secrets: { PG_READER_URL: "STAGING_PG_READER_URL" }, writeProbe: "yodel config check staging --write-probe" },
    { name: "prod", secrets: { PG_READER_URL: "PROD_PG_READER_URL" }, variables: { YODEL_REQUIRES: "staging" } },
  ],
};

describe("the product plan (#4799)", () => {
  test("without productPlan the jobs carry none, as before", () => {
    expect(productPipelineJobs("github", "default", { words: terragucci })).not.toHaveProperty("productPlan");
  });

  test.each(["github", "forgejo", "gitlab"] as const)("on %s, one plan job and one note job per target, each with only its own target's values", (forge) => {
    const [staging, prod] = productPipelineJobs(forge, "default", { words: yodel, productPlan: environments }).productPlan!;
    const gitlab = forge === "gitlab";
    expect(staging!.jobName).toBe(gitlab ? "staging-plan" : "plan-staging");
    expect(staging!.noteJobName).toBe(gitlab ? "staging-plan-note" : "plan-note-staging");
    expect(staging!.command).toBe("yodel plan staging --pr-note .chant/pr");
    expect(staging!.writeProbe).toBe("yodel config check staging --write-probe");
    expect(prod!.command).toBe("yodel plan prod --pr-note .chant/pr");
    expect(Object.keys(staging!.env).sort()).toEqual(["BASE_SHA", "PG_READER_URL", "PR_NUMBER"]);
    expect(Object.keys(prod!.env).sort()).toEqual(["BASE_SHA", "PG_READER_URL", "PR_NUMBER", "YODEL_REQUIRES"]);
    expect(staging!.env.PG_READER_URL).toBe(gitlab ? "$STAGING_PG_READER_URL" : "${{ secrets.STAGING_PG_READER_URL }}");
    expect(prod!.env.PG_READER_URL).toBe(gitlab ? "$PROD_PG_READER_URL" : "${{ secrets.PROD_PG_READER_URL }}");
    // The note posts for the target, through the product's bin.
    expect(staging!.post.command).toContain("yodel chant components pr-post");
    expect(staging!.post.command).toContain("--member staging");
    if (!gitlab) expect(staging!.post.env.PLAN_RESULT).toBe("${{ needs.plan-staging.result }}");
    expect(staging!.artifact).toBe("chant-pr-plan-staging");
    // No forge token in a plan step.
    for (const p of [staging!, prod!]) expect(Object.keys(p.env).filter((k) => /TOKEN/.test(k))).toEqual([]);
  });

  test("without targets, one plan job named as the pull request loop's, and the note words reach the note job", () => {
    const [plan] = productPipelineJobs("github", "default", { words: terragucci, productPlan: { command: "terragucci plan --pr-note {output}", noteWords: TERRAGUCCI_NOTE, artifact: "terragucci-report" } }).productPlan!;
    expect(plan).toMatchObject({ jobName: "plan", noteJobName: "plan-note", command: "terragucci plan --pr-note .chant/pr", artifact: "terragucci-report" });
    expect(plan!.post.command).not.toContain("--member");
    expect(JSON.parse(plan!.post.env[PR_PLAN_NOTE_WORDS_ENV]!)).toEqual(TERRAGUCCI_NOTE);
  });

  // #4888: the product's own scheduled jobs reach the note job's pr-post from the pipeline, as terragucci's drift-schedule.json did from the plan job.
  test.each(["github", "forgejo", "gitlab"] as const)("on %s, the product's watches reach the note job, and a watch that is not one is refused", (forge) => {
    const drift = { op: "tf-drift", cron: "0 6 * * *", files: [".github/workflows/terragucci-drift.yml"], ...(forge === "gitlab" ? { schedule: { variable: "TERRAGUCCI_SCHEDULE", not: ["comments"] } } : {}) };
    const [plan] = productPipelineJobs(forge, "default", { words: terragucci, productPlan: { command: "terragucci plan --pr-note {output}", watches: [drift] } }).productPlan!;
    expect(JSON.parse(plan!.post.env[PLAN_WATCHES_ENV]!)).toEqual([drift]);
    const [none] = productPipelineJobs(forge, "default", { words: terragucci, productPlan: { command: "terragucci plan --pr-note {output}" } }).productPlan!;
    expect(none!.post.env).not.toHaveProperty(PLAN_WATCHES_ENV);
    expect(() => productPipelineJobs(forge, "default", { words: terragucci, productPlan: { command: "terragucci plan", watches: [{ op: "tf-drift", cron: "daily" }] } })).toThrow(/the product plan's watches: watch tf-drift's cron "daily" is not five fields/);
    expect(() => productPipelineJobs(forge, "default", { words: terragucci, productPlan: { command: "terragucci plan", watches: [drift, drift] } })).toThrow(/name an Op twice/);
  });

  test("the pipeline's passed values reach every target, and a name both give is refused", () => {
    const [staging] = productPipelineJobs("github", "default", { words: yodel, variables: { YODEL_LOG: "info" }, productPlan: environments }).productPlan!;
    expect(staging!.env.YODEL_LOG).toBe("info");
    expect(() => productPipelineJobs("github", "default", { words: yodel, secrets: { PG_READER_URL: "X" }, productPlan: environments })).toThrow(/target staging's PG_READER_URL is the pipeline's too/);
  });

  test.each([
    ["a target name that is not one", { targets: [{ name: "a b" }] }, /not a name/],
    ["a target named twice", { targets: [{ name: "prod" }, { name: "prod" }] }, /names target prod twice/],
    ["no targets", { targets: [] }, /targets are empty/],
    ["a forge token on a target", { targets: [{ name: "prod", variables: { GITHUB_TOKEN: "x" } }] }, /GITHUB_TOKEN is one the jobs set or drop/],
  ])("refuses %s", (_what, plan, error) => {
    expect(() => productPipelineJobs("github", "default", { words: yodel, productPlan: { command: "yodel plan {target}", ...plan } })).toThrow(error);
  });

  test.each([
    ["previewComment", { previewComment: true }],
    ["staleNotes", { staleNotes: true }],
    ["applyBeforeMerge", { applyBeforeMerge: true }],
    ["build", { build: true }],
  ])("refuses %s, which the product plan does not carry", (key, extra) => {
    const words = key === "previewComment" ? { ...yodel, commands: { plan: "plan" as const } } : key === "applyBeforeMerge" ? { ...yodel, commands: { apply: "apply" as const } } : yodel;
    expect(() => productPipelineJobs("github", "default", { words, ...extra, productPlan: { command: "yodel plan {target}" } })).toThrow(new RegExp(`takes no ${key}`));
  });
});

test("PRODUCT_PLAN_FLOOR marks the product plan in the ci-product entry", async () => {
  const { NEXT_RELEASE } = await import("../release-floors");
  const ciProduct = (await import("../ci-product")) as Record<string, unknown>;
  expect(ciProduct.PRODUCT_PLAN_FLOOR).toBe("0.124.86");
  expect(typeof ciProduct.planNoteHandoff).toBe("function");
});

describe("the product plan's steps beside the plan verb (#4899, #4931)", () => {
  const login = { aws: { role: "arn:aws:iam::123456789012:role/yodel-reader", region: "eu-west-1" } };

  test("a config without the new options gives jobs without their fields", () => {
    const [staging] = productPipelineJobs("github", "default", { words: yodel, productPlan: environments }).productPlan!;
    for (const key of ["jobEnv", "login", "idTokens", "pending", "control", "setup", "report", "replan", "noteSteps"]) expect(staging).not.toHaveProperty(key);
  });

  test.each(["github", "forgejo", "gitlab"] as const)("on %s, a target's login is chant's ci-login, and the job asks for its tokens", (forge) => {
    const [staging, prod] = productPipelineJobs(forge, "default", { words: yodel, productPlan: { ...environments, login, targets: [{ ...environments.targets[0]!, login: { gcp: { provider: "projects/1/locations/global/workloadIdentityPools/p/providers/q", serviceAccount: "r@p.iam.gserviceaccount.com" } } }, environments.targets[1]!] } }).productPlan!;
    expect(staging!.login![0]!.name).toBe("Cloud login (chant ci-login: gcp)");
    expect(prod!.login![0]!.name).toBe("Cloud login (chant ci-login: aws)");
    expect(prod!.idTokens).toEqual({ CHANT_ID_TOKEN_AWS: "sts.amazonaws.com" });
    expect(staging!.idTokens).toEqual({ CHANT_ID_TOKEN_GCP: "https://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/q" });
  });

  test("the product's own id tokens, the job's env, the pending status, the setup steps and the report line", () => {
    const [plan] = productPipelineJobs("github", "default", {
      words: terragucci,
      productPlan: {
        command: "terragucci plan --pr-note {output}",
        idTokens: { TERRAGUCCI_OIDC: "sts.amazonaws.com" },
        env: { TG_LOG: "info" },
        pending: true,
        setup: [{ name: "Restore the cache", uses: "actions/cache/restore@v4", with: { path: "~/.cache" } }],
        report: "terragucci report --out {output}/report",
      },
    }).productPlan!;
    expect(plan).toMatchObject({ idTokens: { TERRAGUCCI_OIDC: "sts.amazonaws.com" }, jobEnv: { TG_LOG: "info" }, pending: { context: "terragucci/plan", description: "planning" }, report: "terragucci report --out .chant/pr/report" });
    // GitLab's plan job holds no token, so it posts no pending status.
    expect(productPipelineJobs("gitlab", "default", { words: terragucci, productPlan: { command: "x", pending: true } }).productPlan![0]).not.toHaveProperty("pending");
  });

  test("the comment re-plan answers the plan command and the words' aliases for it, per target", () => {
    const [staging] = productPipelineJobs("github", "default", { words: { ...yodel, commands: { plan: "plan" as const } }, productPlan: { ...environments, replan: true } }).productPlan!;
    expect(staging!.replan).toMatchObject({ jobName: "replan-staging", noteJobName: "replan-note-staging", comments: ["/yodel plan"], gated: [], artifact: "chant-pr-plan-staging-replan" });
    expect(staging!.replan!.post.env.HEAD_SHA).toBe("${{ needs.replan-staging.outputs.head }}");
    const [tg] = productPipelineJobs("gitlab", "default", { words: { ...TERRAGUCCI, commands: { plan: "plan" as const }, aliases: [TERRAGUCCI.aliases[0]!] }, noteCommands: true, productPlan: { command: "terragucci plan", replan: true } }).productPlan!;
    expect(tg!.replan).toMatchObject({ jobName: "replan", comments: ["/terragucci plan"], gated: [{ comment: "atlantis plan", when: "TG_ATLANTIS_COMMENTS" }] });
    expect(tg!.replan!.post.command).toContain("components pr-post --pr \"$PR_NUMBER\" --head \"$HEAD_SHA\" --env default --output .chant/pr --forge gitlab");
    expect(tg!.replan!.post.command).not.toContain("--result");
  });

  test.each([
    ["replan without a plan command", { replan: true }, /words name no plan command/],
    ["a setup step with both run and uses", { setup: [{ run: "x", uses: "y" }] }, /gives one of run and uses/],
    ["a forge token in the job's env", { env: { GITHUB_TOKEN: "x" } }, /GITHUB_TOKEN is one the jobs set or drop/],
    ["a concurrency group that is not a name", { concurrency: { group: "a b" } }, /concurrency group/],
    ["an id token with no audience", { idTokens: { T: "" } }, /names no audience/],
  ])("refuses %s", (_what, extra, error) => {
    expect(() => productPipelineJobs("github", "default", { words: yodel, productPlan: { command: "yodel plan {target}", ...extra } })).toThrow(error);
  });

  test("noteSteps are refused on GitLab, and noteCommands without replan", () => {
    expect(() => productPipelineJobs("gitlab", "default", { words: yodel, productPlan: { command: "x", noteSteps: { before: ["y"] } } })).toThrow(/GitLab's note job posts every open merge request's note/);
    expect(() => productPipelineJobs("gitlab", "default", { words: yodel, noteCommands: true, productPlan: { command: "x" } })).toThrow(/noteCommands without replan/);
  });

  test("with replan, GitLab's note-commands job starts the preview's pipeline", () => {
    const jobs = productPipelineJobs("gitlab", "default", { words: { ...yodel, commands: { plan: "plan" as const } }, noteCommands: true, productPlan: { command: "x", replan: true } });
    expect(jobs.noteCommands!.command).toContain("--preview-comment");
  });
});

describe("the re-plan decision and the pending status scripts (#4899)", () => {
  test("hold no single quote, so they go in a node -e '...' line", async () => {
    const { REPLAN_DECIDE_JS, PENDING_JS } = await import("./product-plan");
    expect(REPLAN_DECIDE_JS).not.toContain("'");
    expect(PENDING_JS).not.toContain("'");
    expect(() => new Function(REPLAN_DECIDE_JS)).not.toThrow();
    expect(() => new Function(PENDING_JS)).not.toThrow();
  });

  test("the GitLab rule matches the command alone or with this target, and the aliases behind their variable", async () => {
    const { gitlabReplanCommentIf } = await import("./product-plan");
    expect(gitlabReplanCommentIf({ comments: ["/yodel plan"], gated: [] }, "prod")).toBe("$CHANT_PREVIEW_COMMENT =~ /^\\/yodel plan( +prod)? *$/");
    expect(gitlabReplanCommentIf({ comments: ["/terragucci plan"], gated: [{ comment: "atlantis plan", when: "TG_ATLANTIS_COMMENTS" }] })).toBe(
      "$CHANT_PREVIEW_COMMENT =~ /^\\/terragucci plan( +[A-Za-z0-9_.\\/@+=,:-]+)? *$/ || ($TG_ATLANTIS_COMMENTS && $CHANT_PREVIEW_COMMENT =~ /^atlantis plan( +[A-Za-z0-9_.\\/@+=,:-]+)? *$/)",
    );
  });
});

test("PRODUCT_PLAN_STEPS_FLOOR marks the plan-job steps in the ci-product entry", async () => {
  const ciProduct = (await import("../ci-product")) as Record<string, unknown>;
  expect(ciProduct.PRODUCT_PLAN_STEPS_FLOOR).toBe("0.124.88");
  expect(ciProduct.PLAN_NOTE_NOTICES_ENV).toBe("CHANT_PLAN_NOTE_NOTICES");
});

describe("what terragucci's and sql-yodeler's plan jobs need (#4963)", () => {
  const trade = { aws: { region: "us-east-1", audience: "sts.amazonaws.com", role: "arn:aws:iam::123456789012:role/plan" } };

  test("PRODUCT_PLAN_REPLAN_FLOOR is the next release, in the ci-product entry", async () => {
    const ciProduct = (await import("../ci-product")) as Record<string, unknown>;
    const { NEXT_RELEASE } = await import("../release-floors");
    expect(ciProduct.PRODUCT_PLAN_REPLAN_FLOOR).toBe(NEXT_RELEASE);
    expect(typeof ciProduct.planBodyHandoff).toBe("function");
  });

  test("a trade's OIDC token is the job's, beside its own; a target's login or trade stands in for the plan's", () => {
    const [one] = productPipelineJobs("gitlab", "default", { words: terragucci, productPlan: { command: "x", trade, idTokens: { TG_OIDC: "tg" } } }).productPlan!;
    expect(one!.trade).toEqual(trade);
    expect(one!.idTokens).toEqual({ CHANT_ID_TOKEN_AWS: "sts.amazonaws.com", TG_OIDC: "tg" });
    const [a, b] = productPipelineJobs("github", "default", { words: yodel, productPlan: { ...environments, trade, targets: [{ name: "a", login: { aws: { role: "arn:aws:iam::1:role/r" } } }, { name: "b" }] } }).productPlan!;
    expect(a!.trade).toBeUndefined();
    expect(a!.login).toBeDefined();
    expect(b!.trade).toEqual(trade);
    expect(() => productPipelineJobs("github", "default", { words: terragucci, productPlan: { command: "x", trade, idTokens: { CHANT_ID_TOKEN_AWS: "other" } } })).toThrow(/the trade's, with another audience/);
  });

  test("the re-plan's options are checked", () => {
    const plan = (replan: unknown) => () => productPipelineJobs("github", "default", { words: terragucci, productPlan: { command: "x", replan: replan as never } });
    expect(plan({ dispatch: { argument: "pr" } })).toThrow(/input name/);
    expect(plan({ dispatch: { argument: "Root Dir" } })).toThrow(/input name/);
    expect(plan({ reply: { others: ["/plywood up"] } })).toThrow(/not a \/terragucci comment/);
    expect(plan({ reply: { others: ["/terragucci it's"] } })).toThrow(/quote/);
    const [p] = productPipelineJobs("github", "default", { words: terragucci, productPlan: { command: "x", replan: { dispatch: true, reply: true, notAffected: true } } }).productPlan!;
    expect(p!.replan).toMatchObject({ dispatch: { argument: "argument" }, reply: { prefix: "/terragucci", others: [] }, notAffected: true });
    expect(p!.replan!.post.command).toMatch(/ --not-affected "\$CHANT_PLAN_ARGUMENT"$/);
    expect(p!.post.command).not.toContain("--not-affected");
  });

  test("previousMarker names chant's marker for the target and the product's marker", () => {
    const [, prod] = productPipelineJobs("forgejo", "default", { words: yodel, productPlan: { ...environments, previousMarker: true, noteWords: { productMarker: "yodel:plan" } } }).productPlan!;
    expect(prod!.previous).toEqual({ marker: "<!-- chant-pr:default:prod -->", name: "yodel:plan" });
  });
});
