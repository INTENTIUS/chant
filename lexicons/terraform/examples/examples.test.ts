/**
 * Every shipped terraform example builds, and the two that carry CI generate
 * the workflows they document: `scheduled-watch`'s cron (#2087) and
 * `plan-on-pr`'s `pull_request` plan / `push` apply pair (#2084, #2221).
 *
 * `chant dev check-lexicon` already gates "builds". What it does not cover is
 * the second half of those examples: the Ops there exist to be triggered by
 * something, and the something they ship is `generateOpsPipeline` against the
 * github lexicon. So the emitted workflows are asserted here, field by field,
 * against the real generator and the real Op discovery, rather than described
 * in a README nothing checks.
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { build } from "@intentius/chant/build";
import { parseYAML } from "@intentius/chant/yaml";
import { generateOpsPipeline, type ActivityStep, type OpConfig } from "@intentius/chant/op";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";
import { terraformSerializer } from "../src/serializer";

const examplesDir = dirname(fileURLToPath(import.meta.url));

const exampleNames = readdirSync(examplesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(examplesDir, e.name, "src")))
  .map((e) => e.name)
  .sort();

describe("terraform examples", () => {
  it("ships at least one example", () => {
    expect(exampleNames.length).toBeGreaterThan(0);
  });

  for (const name of exampleNames) {
    it(`${name} builds with no structural error`, async () => {
      const result = await build(join(examplesDir, name, "src"), [terraformSerializer]);
      expect(result.errors).toEqual([]);
    });
  }
});

/**
 * The terraform install the runner needs, as a `beforeScript` line: a plain
 * `run:` step (`lexicons/github/src/components/generate-op-pipeline.ts`)
 * rather than a `uses: hashicorp/setup-terraform`. A spec's `setup` list
 * could carry the action since #2242, but a curl-and-unzip needs no action to
 * express and the shell line is what the two examples already share.
 *
 * A pinned release unzip, not the apt repo: the version the Op plans with is
 * then the version this file names, which matters for an estate whose state
 * has a `required_version` floor.
 */
const TERRAFORM_VERSION = "1.13.3";
const INSTALL_TERRAFORM =
  `curl -fsSL https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/terraform_${TERRAFORM_VERSION}_linux_amd64.zip ` +
  `-o /tmp/terraform.zip && unzip -q -o /tmp/terraform.zip -d /usr/local/bin && terraform version`;

const WATCH_SPEC: ScheduledOpSpec = {
  name: "app-watch",
  schedule: "0 6 * * *",
  findingMode: "issue",
};

const scheduledWatchDir = join(examplesDir, "scheduled-watch");

async function watchWorkflow(): Promise<string> {
  const result = await generateOpsPipeline(
    [WATCH_SPEC],
    "github",
    { beforeScript: [INSTALL_TERRAFORM] },
    scheduledWatchDir,
  );
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  const file = result.files?.find((f) => f.name === "app-watch.yml");
  expect(file, "one workflow file per scheduled Op").toBeDefined();
  return file!.yaml;
}

