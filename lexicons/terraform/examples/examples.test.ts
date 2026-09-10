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

/**
 * The apply half additionally names a GitHub environment (#2257), which is
 * the forge-native half of the pair of gates this example ships: a required
 * reviewer on `production` holds the job before any step runs, and chant's
 * own gate holds the apply inside a run that already started. The plan half
 * names none — it deploys nothing, and putting a reviewer in front of a plan
 * on every pull request is the fastest way to teach people to click through
 * one.
 */
const APPLY_ENVIRONMENT = "production";

const APPLY_SPEC: ScheduledOpSpec = {
  name: "app-apply",
  trigger: { kind: "push", branches: ["main"] },
  setup: assumeRole("AWS_APPLY_ROLE_ARN"),
  permissions: { "id-token": "write" },
  environment: { name: APPLY_ENVIRONMENT },
};

/**
 * The same pair on GitLab (#2256). Two things differ from the github specs
 * above, and both are properties of the forge rather than of the example.
 *
 * The AWS auth is a shell line rather than a marketplace action, because
 * GitLab CI jobs run `script` and nothing else. It needs no AWS CLI either:
 * GitLab's `id_tokens:` puts the OIDC JWT in an environment variable, and the
 * AWS SDK inside the terraform provider does the `AssumeRoleWithWebIdentity`
 * exchange itself when it is handed `AWS_ROLE_ARN` and a
 * `AWS_WEB_IDENTITY_TOKEN_FILE` to read the token out of. Every `script` line
 * in a GitLab job runs in one shell, so an `export` on one line is still set
 * on the next — which is exactly what a GitHub Actions `run:` step cannot do,
 * and why the same setup is an action there.
 *
 * The role ARN is a plain `$AWS_PLAN_ROLE_ARN`, because a GitLab CI/CD
 * variable is already in the job's environment; there is no `${{ vars.X }}`
 * expression to interpolate at generation time.
 */
const GITLAB_TOKEN_FILE = "/tmp/chant-web-identity-token";

function assumeRoleOnGitlab(roleVariable: string): ScheduledOpSpec["setup"] {
  return [
    {
      run:
        `echo "$CHANT_ID_TOKEN" > ${GITLAB_TOKEN_FILE} && ` +
        `export AWS_ROLE_ARN="$${roleVariable}" ` +
        `AWS_WEB_IDENTITY_TOKEN_FILE=${GITLAB_TOKEN_FILE} ` +
        `AWS_REGION=${AWS_REGION}`,
    },
  ];
}

const GITLAB_PLAN_SPEC: ScheduledOpSpec = {
  name: "app-plan",
  trigger: { kind: "pull_request", branches: ["main"] },
  findingMode: "comment",
  setup: assumeRoleOnGitlab("AWS_PLAN_ROLE_ARN"),
  permissions: { "id-token": "write" },
};

const GITLAB_APPLY_SPEC: ScheduledOpSpec = {
  name: "app-apply",
  trigger: { kind: "push", branches: ["main"] },
  setup: assumeRoleOnGitlab("AWS_APPLY_ROLE_ARN"),
  permissions: { "id-token": "write" },
  environment: { name: APPLY_ENVIRONMENT },
};

/**
 * The GitLab generation is one document, not two: a GitHub trigger is
 * workflow-scoped, so each Op needs its own file, while a GitLab trigger is
 * job-scoped and both jobs live in one `.gitlab-ci.yml`.
 */
async function planOnPrGitlabPipeline(): Promise<string> {
  const result = await generateOpsPipeline(
    [GITLAB_PLAN_SPEC, GITLAB_APPLY_SPEC],
    "gitlab",
    { beforeScript: [INSTALL_TERRAFORM] },
    planOnPrDir,
  );
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  expect(result.files, "one document, both jobs").toHaveLength(1);
  return result.files![0].yaml;
}

/** One GitLab job, as much of it as this suite reads back. */
interface GitlabJob {
  stage: string;
  image: string;
  resource_group: string;
  rules: Array<{ if: string }>;
  script: string[];
  id_tokens?: Record<string, { aud: string }>;
  variables?: Record<string, string>;
  environment?: Record<string, string>;
  artifacts?: { when: string; paths: string[]; expire_in: string };
}

function gitlabJobs(yaml: string): Record<string, GitlabJob> {
  return parseYAML(yaml) as unknown as Record<string, GitlabJob>;
}

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

