import { describe, test, expect } from "vitest";
import { governancePipeline } from "./pipeline.js";
import { githubSerializer } from "@intentius/chant-lexicon-github";

// ── Shape tests ────────────────────────────────────────────────────

describe("governancePipeline", () => {
  test("returns workflow, dryRunJob, and applyJob", () => {
    const { workflow, dryRunJob, applyJob } = governancePipeline();
    expect(workflow).toBeDefined();
    expect(dryRunJob).toBeDefined();
    expect(applyJob).toBeDefined();
  });

  test("workflow is a GitHub::Actions::Workflow resource", () => {
    const { workflow } = governancePipeline();
    expect(workflow.entityType).toBe("GitHub::Actions::Workflow");
    expect(workflow.kind).toBe("resource");
    expect(workflow.lexicon).toBe("github");
  });

  test("workflow has schedule, pull_request, and workflow_dispatch triggers", () => {
    const { workflow } = governancePipeline();
    const on = workflow.props.on as Record<string, unknown>;
    expect(on.schedule).toBeDefined();
    expect(on.pull_request).toBeDefined();
    expect(on.workflow_dispatch).toBeDefined();
  });

  test("default cron is 0 2 * * *", () => {
    const { workflow } = governancePipeline();
    const on = workflow.props.on as Record<string, unknown>;
    const schedule = on.schedule as Array<{ cron: string }>;
    expect(schedule[0].cron).toBe("0 2 * * *");
  });

  test("custom cron is respected", () => {
    const { workflow } = governancePipeline({ cron: "0 6 * * 1" });
    const on = workflow.props.on as Record<string, unknown>;
    const schedule = on.schedule as Array<{ cron: string }>;
    expect(schedule[0].cron).toBe("0 6 * * 1");
  });

  test("workflow has least-privilege permissions (contents: read only)", () => {
    const { workflow } = governancePipeline();
    const perms = workflow.props.permissions as Record<string, string>;
    expect(perms.contents).toBe("read");
    // write scopes must NOT be at the workflow level
    expect(perms["pull-requests"]).toBeUndefined();
    expect(perms.pullRequests).toBeUndefined();
  });

  // ── Dry-run / apply split ──────────────────────────────────────

  test("dry-run job has pull_request conditional", () => {
    const { dryRunJob } = governancePipeline();
    expect(dryRunJob.props.if).toContain("pull_request");
  });

  test("apply job skips pull_request events", () => {
    const { applyJob } = governancePipeline();
    expect(applyJob.props.if).toContain("pull_request");
    // must be a negation
    expect(applyJob.props.if).toContain("!=");
  });

  test("dry-run job steps include dry-run mode", () => {
    const { dryRunJob } = governancePipeline();
    const steps = dryRunJob.props.steps as Array<{ props: Record<string, unknown> }>;
    const runSteps = steps.filter((s) => typeof s.props.run === "string");
    const dryRunScript = runSteps.find((s) => (s.props.run as string).includes("dry-run"));
    expect(dryRunScript).toBeDefined();
  });

  test("apply job steps include apply mode", () => {
    const { applyJob } = governancePipeline();
    const steps = applyJob.props.steps as Array<{ props: Record<string, unknown> }>;
    const runSteps = steps.filter((s) => typeof s.props.run === "string");
    const applyScript = runSteps.find((s) => (s.props.run as string).includes("--mode apply"));
    expect(applyScript).toBeDefined();
  });

  // ── Security constraints ───────────────────────────────────────

  test("private key is sourced from a secret (not a var)", () => {
    const { dryRunJob, applyJob } = governancePipeline();
    // The mint-token step uses `with.private-key: ${{ secrets.XYZ }}`
    for (const job of [dryRunJob, applyJob]) {
      const steps = job.props.steps as Array<{ props: Record<string, unknown> }>;
      const mintStep = steps.find(
        (s) => typeof s.props.uses === "string" && (s.props.uses as string).includes("create-github-app-token"),
      );
      expect(mintStep).toBeDefined();
      const withBlock = mintStep!.props.with as Record<string, string>;
      const privateKey = withBlock["private-key"];
      // Must reference secrets.* not vars.*
      expect(privateKey).toMatch(/\$\{\{\s*secrets\./);
      expect(privateKey).not.toMatch(/\$\{\{\s*vars\./);
    }
  });

  test("all external actions are SHA-pinned", () => {
    const { dryRunJob, applyJob } = governancePipeline();
    const SHA_RE = /^[a-z0-9]{40}$/;
    for (const job of [dryRunJob, applyJob]) {
      const steps = job.props.steps as Array<{ props: Record<string, unknown> }>;
      const useSteps = steps.filter((s) => typeof s.props.uses === "string");
      for (const step of useSteps) {
        const uses = step.props.uses as string;
        const [, ref] = uses.split("@");
        expect(ref, `Action "${uses}" must be pinned to a SHA`).toMatch(SHA_RE);
      }
    }
  });

  test("every job has timeout-minutes set", () => {
    const { dryRunJob, applyJob } = governancePipeline();
    expect(dryRunJob.props["timeout-minutes"]).toBeTypeOf("number");
    expect(applyJob.props["timeout-minutes"]).toBeTypeOf("number");
  });

  test("dry-run job has pull-requests write permission for PR comment", () => {
    const { dryRunJob } = governancePipeline();
    const perms = dryRunJob.props.permissions as Record<string, string>;
    expect(perms["pull-requests"]).toBe("write");
    expect(perms.contents).toBe("read");
  });

  test("apply job has only contents: read permission", () => {
    const { applyJob } = governancePipeline();
    const perms = applyJob.props.permissions as Record<string, string>;
    expect(perms.contents).toBe("read");
    expect(perms["pull-requests"]).toBeUndefined();
  });

  // ── Parameterization ──────────────────────────────────────────

  test("configPath is used in PR trigger path filter", () => {
    const configPath = ".github/my-org-config.yml";
    const { workflow } = governancePipeline({ configPath });
    const on = workflow.props.on as Record<string, unknown>;
    const pr = on.pull_request as Record<string, unknown>;
    const paths = pr.paths as string[];
    expect(paths).toContain(configPath);
  });

  test("cycles flag is forwarded to reconcile command", () => {
    const { dryRunJob, applyJob } = governancePipeline({ cycles: ["branch-protection", "team-sync"] });
    for (const job of [dryRunJob, applyJob]) {
      const steps = job.props.steps as Array<{ props: Record<string, unknown> }>;
      const runSteps = steps.filter((s) => typeof s.props.run === "string");
      const hasFlag = runSteps.some((s) =>
        (s.props.run as string).includes("--cycles branch-protection,team-sync"),
      );
      expect(hasFlag, "Expected --cycles flag in job steps").toBe(true);
    }
  });

  test("custom appIdVar is referenced in mint-token step", () => {
    const { dryRunJob } = governancePipeline({ appIdVar: "MY_APP_ID" });
    const steps = dryRunJob.props.steps as Array<{ props: Record<string, unknown> }>;
    const mintStep = steps.find(
      (s) => typeof s.props.uses === "string" && (s.props.uses as string).includes("create-github-app-token"),
    )!;
    const withBlock = mintStep.props.with as Record<string, string>;
    expect(withBlock["app-id"]).toContain("MY_APP_ID");
  });

  test("custom privateKeySecret is used (secret, not var)", () => {
    const { dryRunJob } = governancePipeline({ privateKeySecret: "MY_PRIVATE_KEY" });
    const steps = dryRunJob.props.steps as Array<{ props: Record<string, unknown> }>;
    const mintStep = steps.find(
      (s) => typeof s.props.uses === "string" && (s.props.uses as string).includes("create-github-app-token"),
    )!;
    const withBlock = mintStep.props.with as Record<string, string>;
    expect(withBlock["private-key"]).toContain("secrets.MY_PRIVATE_KEY");
  });

  // ── Serialization ──────────────────────────────────────────────

  test("serializes to YAML without error", () => {
    const { workflow } = governancePipeline();
    const entities = new Map([["governance", workflow]]);
    const yaml = githubSerializer.serialize(entities) as string;
    expect(yaml).toContain("name: Governance reconcile");
    expect(yaml).toContain("schedule:");
    expect(yaml).toContain("pull_request:");
    expect(yaml).toContain("workflow_dispatch:");
    expect(yaml).toContain("permissions:");
    expect(yaml).toContain("contents: read");
  });
});
