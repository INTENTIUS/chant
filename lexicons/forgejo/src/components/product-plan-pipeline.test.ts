/**
 * The product plan workflow on Forgejo Actions (#4799): the GitHub document
 * through the Forgejo dialect, its commands naming Forgejo.
 */
import { describe, expect, test } from "vitest";
import { generateForgejoProductPlanPipeline } from "./product-plan-pipeline";

const words = {
  product: "terragucci",
  noun: ["root", "roots"] as [string, string],
  commands: {},
  approve: "terragucci approve {gate} --plan {digest} {sign}",
  op: "tf-apply",
  gateName: "wave-{k}",
  approval: "per-wave" as const,
  bin: "terragucci chant",
};

type Job = { if: string; "runs-on": unknown; permissions?: Record<string, string>; steps: Array<{ name?: string; id?: string; env?: Record<string, string>; run?: string; uses?: string }> };

describe("the product plan workflow on Forgejo (#4799)", () => {
  const { yaml, doc } = generateForgejoProductPlanPipeline("default", {
    words,
    productPlan: { command: "terragucci plan --pr-note {output}", forks: "skip", targets: [{ name: "prod", secrets: { TF_VAR_token: "PROD_TOKEN" } }] },
  });
  const plan = doc.jobsDoc["plan-prod"] as Job;
  const note = doc.jobsDoc["plan-note-prod"] as Job;

  test("runs on Forgejo's runner label, without the permissions Forgejo ignores", () => {
    expect(plan["runs-on"]).toBe("docker");
    expect(plan.permissions).toBeUndefined();
    expect(note.steps.find((s) => s.name === "Keep the plan report")!.uses).toMatch(/^https:\/\/code\.forgejo\.org\//);
  });

  test("the note posts to Forgejo, for the target", () => {
    const post = note.steps[note.steps.length - 1]!;
    expect(post.run).toContain("--forge forgejo --member prod");
    expect(plan.steps.find((s) => s.id === "plan")!.env!.TF_VAR_token).toBe("${{ secrets.PROD_TOKEN }}");
  });

  test("skips a fork's pull request, as on GitHub", () => {
    expect(plan.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(yaml).toContain("jobs:");
  });
});

describe("the product plan's steps on Forgejo (#4899, #4931)", () => {
  test("a login asks for the OIDC token with enable-openid-connect, and the re-plan asks the forge whether the commenter can write", async () => {
    const { generateForgejoProductPlanPipeline } = await import("./product-plan-pipeline");
    const { doc, yaml } = generateForgejoProductPlanPipeline("default", {
      words: { product: "yodel", noun: ["environment", "environments"], commands: { plan: "plan" }, approve: "yodel approve {target} --plan {digest} {sign}", op: "yodel-apply", gateName: "yodel-apply-wave-{k}", approval: "per-wave", bin: "yodel chant" },
      productPlan: { command: "yodel plan {target}", replan: true, pending: true, concurrency: { group: "yodel-pr" }, login: { aws: { role: "arn:aws:iam::123456789012:role/r" } }, targets: [{ name: "staging" }] },
    });
    const plan = doc.jobsDoc["plan-staging"] as Record<string, unknown>;
    expect(plan["enable-openid-connect"]).toBe(true);
    const replan = doc.jobsDoc["replan-staging"] as { if: string; steps: Array<{ env?: Record<string, string> }> };
    expect(replan.if).toContain("(github.event.issue.pull_request || github.event.is_pull)");
    expect(replan.if).not.toContain("author_association");
    expect(replan.steps[0]!.env).toMatchObject({ CHANT_REPLAN_PERMISSION: "1" });
    expect(yaml).toContain("group: yodel-pr-${{ github.event.pull_request.number || format('comment-{0}', github.event.comment.id) }}");
    expect(yaml).toContain("Cloud login (chant ci-login: aws)");
    expect(yaml).toContain('"$GITHUB_ENV" github-env forgejo)');
  });
});

describe("the note job compares the plan's subject on Forgejo (#4972)", () => {
  test("the plan job reads no note, and the note job gets the note words", () => {
    const noteWords = { productMarker: "yodel:plan", sinceLastOnly: "The plan changed since `{previous}`." };
    const { doc } = generateForgejoProductPlanPipeline("default", { words, productPlan: { command: "yodel plan {target} --pr-note {output}", noteWords, targets: [{ name: "prod" }] } });
    const plan = doc.jobsDoc["plan-prod"] as Job;
    expect(JSON.stringify(plan)).not.toMatch(/CHANT_PLAN_PREVIOUS_MARKER|CHANT_PREVIOUS_TOKEN|Read the previous note/);
    const post = (doc.jobsDoc["plan-note-prod"] as Job).steps.find((s) => s.name?.startsWith("Post the plan note"))!;
    expect(JSON.parse(post.env!.CHANT_PLAN_NOTE_WORDS!)).toEqual(noteWords);
  });
});

describe("terragucci's plan jobs on Forgejo (#4963)", () => {
  test("the trade asks for the OIDC token with enable-openid-connect, and a dispatch re-plans without asking the commenter's permission", () => {
    const { doc } = generateForgejoProductPlanPipeline("default", {
      words: { ...words, commands: { plan: "plan" as const } },
      productPlan: { command: "terragucci plan --pr-note {output}", trade: { aws: { region: "us-east-1", audience: "sts.amazonaws.com", role: "arn:aws:iam::123456789012:role/tg-plan" } }, replan: { dispatch: { argument: "root" }, reply: true } },
    });
    const plan = doc.jobsDoc["plan"] as Record<string, unknown> & Job;
    expect(plan["enable-openid-connect"]).toBe(true);
    expect(plan.steps[0]!.name).toBe("Trade the job's OIDC token for the plan identities");
    expect(doc.on).toHaveProperty("workflow_dispatch");
    const replan = doc.jobsDoc["replan"] as Job;
    expect(replan.steps[0]!.env).toMatchObject({ CHANT_REPLAN_PERMISSION: "1", CHANT_REPLAN_DISPATCH_ARGUMENT: "root", CHANT_REPLAN_PRODUCT: "/terragucci" });
    expect(replan.steps[0]!.run).toContain("CHANT_REPLAN_PERMISSION&&!dispatch");
  });
});
