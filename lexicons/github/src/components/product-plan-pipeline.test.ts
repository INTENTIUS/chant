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