describe("scheduled-watch generates its GitHub Actions cron (#2087)", () => {
  it("discovers the example's own Op, and only that one", async () => {
    // `discoverOps` roots at the nearest chant.config.ts, so this resolves the
    // example's `src/watch.op.ts` and not the repo's other `*.op.ts` files.
    const result = await generateOpsPipeline([WATCH_SPEC], "github", {}, scheduledWatchDir);
    expect(result.success).toBe(true);
    expect(result.jobs).toEqual([
      {
        jobName: "app-watch",
        op: "app-watch",
        trigger: { kind: "cron", schedule: "0 6 * * *" },
        findingMode: "issue",
      },
    ]);
  });

  it("fails on an Op the example does not declare", async () => {
    const result = await generateOpsPipeline(
      [{ name: "not-an-op", schedule: "0 6 * * *" }],
      "github",
      {},
      scheduledWatchDir,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown Op\(s\): not-an-op/);
  });

  it("carries the cron and workflow_dispatch", async () => {
    const yaml = await watchWorkflow();
    expect(yaml).toContain("- cron: '0 6 * * *'");
    expect(yaml).toContain("workflow_dispatch:");
  });

  it("carries a per-Op concurrency group that does not cancel a run in flight", async () => {
    const yaml = await watchWorkflow();
    expect(yaml).toContain("concurrency:");
    expect(yaml).toContain("group: app-watch");
    expect(yaml).toContain("cancel-in-progress: false");
  });

  it("grants issues: write and nothing wider", async () => {
    const yaml = await watchWorkflow();
    expect(yaml).toContain("issues: write");
    expect(yaml).toContain("contents: read");
    expect(yaml).not.toContain("contents: write");
    expect(yaml).not.toContain("pull-requests: write");
    expect(yaml).not.toContain("write-all");
  });

  it("installs terraform before running the Op", async () => {
    const yaml = await watchWorkflow();
    expect(yaml).toContain(`releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/`);
    expect(yaml).toContain("unzip -q -o /tmp/terraform.zip -d /usr/local/bin");
    // The install must precede the invocation, or the Op's first step is a
    // missing binary.
    expect(yaml.indexOf("/tmp/terraform.zip")).toBeLessThan(yaml.indexOf("chant run app-watch"));
  });

  it("runs the Op through `chant run`, with the token the issue mode needs", async () => {
    const yaml = await watchWorkflow();
    expect(yaml).toContain("chant run app-watch");
    expect(yaml).toContain("GH_TOKEN:");
  });
});

/**
 * `plan-on-pr` generates the other CI shape the lexicon ships (#2221): the
 * #2084 trigger pair, one `pull_request` workflow that plans and one `push`
 * workflow that applies, over the same root. Two `ScheduledOpSpec`s, two
 * files, because a GitHub trigger is workflow-scoped rather than job-scoped.
 */
const planOnPrDir = join(examplesDir, "plan-on-pr");

/**
 * The AWS auth both halves use, as the OIDC form #2242 made expressible: a
 * `uses:` setup step that exchanges the run's own OIDC token for short-lived
 * credentials, plus the `id-token: write` no finding-mode grants. Pinned to
 * the action's current major tag, the same way this repository pins its own
 * workflows; the role ARN is a repository variable, so the example carries no
 * account number and a fork of it needs one variable rather than a secret.
 *
 * Two roles, not one, which is the reason `setup` is a per-Op option rather
 * than a generator-wide one: the pull-request half only reads, and the push
 * half is the only thing that should hold a role that can write.
 */
const AWS_CREDENTIALS_ACTION = "aws-actions/configure-aws-credentials@v6";
const AWS_REGION = "eu-west-1";

function assumeRole(roleVariable: string): ScheduledOpSpec["setup"] {
  return [
    {
      uses: AWS_CREDENTIALS_ACTION,
      with: { "role-to-assume": `\${{ vars.${roleVariable} }}`, "aws-region": AWS_REGION },
    },
  ];
}

const PLAN_SPEC: ScheduledOpSpec = {
  name: "app-plan",
  trigger: { kind: "pull_request", branches: ["main"] },
  findingMode: "comment",
  setup: assumeRole("AWS_PLAN_ROLE_ARN"),
  permissions: { "id-token": "write" },
};

const APPLY_SPEC: ScheduledOpSpec = {
  name: "app-apply",
  trigger: { kind: "push", branches: ["main"] },
  setup: assumeRole("AWS_APPLY_ROLE_ARN"),
  permissions: { "id-token": "write" },
};

async function planOnPrWorkflows(): Promise<{ plan: string; apply: string }> {
  const result = await generateOpsPipeline(
    [PLAN_SPEC, APPLY_SPEC],
    "github",
    { beforeScript: [INSTALL_TERRAFORM] },
    planOnPrDir,
  );
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  const plan = result.files?.find((f) => f.name === "app-plan.yml");
  const apply = result.files?.find((f) => f.name === "app-apply.yml");
  expect(plan, "one workflow file per Op").toBeDefined();
  expect(apply, "one workflow file per Op").toBeDefined();
  return { plan: plan!.yaml, apply: apply!.yaml };
}

