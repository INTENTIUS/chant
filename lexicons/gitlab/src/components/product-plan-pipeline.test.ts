/**
 * The product plan pipeline on GitLab CI (#4799): a plan job per target in
 * the merge request's pipeline, and a note job per target in a pipeline of
 * the target branch, which posts from the plan job's artifact.
 */
import { describe, expect, test } from "vitest";
import { generateGitlabProductPlanPipeline } from "./product-plan-pipeline";

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

type Job = { stage: string; rules: Array<{ if: string }>; variables?: Record<string, string>; script: string[]; artifacts?: Record<string, unknown>; tags?: string[] };

describe("the product plan pipeline on GitLab (#4799)", () => {
  const { yaml, entries } = generateGitlabProductPlanPipeline("default", {
    words,
    beforeScript: ["yodel ci --fetch-ledger"],
    runners: { plan: "db-readers" },
    productPlan: {
      command: "yodel plan {target} --pr-note {output}",
      workflow: "yodel-pr",
      forks: "skip",
      targets: [
        { name: "staging", secrets: { PG_READER_URL: "STAGING_PG_READER_URL" }, writeProbe: "yodel config check staging --write-probe" },
        { name: "prod", secrets: { PG_READER_URL: "PROD_PG_READER_URL" } },
      ],
    },
  });
  const job = (name: string) => entries.find(([k]) => k === name)![1] as Job;

  test("writes the workflow, the two stages, and a plan and a note job per target", () => {
    expect(entries.map(([k]) => k)).toEqual(["workflow", "stages", "variables", "staging-plan", "prod-plan", "staging-plan-note", "prod-plan-note"]);
    expect(entries[1]![1]).toEqual(["plan", "plan-note"]);
    expect(yaml).toContain("name: yodel-pr");
  });

  test("a plan job drops the forge tokens first, probes, plans with its own target's variable, and keeps its report", () => {
    const staging = job("staging-plan");
    expect(staging.script[0]).toMatch(/^unset /);
    expect(staging.script.slice(-3)).toEqual(["yodel ci --fetch-ledger", "yodel config check staging --write-probe", "yodel plan staging --pr-note .chant/pr"]);
    expect(staging.variables).toEqual({ BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: "$CI_MERGE_REQUEST_IID", PG_READER_URL: "$STAGING_PG_READER_URL" });
    expect(job("prod-plan").variables!.PG_READER_URL).toBe("$PROD_PG_READER_URL");
    expect(staging.artifacts).toEqual({ name: "chant-pr-plan-staging", when: "always", paths: [".chant/pr"] });
    expect(staging.tags).toEqual(["db-readers"]);
  });

  test("with forks: skip, the plan runs only for the project's own merge requests", () => {
    expect(job("prod-plan").rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_MERGE_REQUEST_PROJECT_ID' }]);
  });

  test("the note job runs in a pipeline of the target branch and posts the target's note from its plan job", () => {
    const note = job("prod-plan-note");
    expect(note.rules[0]!.if).toContain('$CHANT_PLAN_NOTES == "1"');
    expect(note.script).toEqual(["yodel ci --fetch-ledger", "yodel chant components pr-post --open --env default --output .chant/pr --forge gitlab --member prod"]);
  });
});

describe("the product plan's steps on GitLab (#4899, #4931)", () => {
  const { entries, yaml } = generateGitlabProductPlanPipeline("default", {
    words: { ...words, commands: { plan: "plan" } },
    noteCommands: true,
    cache: { key: "yodel", paths: [".cache/yodel"] },
    productPlan: {
      command: "yodel plan {target} --pr-note {output}",
      env: { YODEL_LOG: "info" },
      login: { aws: { role: "arn:aws:iam::123456789012:role/r" } },
      idTokens: { YODEL_OIDC: "yodel" },
      pending: true,
      setup: [{ uses: "actions/cache/restore@v4" }, { run: "yodel warm" }],
      report: "yodel report {target} --out {output}/report",
      concurrency: { cancelInProgress: true },
      replan: true,
      targets: [{ name: "staging", writeProbe: "probe staging" }, { name: "prod" }],
    },
  });
  const job = (name: string) => entries.find(([k]) => k === name)![1] as Job & { id_tokens?: Record<string, { aud: string }>; cache?: unknown; interruptible?: boolean; needs?: unknown };

  test("the plan job: its tokens, its variables, the run steps alone, the login before the probe, and the report after the verb", () => {
    const plan = job("staging-plan");
    expect(plan.id_tokens).toEqual({ CHANT_ID_TOKEN_AWS: { aud: "sts.amazonaws.com" }, YODEL_OIDC: { aud: "yodel" } });
    expect(plan.variables).toEqual({ YODEL_LOG: "info", BASE_SHA: "$CI_MERGE_REQUEST_DIFF_BASE_SHA", PR_NUMBER: "$CI_MERGE_REQUEST_IID" });
    expect(plan.cache).toEqual({ key: "yodel", paths: [".cache/yodel"] });
    expect(plan.interruptible).toBe(true);
    const s = plan.script;
    expect(s[0]).toMatch(/^unset CHANT_FORGE_TOKEN/);
    expect(s[1]).toBe("yodel warm");
    expect(s.join("\n")).not.toContain("actions/cache");
    expect(s.indexOf('eval "$CHANT_CLOUD_LOGIN_VARS"')).toBeLessThan(s.indexOf("probe staging"));
    expect(s.slice(-3)).toEqual(["yodel plan staging --pr-note .chant/pr || chant_plan_exit=$?", 'yodel report staging --out .chant/pr/report || echo "chant: the report line exited $?" >&2', '[ "$chant_plan_exit" -eq 0 ] || exit "$chant_plan_exit"']);
    // GitLab's plan job holds no token, so it posts no pending status.
    expect(yaml).not.toContain("CHANT_PENDING");
  });

  test("the note-commands job starts the re-plan's pipeline, whose jobs run for the target the comment names", () => {
    expect(entries.map(([k]) => k)).toEqual(["workflow", "stages", "variables", "staging-plan", "prod-plan", "staging-plan-note", "prod-plan-note", "note-commands", "staging-replan", "prod-replan", "staging-replan-note", "prod-replan-note"]);
    expect(job("note-commands").script.at(-1)).toBe("yodel chant components pr-notes --forge gitlab --preview-comment");
    const replan = job("prod-replan");
    expect(replan.rules[0]!.if).toBe("$CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/ && $CHANT_PREVIEW_PR =~ /^[0-9]+$/ && $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && ($CHANT_PREVIEW_COMMENT =~ /^\\/yodel plan( +prod)? *$/)");
    expect(replan.variables).toMatchObject({ BASE_SHA: "$CI_COMMIT_SHA", PR_NUMBER: "$CHANT_PREVIEW_PR" });
    // The tokens go before the merge request's head is checked out.
    expect(replan.script[0]).toMatch(/^unset CHANT_FORGE_TOKEN/);
    expect(replan.script.findIndex((l) => l.includes("refs/merge-requests/$PR_NUMBER/head"))).toBe(2);
    const note = job("prod-replan-note");
    expect(note.needs).toEqual([{ job: "prod-replan", artifacts: true }]);
    expect(note.script.at(-1)).toBe('yodel chant components pr-post --pr "$PR_NUMBER" --head "$HEAD_SHA" --env default --output .chant/pr --forge gitlab --member prod');
  });

  test("a config without the new options renders no new stage or rule", () => {
    const plain = generateGitlabProductPlanPipeline("default", { words, productPlan: { command: "yodel plan {target}" } });
    expect(plain.entries.map(([k]) => k)).toEqual(["workflow", "stages", "variables", "plan", "plan-note"]);
    expect(plain.yaml).not.toMatch(/interruptible|id_tokens|CHANT_PREVIEW|note-commands/);
  });
});
