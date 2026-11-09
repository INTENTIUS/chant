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