/** The shape of the emitted push workflow this suite reads back, field by field. */
interface WorkflowStep {
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}
interface WorkflowJob {
  needs?: string;
  if?: string;
  "runs-on"?: string;
  container?: string;
  environment?: Record<string, string>;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: WorkflowStep[];
}
interface PushWorkflow {
  permissions?: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

/** The emitted push workflow, read back. Cast through `unknown` in one place, since `parseYAML` answers `Record<string, unknown>`. */
function parsePush(yaml: string): PushWorkflow {
  return parseYAML(yaml) as unknown as PushWorkflow;
}

/** The apply job's `chant run` step — the last step that invokes the CLI. */
function runStep(workflow: PushWorkflow): WorkflowStep {
  const step = workflow.jobs["app-apply"].steps.find((s) => s.run?.includes("chant run app-apply"));
  expect(step, "the apply job runs the Op").toBeDefined();
  return step!;
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
    //
    // The workflow-level set is the apply job's: the notice job (#2243)
    // carries its own, which replaces this one for itself alone, so the two
    // forge write scopes in this file belong to that job and never to the
    // apply.
    const parsed = parsePush(apply);
    expect(parsed.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(parsed.jobs["app-apply"].permissions).toBeUndefined();
    expect(parsed.jobs["app-apply-gate-notice"].permissions).not.toHaveProperty("id-token");
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
      // The last step's shape differs by trigger — the push apply's is the
      // gated-apply script (#2243) rather than a bare line — so it is matched
      // on the invocation it carries rather than on its first five characters.
      expect(steps.slice(0, 3).map((step) => step.uses ?? step.run?.slice(0, 5))).toEqual([
        "actions/checkout@v4",
        AWS_CREDENTIALS_ACTION,
        "curl ",
      ]);
      expect(steps).toHaveLength(4);
      expect(steps[3].run).toContain(`chant run ${op}`);
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
    // `report` mode posts nothing, so the `gh` CLI's own token variable is not
    // wired into the apply job itself. The notice job beside it has one,
    // because that job is the thing that talks to the forge.
    const applyStep = runStep(parsePush(apply));
    expect(applyStep.env?.GH_TOKEN).toBeUndefined();
    expect(applyStep.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
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

  // ── The gated apply is a green run with a visible pending state (#2243) ──

  it("maps the gate's exit code on the push job and on nothing else", async () => {
    const { plan, apply } = await planOnPrWorkflows();
    // The push apply is the job a gate would otherwise paint red on every
    // merge, so it is the job that asks for the mapping.
    expect(runStep(parsePush(apply)).run).toContain("chant run app-apply --gated-exit 0 --json");
    // The pull-request plan is not: nobody is waiting on a merge for it, and a
    // gated plan there is a signal rather than noise.
    expect(plan).not.toContain("--gated-exit");
    expect(plan).toContain("chant run app-plan\n");
  });

  it("publishes what the apply stopped on as job outputs", async () => {
    const { apply } = await planOnPrWorkflows();
    const parsed = parsePush(apply);
    const step = runStep(parsed);
    expect(step.id).toBe("chant-run");
    expect(parsed.jobs["app-apply"].outputs).toEqual({
      gated: "${{ steps.chant-run.outputs.gated }}",
      op: "${{ steps.chant-run.outputs.op }}",
      gate: "${{ steps.chant-run.outputs.gate }}",
      approve: "${{ steps.chant-run.outputs.approve }}",
    });
    // A failing run piped into `tee` would come back as `tee`'s zero, so the
    // mechanism that keeps a broken apply red is asserted rather than assumed.
    // Since chant #2321 that is a POSIX status capture taken from inside the
    // pipe's first stage, not `set -o pipefail` — a container job's default
    // shell is `sh`, which rejects that option outright (chant #2299).
    expect(step.run).toContain('echo "$?" >"$status"');
    expect(step.run).toContain('[ "$code" -eq 0 ] || exit "$code"');
    expect(step.run).not.toContain("set -o pipefail");
  });

  it("adds one follow-up job that needs the apply and runs only when it gated", async () => {
    const { apply } = await planOnPrWorkflows();
    const parsed = parsePush(apply);
    const notice = parsed.jobs["app-apply-gate-notice"];
    expect(notice, "the push workflow carries the notice job").toBeDefined();
    expect(notice.needs).toBe("app-apply");
    expect(notice.if).toBe("needs.app-apply.outputs.gated == 'true'");
    // It needs `gh`, which a hosted runner image carries and `node:22-slim`
    // does not, so it runs outside the Op's container.
    expect(notice.container).toBeUndefined();
    expect(notice["runs-on"]).toBe("ubuntu-latest");
    expect(parsed.jobs["app-apply-gate-notice"].steps).toHaveLength(1);
  });

  it("gives the follow-up job the scopes its two posting paths need and nothing wider", async () => {
    const { apply } = await planOnPrWorkflows();
    const notice = (parsePush(apply)).jobs["app-apply-gate-notice"];
    // `contents: read` for the commit-to-pull-request lookup, `pull-requests:
    // write` for the sticky comment on the merged PR, `issues: write` for the
    // fallback when the push has no pull request. No `contents: write`: the
    // job pushes no branch, and it is a job-level set, so the apply beside it
    // keeps its own `contents: read`.
    expect(notice.permissions).toEqual({
      contents: "read",
      issues: "write",
      "pull-requests": "write",
    });
  });

  it("finds the merged pull request from the pushed commit, and opens an issue when there is none", async () => {
    const { apply } = await planOnPrWorkflows();
    const script = (parsePush(apply)).jobs["app-apply-gate-notice"].steps[0].run ?? "";
    // The commit's own associated-pull-request endpoint, not a search: a push
    // event carries no pull request, and the merge commit's is exact.
    expect(script).toContain('gh api "$api_base/repos/$GITHUB_REPOSITORY/commits/$GITHUB_SHA/pulls"');
    // The `comment` mode's marker recipe (#2231): find by marker, PATCH when
    // it is there, POST when it is not, so re-merges edit one comment.
    expect(script).toContain('marker="<!-- chant-gate:$CHANT_OP -->"');
    expect(script).toContain("startswith");
    expect(script).toContain("--method PATCH");
    expect(script).toContain("--method POST");
    // No pull request, so the finding goes where a finding without one goes.
    expect(script).toContain("gh issue create");
    // The body carries the exact command that clears the gate, which the
    // apply job handed over as an output rather than the notice reassembling
    // it from the op and gate names.
    expect(script).toContain("%s --approver <you>");
    expect(script).toContain('"$CHANT_APPROVE"');
  });

  // ── The forge-native gate beside chant's own (#2257) ────────────────────

  it("puts the apply job behind a GitHub environment, and the plan job behind none", async () => {
    const { plan, apply } = await planOnPrWorkflows();
    const parsed = parsePush(apply);
    expect(parsed.jobs["app-apply"].environment).toEqual({ name: APPLY_ENVIRONMENT });
    // A required reviewer on `production` holds the apply before its first
    // step. The plan deploys nothing, so it names no environment at all.
    expect(plan).not.toContain("environment:");
  });

  it("does not hold the pending-gate notice behind the same reviewer", async () => {
    // The notice job says a chant gate is waiting. Behind the environment it
    // would only be readable once somebody had already released the job it
    // reports on.
    const { apply } = await planOnPrWorkflows();
    expect(parsePush(apply).jobs["app-apply-gate-notice"].environment).toBeUndefined();
  });

  it("buys the environment gate with no extra token scope", async () => {
    // Environment protection is repository configuration — the reviewer lives
    // on the environment object, not on GITHUB_TOKEN — so the apply's
    // permission set is what it was before the environment was named.
    const { apply } = await planOnPrWorkflows();
    const parsed = parsePush(apply);
    expect(parsed.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(parsed.permissions).not.toHaveProperty("deployments");
  });

  it("keeps chant's own gate in the run: the two gates compose, neither replaces the other", async () => {
    // The environment reviewer stops the job before it starts; the gate below
    // stops the apply inside a run that already started, on a fact recorded on
    // the chant/lifecycle branch. Both are present in this example on purpose.
    const { apply } = await planOnPrWorkflows();
    expect(runStep(parsePush(apply)).run).toContain("chant run app-apply --gated-exit 0 --json");
    const result = await build(join(planOnPrDir, "src"), [terraformSerializer]);
    const applyOp = result.entities.get("app-apply") as unknown as { props: OpConfig };
    expect(applyOp.props.phases.map((p) => p.name)).toContain("Gate");
  });

  // ── The same pair on GitLab (#2256) ────────────────────────────────────

  it("plans on a merge request and applies on a push, both in one document", async () => {
    const jobs = gitlabJobs(await planOnPrGitlabPipeline());
    // The branch filter maps onto the branch the merge request would merge
    // INTO, which is what github's `on.pull_request.branches` filters on too.
    expect(jobs["app-plan"].rules).toEqual([
      {
        if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "main"',
      },
    ]);
    expect(jobs["app-apply"].rules).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"' },
    ]);
    // One run at a time per Op, which on the apply is also the state lock.
    expect(jobs["app-plan"].resource_group).toBe("app-plan");
    expect(jobs["app-apply"].resource_group).toBe("app-apply");
  });

  it("posts the plan as a merge-request note, and refuses the mode where there is no merge request", async () => {
    const result = await generateOpsPipeline(
      [GITLAB_PLAN_SPEC, GITLAB_APPLY_SPEC],
      "gitlab",
      {},
      planOnPrDir,
    );
    expect(result.jobs?.[0]).toEqual({
      jobName: "app-plan",
      op: "app-plan",
      trigger: { kind: "pull_request", branches: ["main"] },
      findingMode: "comment",
    });
    // The Op is the same one github runs: one `reconcilePr` step in `comment`
    // mode, which writes a merge-request note when the run is a
    // merge_request_event pipeline. Nothing about the Op is forge-specific —
    // the trigger is.
    const built = await build(join(planOnPrDir, "src"), [terraformSerializer]);
    const planOp = built.entities.get("app-plan") as unknown as { props: OpConfig };
    const step = planOp.props.phases.find((p) => p.name === "Report")?.steps[0] as ActivityStep;
    expect(step.fn).toBe("reconcilePr");
    expect(step.args?.mode).toBe("comment");
    // And the mode is still tied to the trigger, on GitLab as on GitHub: a
    // push pipeline has no merge request to post on.
    await expect(
      generateOpsPipeline(
        [{ ...GITLAB_APPLY_SPEC, findingMode: "comment" }],
        "gitlab",
        {},
        planOnPrDir,
      ),
    ).rejects.toThrow(/findingMode "comment".*trigger is "push"/s);
  });

  it("mints the OIDC token through id_tokens, and stores no static key", async () => {
    const yaml = await planOnPrGitlabPipeline();
    const jobs = gitlabJobs(yaml);
    for (const [op, roleVariable] of [
      ["app-plan", "AWS_PLAN_ROLE_ARN"],
      ["app-apply", "AWS_APPLY_ROLE_ARN"],
    ] as const) {
      // GitLab's own OIDC surface, which is what the spec's `id-token: write`
      // becomes here — there is no `permissions:` block to put it in.
      expect(jobs[op].id_tokens).toEqual({ CHANT_ID_TOKEN: { aud: "$CI_SERVER_URL" } });
      // Setup first, then the terraform install, then the Op.
      expect(jobs[op].script[0]).toContain(`AWS_ROLE_ARN="$${roleVariable}"`);
      expect(jobs[op].script[0]).toContain(GITLAB_TOKEN_FILE);
      expect(jobs[op].script[1]).toContain("/tmp/terraform.zip");
      expect(jobs[op].script[2]).toContain(`chant run ${op}`);
    }
    // The credentials are the ones the provider's own SDK exchanged the token
    // for; nothing durable is stored on the project.
    expect(yaml).not.toContain("AWS_ACCESS_KEY_ID");
    expect(yaml).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("has no permissions: block at all, and says where the note's write access comes from", async () => {
    const yaml = await planOnPrGitlabPipeline();
    // GitLab has no per-job token-scope mapping, so the whole github
    // permission surface is absent rather than approximated. What the comment
    // mode spends is a project CI/CD variable, which the header names.
    expect(parseYAML(yaml)).not.toHaveProperty("permissions");
    expect(yaml).not.toContain("pull-requests:");
    expect(yaml).toContain("GITLAB_TOKEN");
    // And a scope that has no GitLab meaning is refused rather than dropped.
    await expect(
      generateOpsPipeline(
        [{ ...GITLAB_PLAN_SPEC, permissions: { "id-token": "write", issues: "write" } }],
        "gitlab",
        {},
        planOnPrDir,
      ),
    ).rejects.toThrow(/no per-job token-scope mapping/);
  });

  it("keeps a gated apply green, with the pending gate in the log and in an artifact", async () => {
    const jobs = gitlabJobs(await planOnPrGitlabPipeline());
    const apply = jobs["app-apply"];
    // The same one mapped outcome github's push job gets. No `--json`: the
    // human render of the gate is the job log, which is one of GitLab's two
    // surfaces for it.
    expect(apply.script.at(-1)).toBe("chant run app-apply --gated-exit 0");
    // The other surface. Core writes the pending block to whatever
    // CHANT_GATE_SUMMARY names, and the job publishes that path.
    expect(apply.variables?.CHANT_GATE_SUMMARY).toBe("chant-gate-app-apply.md");
    expect(apply.artifacts?.paths).toEqual(["chant-gate-app-apply.md"]);
    expect(apply.artifacts?.when).toBe("always");
    // The plan half is not gated: nobody is waiting on a merge for it.
    expect(jobs["app-plan"].script.at(-1)).toBe("chant run app-plan");
    expect(jobs["app-plan"].artifacts).toBeUndefined();
  });

  it("puts the apply behind a GitLab environment too, and the plan behind none (#2257)", async () => {
    const jobs = gitlabJobs(await planOnPrGitlabPipeline());
    expect(jobs["app-apply"].environment).toEqual({ name: APPLY_ENVIRONMENT });
    expect(jobs["app-plan"].environment).toBeUndefined();
  });

  it("refuses the github marketplace action rather than dropping it", async () => {
    // The github specs' `uses:` setup step has no GitLab shape at all, which
    // is why this example carries a second setup list rather than one.
    await expect(
      generateOpsPipeline([PLAN_SPEC], "gitlab", {}, planOnPrDir),
    ).rejects.toThrow(/is `uses: "aws-actions\/configure-aws-credentials@v6"`/);
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