describe("plan-on-pr generates the pull_request plan and push apply pair (#2221)", () => {
  it("discovers the example's own two Ops, and carries each one's trigger", async () => {
    const result = await generateOpsPipeline([PLAN_SPEC, APPLY_SPEC], "github", {}, planOnPrDir);
    expect(result.success).toBe(true);
    expect(result.jobs).toEqual([
      {
        jobName: "app-plan",
        op: "app-plan",
        trigger: { kind: "pull_request", branches: ["main"] },
        findingMode: "comment",
      },
      {
        jobName: "app-apply",
        op: "app-apply",
        trigger: { kind: "push", branches: ["main"] },
        findingMode: "report",
      },
    ]);
  });

  it("plans on pull_request, filtered to the default branch, with no manual dispatch", async () => {
    const { plan } = await planOnPrWorkflows();
    expect(plan).toContain("pull_request:");
    expect(plan).toContain("branches:");
    expect(plan).toContain("- main");
    // A PR event needs no manual escape hatch, and no cron reaches this half.
    expect(plan).not.toContain("workflow_dispatch");
    expect(plan).not.toContain("schedule:");
    expect(plan).not.toContain("push:");
  });

  it("applies on push to the default branch, and on nothing else", async () => {
    const { apply } = await planOnPrWorkflows();
    expect(apply).toContain("push:");
    expect(apply).toContain("- main");
    expect(apply).not.toContain("pull_request");
    expect(apply).not.toContain("workflow_dispatch");
    expect(apply).not.toContain("schedule:");
  });

  it("gives the PR job exactly contents: read, pull-requests: write and id-token: write (#2231, #2242)", async () => {
    const { plan } = await planOnPrWorkflows();
    // The least-privilege set a plan-on-PR job wants, and the set the
    // `comment` finding mode spends in full: it posts on the pull request the
    // run was triggered by and changes nothing in the repository. No `issues:
    // write`, because nothing opens an issue; no `contents: write`, because
    // nothing pushes a branch. `id-token: write` is the one scope the mode
    // did not compute, added by the spec so the run can mint an OIDC token
    // for the role it assumes. Parsed rather than string-matched, so this is
    // an exact set and not a containment check.
    const parsed = parseYAML(plan) as { permissions?: Record<string, string> };
    expect(parsed.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
      "id-token": "write",
    });
    expect(plan).not.toContain("write-all");
  });

  it("posts the plan as a comment on the triggering pull request, not as an issue (#2231)", async () => {
    const result = await build(join(planOnPrDir, "src"), [terraformSerializer]);
    expect(result.errors).toEqual([]);
    const planOp = result.entities.get("app-plan") as unknown as { props: OpConfig };
    const report = planOp.props.phases.find((p) => p.name === "Report");
    const step = report?.steps[0] as ActivityStep;
    expect(step.fn).toBe("reconcilePr");
    expect(step.args?.mode).toBe("comment");
    // The comment's URL is what the run ledger records for this Op.
    expect(step.outcomeAttribute).toEqual({ name: "Comment", from: "commentUrl" });
  });

  it("refuses the comment mode on the apply half's push trigger (#2231)", async () => {
    // The mode is tied to the trigger, not merely scoped by it: an Op that
    // posts on the pull request that triggered it has nothing to post on when
    // a push triggered it, and the generator says so by name rather than
    // emitting a job that fails at its Report step.
    await expect(
      generateOpsPipeline(
        [{ ...APPLY_SPEC, findingMode: "comment" }],
        "github",
        {},
        planOnPrDir,
      ),
    ).rejects.toThrow(/findingMode "comment".*trigger is "push"/s);
  });

  it("gives the apply job contents: read plus the OIDC token, and no forge write scope", async () => {
    const { apply } = await planOnPrWorkflows();
    // The apply talks to the provider and the state backend, never to the
    // forge, so a push run needs no forge write scope at all. What it does
    // need is the OIDC token it exchanges for the apply role (#2242), which
    // is additive over the `report` mode's read-only set rather than a
    // replacement for it.
    const parsed = parseYAML(apply) as { permissions?: Record<string, string> };
    expect(parsed.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(apply).not.toContain("issues: write");
    expect(apply).not.toContain("pull-requests: write");
    expect(apply).not.toContain("write-all");
  });

  it("assumes the AWS role by OIDC, after the checkout and before terraform (#2242)", async () => {
    const { plan, apply } = await planOnPrWorkflows();
    for (const [yaml, op, roleVariable] of [
      [plan, "app-plan", "AWS_PLAN_ROLE_ARN"],
      [apply, "app-apply", "AWS_APPLY_ROLE_ARN"],
    ] as const) {
      const doc = parseYAML(yaml) as {
        jobs: Record<string, { steps: Array<{ uses?: string; run?: string; with?: Record<string, string> }> }>;
      };
      const steps = doc.jobs[op].steps;
      // The whole order the shape depends on: check out the root, mint
      // credentials for it, install the CLI that will use them, run the Op.
      expect(steps.map((step) => step.uses ?? step.run?.slice(0, 5))).toEqual([
        "actions/checkout@v4",
        AWS_CREDENTIALS_ACTION,
        "curl ",
        "chant",
      ]);
      expect(steps[1].with).toEqual({
        "role-to-assume": `\${{ vars.${roleVariable} }}`,
        "aws-region": AWS_REGION,
      });
      // No static key anywhere: the credentials are the ones the action
      // exchanged the run's OIDC token for.
      expect(yaml).not.toContain("AWS_ACCESS_KEY_ID");
      expect(yaml).not.toContain("AWS_SECRET_ACCESS_KEY");
    }
  });

  it("installs the pinned terraform before running either Op", async () => {
    const { plan, apply } = await planOnPrWorkflows();
    for (const [yaml, op] of [
      [plan, "app-plan"],
      [apply, "app-apply"],
    ] as const) {
      expect(yaml).toContain(`releases.hashicorp.com/terraform/${TERRAFORM_VERSION}/`);
      expect(yaml).toContain("unzip -q -o /tmp/terraform.zip -d /usr/local/bin");
      expect(yaml.indexOf("/tmp/terraform.zip")).toBeLessThan(yaml.indexOf(`chant run ${op}`));
    }
  });

  it("runs each Op through `chant run`, with a token only where a finding is posted", async () => {
    const { plan, apply } = await planOnPrWorkflows();
    expect(plan).toContain("chant run app-plan");
    // The comment mode shells to `gh`, so it needs the CLI's own token
    // variable and not just the API one.
    expect(plan).toContain("GH_TOKEN:");
    expect(apply).toContain("chant run app-apply");
    // `report` mode posts nothing, so the `gh` CLI's own token variable is
    // not wired into the apply job.
    expect(apply).not.toContain("GH_TOKEN:");
  });

  it("keeps one run at a time per Op, which is also the state lock", async () => {
    const { plan, apply } = await planOnPrWorkflows();
    expect(plan).toContain("group: app-plan");
    expect(apply).toContain("group: app-apply");
    for (const yaml of [plan, apply]) expect(yaml).toContain("cancel-in-progress: false");
  });

  it("posts the -no-color plan and never the JSON one", async () => {
    // The sensitive-output rule from #2081, asserted where the example
    // declares it rather than only in the composite's own suite: the Report
    // step's body is one reference to the Plan step's `text`, and nothing in
    // its args mentions the `-json` render, which carries every attribute
    // value the plan touched.
    const result = await build(join(planOnPrDir, "src"), [terraformSerializer]);
    expect(result.errors).toEqual([]);
    const planOp = result.entities.get("app-plan") as unknown as { props: OpConfig };
    const report = planOp.props.phases.find((p) => p.name === "Report");
    const step = report?.steps[0] as ActivityStep;
    expect(step.fn).toBe("reconcilePr");
    expect(step.args?.mode).toBe("comment");
    expect(step.args?.body).toMatchObject({ kind: "step-output-ref", step: "plan", path: "text" });
    expect(JSON.stringify(step.args)).not.toContain("json");
  });

  it("applies only the plan its own Plan step saved", async () => {
    const result = await build(join(planOnPrDir, "src"), [terraformSerializer]);
    const applyOp = result.entities.get("app-apply") as unknown as { props: OpConfig };
    const names = applyOp.props.phases.map((p) => p.name);
    expect(names).toEqual(["Init", "Plan", "Gate", "Apply"]);
    const applyStep = applyOp.props.phases[3].steps[0] as ActivityStep;
    expect(applyStep.args?.planFile).toMatchObject({
      kind: "step-output-ref",
      step: "plan",
      path: "planFile",
    });
  });
});
