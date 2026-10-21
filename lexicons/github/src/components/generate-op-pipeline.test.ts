/**
 * Tests for generate mode's scheduled Op → GitHub Actions workflow YAML
 * synthesis (#927). Mirrors `./generate-pipeline.test.ts`'s style:
 *
 *  1. Each `ScheduledOpSpec` produces its own structurally valid workflow
 *     (parses back via `../yaml.ts`'s `parseYAML`) with a `schedule` +
 *     `workflow_dispatch` trigger and one job.
 *  2. `permissions:` is least-privilege per finding-mode — read-only for
 *     `report`, scoped write for `issue`/`comment`/`pull-request`.
 *  3. A cross-cutting generator change (extraScript/beforeScript/runCommand)
 *     is a single edit reflected in every generated file.
 */

import { readFileSync } from "node:fs";
import { describe, test, expect } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpPipeline } from "./generate-op-pipeline";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";

interface ParsedStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
}

interface ParsedJob {
  "runs-on"?: string;
  container?: string;
  environment?: Record<string, string>;
  needs?: string;
  if?: string;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  steps: ParsedStep[];
}

interface ParsedDoc {
  on?: Record<string, unknown>;
  concurrency?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, ParsedJob>;
}

function parseFile(yaml: string): ParsedDoc {
  return parseYAML(yaml) as ParsedDoc;
}

describe("generateGithubOpPipeline: one file per scheduled Op", () => {
  test("each spec produces its own workflow with a schedule + workflow_dispatch trigger", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "actions-audit", schedule: "0 6 * * *" },
      { name: "prod-reconcile", schedule: "0 * * * *", findingMode: "pull-request" },
    ];
    const result = generateGithubOpPipeline(specs);

    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.name)).toEqual(["actions-audit.yml", "prod-reconcile.yml"]);

    const auditDoc = parseFile(result.files[0].yaml);
    expect(auditDoc.on).toEqual({ schedule: [{ cron: "0 6 * * *" }], workflow_dispatch: {} });

    const reconcileDoc = parseFile(result.files[1].yaml);
    expect(reconcileDoc.on).toEqual({ schedule: [{ cron: "0 * * * *" }], workflow_dispatch: {} });
  });

  test("each file's single job runs `chant run <name>` and starts with a checkout step", () => {
    const result = generateGithubOpPipeline([{ name: "actions-audit", schedule: "0 6 * * *" }]);
    const doc = parseFile(result.files[0].yaml);
    const job = doc.jobs!["actions-audit"];

    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.steps[0].uses).toBe("actions/checkout@v7");
    const runStep = job.steps.find((s) => typeof s.run === "string")!;
    expect(runStep.run).toBe("chant run actions-audit");
  });

  test("an op-name job id is normalized the same way the component generator does", () => {
    const result = generateGithubOpPipeline([{ name: "cost-observe", schedule: "0 0 * * *" }]);
    expect(result.jobs[0].jobName).toBe("cost-observe");
  });
});

describe("generateGithubOpPipeline: least-privilege permissions per finding-mode", () => {
  test("report needs no write access", () => {
    const result = generateGithubOpPipeline([{ name: "actions-audit", schedule: "0 6 * * *", findingMode: "report" }]);
    const doc = parseFile(result.files[0].yaml);
    expect(doc.permissions).toEqual({ contents: "read" });

    const runStep = doc.jobs!["actions-audit"].steps.find((s) => typeof s.run === "string")!;
    expect(runStep.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
  });

  test("issue mode adds issues: write and the gh CLI token", () => {
    const result = generateGithubOpPipeline([{ name: "actions-audit", schedule: "0 6 * * *", findingMode: "issue" }]);
    const doc = parseFile(result.files[0].yaml);
    expect(doc.permissions).toEqual({ contents: "read", issues: "write" });

    const runStep = doc.jobs!["actions-audit"].steps.find((s) => typeof s.run === "string")!;
    expect(runStep.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}", GH_TOKEN: "${{ github.token }}" });
  });

  test("pull-request mode grants contents + pull-requests write, not issues", () => {
    const result = generateGithubOpPipeline([{ name: "prod-reconcile", schedule: "0 * * * *", findingMode: "pull-request" }]);
    const doc = parseFile(result.files[0].yaml);
    expect(doc.permissions).toEqual({ contents: "write", "pull-requests": "write" });
  });

  test("comment mode is exactly contents: read + pull-requests: write (#2231)", () => {
    // The least-privilege set a plan-on-PR job wants, and the one no mode
    // could produce before this one existed: `issue` adds `issues: write`,
    // `pull-request` widens `contents` to write, `report` gets no forge write
    // scope at all. `toEqual` is what makes this an exact set rather than a
    // containment check.
    const result = generateGithubOpPipeline([
      { name: "app-plan", trigger: { kind: "pull_request", branches: ["main"] }, findingMode: "comment" },
    ]);
    const doc = parseFile(result.files[0].yaml);
    expect(doc.permissions).toEqual({ contents: "read", "pull-requests": "write" });

    // The activity shells to `gh`, so the CLI's own token variable rides too.
    const runStep = doc.jobs!["app-plan"].steps.find((s) => typeof s.run === "string")!;
    expect(runStep.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}", GH_TOKEN: "${{ github.token }}" });
  });

  test("defaults to report (read-only) when findingMode is omitted", () => {
    const result = generateGithubOpPipeline([{ name: "actions-audit", schedule: "0 6 * * *" }]);
    expect(result.jobs[0].findingMode).toBe("report");
    const doc = parseFile(result.files[0].yaml);
    expect(doc.permissions).toEqual({ contents: "read" });
  });
});

describe("generateGithubOpPipeline: trigger kinds (#2084)", () => {
  test("a legacy `{ schedule }` spec with no `trigger` is unchanged", () => {
    const specs: ScheduledOpSpec[] = [{ name: "actions-audit", schedule: "0 6 * * *", findingMode: "issue" }];
    const result = generateGithubOpPipeline(specs);
    const doc = parseFile(result.files[0].yaml);

    expect(doc.on).toEqual({ schedule: [{ cron: "0 6 * * *" }], workflow_dispatch: {} });
    expect(doc.permissions).toEqual({ contents: "read", issues: "write" });
    expect(result.jobs[0].trigger).toEqual({ kind: "cron", schedule: "0 6 * * *" });
  });

  test("pull_request trigger: filters to branches, has no workflow_dispatch", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "tf-plan", trigger: { kind: "pull_request", branches: ["main"] } },
    ];
    const result = generateGithubOpPipeline(specs);
    const doc = parseFile(result.files[0].yaml);

    expect(doc.on).toEqual({ pull_request: { branches: ["main"] } });
    expect(doc.on).not.toHaveProperty("workflow_dispatch");
    expect(result.jobs[0].trigger).toEqual({ kind: "pull_request", branches: ["main"] });
  });

  test("pull_request trigger with no branches filter triggers on every PR", () => {
    const result = generateGithubOpPipeline([{ name: "tf-plan", trigger: { kind: "pull_request" } }]);
    const doc = parseFile(result.files[0].yaml);
    expect(doc.on).toEqual({ pull_request: {} });
  });

  test("pull_request trigger with a comment-posting finding mode gets pull-requests: write", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "tf-plan", trigger: { kind: "pull_request" }, findingMode: "issue" },
    ];
    const result = generateGithubOpPipeline(specs);
    const doc = parseFile(result.files[0].yaml);
    expect(doc.permissions).toEqual({ contents: "read", issues: "write", "pull-requests": "write" });
  });

  test("pull_request trigger stays read-only when findingMode is report", () => {
    const result = generateGithubOpPipeline([{ name: "tf-plan", trigger: { kind: "pull_request" } }]);
    const doc = parseFile(result.files[0].yaml);
    expect(doc.permissions).toEqual({ contents: "read" });
  });

  test("comment mode is refused by name on a cron trigger (#2231)", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "app-plan", schedule: "0 6 * * *", findingMode: "comment" },
    ];
    expect(() => generateGithubOpPipeline(specs)).toThrow(
      /findingMode "comment".*trigger is "cron".*no pull request/s,
    );
  });

  test("comment mode is refused by name on a push trigger (#2231)", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "app-apply", trigger: { kind: "push", branches: ["main"] }, findingMode: "comment" },
    ];
    expect(() => generateGithubOpPipeline(specs)).toThrow(
      /Scheduled Op "app-apply".*findingMode "comment".*trigger is "push"/s,
    );
  });

  test("push trigger: filters to branches", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "tf-apply", trigger: { kind: "push", branches: ["release"] } },
    ];
    const result = generateGithubOpPipeline(specs);
    const doc = parseFile(result.files[0].yaml);

    expect(doc.on).toEqual({ push: { branches: ["release"] } });
    expect(doc.on).not.toHaveProperty("workflow_dispatch");
    expect(result.jobs[0].trigger).toEqual({ kind: "push", branches: ["release"] });
  });

  test("a push trigger's build (#4169): newest runs at build request tags and by hand, one group per ref; every, one group per commit", () => {
    const newest = parseFile(generateGithubOpPipeline([{ name: "suites", trigger: { kind: "push", build: "newest" } }]).files[0].yaml);
    expect(newest.on).toEqual({ push: { branches: ["main"], tags: ["ci/build/**"] }, workflow_dispatch: {} });
    expect(newest.concurrency).toEqual({ group: "suites-${{ github.ref }}", "cancel-in-progress": false });
    const every = parseFile(generateGithubOpPipeline([{ name: "suites", trigger: { kind: "push", build: "every" } }]).files[0].yaml);
    expect(every.on).toEqual({ push: { branches: ["main"] } });
    expect(every.concurrency).toEqual({ group: "suites-${{ github.sha }}", "cancel-in-progress": false });
    const plain = parseFile(generateGithubOpPipeline([{ name: "suites", trigger: { kind: "push" } }]).files[0].yaml);
    expect(plain.concurrency).toEqual({ group: "suites", "cancel-in-progress": false });
  });

  test("push trigger defaults to the repository default branch (main) when branches is omitted", () => {
    const result = generateGithubOpPipeline([{ name: "tf-apply", trigger: { kind: "push" } }]);
    const doc = parseFile(result.files[0].yaml);
    expect(doc.on).toEqual({ push: { branches: ["main"] } });
  });

  test("push trigger is read-only by default", () => {
    const result = generateGithubOpPipeline([{ name: "tf-apply", trigger: { kind: "push" } }]);
    const doc = parseFile(result.files[0].yaml);
    expect(doc.permissions).toEqual({ contents: "read" });
  });

  test("push trigger honors an elevated findingMode, same as cron", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "tf-apply", trigger: { kind: "push" }, findingMode: "pull-request" },
    ];
    const result = generateGithubOpPipeline(specs);
    const doc = parseFile(result.files[0].yaml);
    expect(doc.permissions).toEqual({ contents: "write", "pull-requests": "write" });
  });
});

describe("generateGithubOpPipeline: concurrency guards against overlapping runs", () => {
  test("each file's concurrency group is scoped to its own job", () => {
    const result = generateGithubOpPipeline([{ name: "actions-audit", schedule: "0 6 * * *" }]);
    const doc = parseFile(result.files[0].yaml);
    expect(doc.concurrency).toEqual({ group: "actions-audit", "cancel-in-progress": false });
  });
});

describe("generateGithubOpPipeline: a cross-cutting change is one generator edit, not per-file", () => {
  test("extraScript/beforeScript/runCommand apply uniformly across every generated file", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "actions-audit", schedule: "0 6 * * *" },
      { name: "prod-reconcile", schedule: "0 * * * *" },
    ];
    const result = generateGithubOpPipeline(specs, {
      runCommand: ["chant", "run", "{name}", "--json"],
      beforeScript: ["npm ci"],
      extraScript: ["echo done"],
    });

    for (const file of result.files) {
      const doc = parseFile(file.yaml);
      const jobName = Object.keys(doc.jobs!)[0];
      const runLines = doc.jobs![jobName].steps.filter((s) => typeof s.run === "string").map((s) => s.run as string);
      expect(runLines[0]).toBe("npm ci");
      expect(runLines[1]).toContain("--json");
      expect(runLines[2]).toBe("echo done");
    }
  });

  test("an empty Op set produces no files", () => {
    const result = generateGithubOpPipeline([]);
    expect(result.files).toEqual([]);
    expect(result.jobs).toEqual([]);
  });
});

describe("generateGithubOpPipeline: the Op's own schedule (#2120)", () => {
  test("an Op that declares its cadence needs no cron on the spec — opSchedule supplies it", () => {
    const specs: ScheduledOpSpec[] = [{ name: "prod-watch", opSchedule: { cron: "*/10 * * * *", overlap: "skip" } }];
    const result = generateGithubOpPipeline(specs);
    const doc = parseFile(result.files[0].yaml);

    expect(doc.on).toEqual({ schedule: [{ cron: "*/10 * * * *" }], workflow_dispatch: {} });
    expect(result.jobs[0].trigger).toEqual({ kind: "cron", schedule: "*/10 * * * *" });
  });

  test("an explicit spec `schedule` still wins over the Op's own", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "prod-watch", schedule: "0 6 * * *", opSchedule: { cron: "*/10 * * * *" } },
    ];
    const doc = parseFile(generateGithubOpPipeline(specs).files[0].yaml);
    expect(doc.on).toEqual({ schedule: [{ cron: "0 6 * * *" }], workflow_dispatch: {} });
  });

  test("an explicit `trigger` overrides the Op's own cadence entirely", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "tf-plan", trigger: { kind: "pull_request" }, opSchedule: { cron: "*/10 * * * *" } },
    ];
    const result = generateGithubOpPipeline(specs);
    const doc = parseFile(result.files[0].yaml);
    expect(doc.on).toEqual({ pull_request: {} });
    expect(result.jobs[0].trigger).toEqual({ kind: "pull_request" });
  });

  test("an Op with no cadence anywhere is still an error naming the Op", () => {
    expect(() => generateGithubOpPipeline([{ name: "no-cadence" }])).toThrow(
      /Scheduled Op "no-cadence" has neither/,
    );
  });
});

/**
 * The two per-Op options from #2242: `setup` steps between the checkout and
 * the `beforeScript` lines, and `permissions` merged additively over the
 * finding-mode's own set. Together they are what makes an OIDC job
 * expressible — `aws-actions/configure-aws-credentials` is a `uses:` step,
 * and no finding-mode grants `id-token: write`.
 */
describe("generateGithubOpPipeline: setup steps and additive permissions (#2242)", () => {
  const OIDC_SPEC: ScheduledOpSpec = {
    name: "app-apply",
    trigger: { kind: "push", branches: ["main"] },
    setup: [
      {
        uses: "aws-actions/configure-aws-credentials@v6",
        with: { "role-to-assume": "${{ vars.AWS_ROLE_ARN }}", "aws-region": "eu-west-1" },
      },
    ],
    permissions: { "id-token": "write" },
  };

  test("emits the action between the checkout and the beforeScript install", () => {
    const result = generateGithubOpPipeline([OIDC_SPEC], { beforeScript: ["install terraform"] });
    const doc = parseFile(result.files[0].yaml);
    const steps = doc.jobs!["app-apply"].steps;

    expect(steps.slice(0, 3).map((s) => s.uses ?? s.run)).toEqual([
      "actions/checkout@v7",
      "aws-actions/configure-aws-credentials@v6",
      "install terraform",
    ]);
    // The last step is the invocation. This spec's trigger is `push`, so it
    // is the gated-apply script rather than a bare line (#2243); what this
    // test owns is that the setup action lands between the checkout and the
    // `beforeScript` install, whatever shape the invocation takes.
    expect(steps).toHaveLength(4);
    expect(steps[3].run).toContain("chant run app-apply");
    expect((steps[1] as { with?: Record<string, string> }).with).toEqual({
      "role-to-assume": "${{ vars.AWS_ROLE_ARN }}",
      "aws-region": "eu-west-1",
    });
  });

  test("adds id-token: write to the mode's own set without replacing it", () => {
    const doc = parseFile(generateGithubOpPipeline([OIDC_SPEC]).files[0].yaml);
    expect(doc.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  test("carries a setup step's own `env` and emits a `run` entry as a plain step", () => {
    const specs: ScheduledOpSpec[] = [
      {
        name: "app-apply",
        schedule: "0 6 * * *",
        setup: [{ run: "aws sts get-caller-identity", env: { AWS_REGION: "eu-west-1" } }],
      },
    ];
    const steps = parseFile(generateGithubOpPipeline(specs).files[0].yaml).jobs!["app-apply"].steps;
    expect(steps[1]).toEqual({ run: "aws sts get-caller-identity", env: { AWS_REGION: "eu-west-1" } });
  });

  test("refuses an action pinned to its own default branch", () => {
    expect(() =>
      generateGithubOpPipeline([{ ...OIDC_SPEC, setup: [{ uses: "aws-actions/configure-aws-credentials@main" }] }]),
    ).toThrow(/setup step 1 pins .* to "main", the action repository's own default branch/s);
  });

  test("refuses an action with no ref at all", () => {
    expect(() =>
      generateGithubOpPipeline([{ ...OIDC_SPEC, setup: [{ uses: "aws-actions/configure-aws-credentials" }] }]),
    ).toThrow(/is not a pinned action reference/);
  });

  test("accepts a subpath ref and a commit sha", () => {
    const specs: ScheduledOpSpec[] = [
      {
        name: "app-apply",
        schedule: "0 6 * * *",
        setup: [
          { uses: "github/codeql-action/upload-sarif@v4" },
          { uses: "aws-actions/configure-aws-credentials@0e613a0980cbf65ed5b322eb7a1e075d28913a83" },
        ],
      },
    ];
    const steps = parseFile(generateGithubOpPipeline(specs).files[0].yaml).jobs!["app-apply"].steps;
    expect(steps.map((s) => s.uses).filter(Boolean)).toEqual([
      "actions/checkout@v7",
      "github/codeql-action/upload-sarif@v4",
      "aws-actions/configure-aws-credentials@0e613a0980cbf65ed5b322eb7a1e075d28913a83",
    ]);
  });

  test("refuses a blanket write-all", () => {
    expect(() =>
      generateGithubOpPipeline([{ ...OIDC_SPEC, permissions: { "write-all": "write" } }]),
    ).toThrow(/a blanket grant/);
  });

  test("refuses widening a scope the finding-mode already grants", () => {
    expect(() =>
      generateGithubOpPipeline([
        { name: "prod-reconcile", schedule: "0 * * * *", findingMode: "issue", permissions: { issues: "write" } },
      ]),
    ).toThrow(/its finding-mode already grants "issues: write"/);
  });

  test("refuses downgrading a scope the finding-mode already grants", () => {
    expect(() =>
      generateGithubOpPipeline([
        {
          name: "prod-reconcile",
          schedule: "0 * * * *",
          findingMode: "pull-request",
          permissions: { contents: "read" },
        },
      ]),
    ).toThrow(/its finding-mode already grants "contents: write"/);
  });

  test("refuses a scope name GitHub does not define, which it would silently ignore", () => {
    expect(() => generateGithubOpPipeline([{ ...OIDC_SPEC, permissions: { id_token: "write" } }])).toThrow(
      /not a GITHUB_TOKEN permission scope/,
    );
  });

  test("refuses pull-requests: write on a trigger that has no pull request", () => {
    expect(() =>
      generateGithubOpPipeline([{ ...OIDC_SPEC, permissions: { "pull-requests": "write" } }]),
    ).toThrow(/trigger is "push", which carries no pull request/);
  });

  test("allows id-token: write beside the comment mode's own pull-request scope", () => {
    const doc = parseFile(
      generateGithubOpPipeline([
        {
          name: "app-plan",
          trigger: { kind: "pull_request", branches: ["main"] },
          findingMode: "comment",
          permissions: { "id-token": "write" },
        },
      ]).files[0].yaml,
    );
    expect(doc.permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
      "id-token": "write",
    });
  });
});

/**
 * chant #2243 — a `push` job whose Op gates would otherwise be a red workflow
 * run on every merge until someone approves. The mapping is `chant run`'s own
 * (`--gated-exit 0`); what the generator adds is asking for it on the one
 * trigger that needs it, and a job that says where the approval is pending.
 */
describe("generateGithubOpPipeline: the gated apply on push (#2243)", () => {
  const pushSpec: ScheduledOpSpec = { name: "app-apply", trigger: { kind: "push", branches: ["main"] } };

  function pushDoc(): ParsedDoc {
    return parseFile(generateGithubOpPipeline([pushSpec]).files[0].yaml);
  }

  test("a push job runs with --gated-exit 0 and publishes what it stopped on", () => {
    const doc = pushDoc();
    const job = doc.jobs!["app-apply"];
    const step = job.steps.find((s) => s.id === "chant-run");
    expect(step?.run).toContain("chant run app-apply --gated-exit 0 --json");
    expect(job.outputs).toEqual({
      gated: "${{ steps.chant-run.outputs.gated }}",
      op: "${{ steps.chant-run.outputs.op }}",
      gate: "${{ steps.chant-run.outputs.gate }}",
      approve: "${{ steps.chant-run.outputs.approve }}",
    });
  });

  test("a cron watch and a pull_request plan keep the plain one-line invocation", () => {
    for (const spec of [
      { name: "app-watch", schedule: "0 6 * * *" },
      { name: "app-plan", trigger: { kind: "pull_request" as const } },
    ] satisfies ScheduledOpSpec[]) {
      const doc = parseFile(generateGithubOpPipeline([spec]).files[0].yaml);
      const job = doc.jobs![spec.name];
      expect(job.steps.some((s) => s.run?.includes("--gated-exit"))).toBe(false);
      expect(job.outputs).toBeUndefined();
      expect(doc.jobs![`${spec.name}-gate-notice`]).toBeUndefined();
    }
  });

  test("the notice job needs the apply, runs only on gated, and posts outside the log", () => {
    const notice = pushDoc().jobs!["app-apply-gate-notice"];
    expect(notice.needs).toBe("app-apply");
    expect(notice.if).toBe("needs.app-apply.outputs.gated == 'true'");
    // The Op's own image, which has node and npm, rather than gh on a hosted
    // runner image (#3773).
    expect(notice.container).toBe("node:22");
    const script = notice.steps[0].run ?? "";
    expect(script).toContain('import { forgeClient, forgeTargetFromEnv } from "@intentius/chant/pr-forge";');
    expect(script).toContain('const marker = "<!-- chant-gate:" + op + " -->";');
    expect(script).toContain("forge.pullRequestFor(target.sha)");
    expect(script).toContain("forge.upsertNote(pr, marker, body)");
    expect(script).toContain('forge.upsertIssue(marker, op + " is waiting on gate " + gate, body)');
    expect(script).toContain("node --import tsx notice.mjs");
  });

  // #3773 (and #3780 for its `gh issue create`): no `gh` call is left to
  // default to github.com on a GHES or Forgejo host. The forge, the REST base
  // and the host come from the job's environment through pr-forge.
  test("the notice job runs no gh at all", () => {
    const notice = pushDoc().jobs!["app-apply-gate-notice"];
    expect(notice.steps[0].run ?? "").not.toMatch(/(^|\s)gh\s/m);
    const env = notice.steps[0].env ?? {};
    expect(env.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(env).not.toHaveProperty("GH_REPO");
  });

  test("the notice job installs the chant release this lexicon was generated with", () => {
    const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    const script = pushDoc().jobs!["app-apply-gate-notice"].steps[0].run ?? "";
    expect(script).toContain(`npm install --omit=peer --no-audit --no-fund --loglevel=error @intentius/chant@${version}`);
  });

  test("the notice job runs in options.image when one is given", () => {
    const doc = parseFile(generateGithubOpPipeline([pushSpec], { image: "registry.example/node:22" }).files[0].yaml);
    expect(doc.jobs!["app-apply-gate-notice"].container).toBe("registry.example/node:22");
  });

  test("the notice job's permissions are its two posting paths and the lookup", () => {
    const notice = pushDoc().jobs!["app-apply-gate-notice"];
    expect(notice.permissions).toEqual({
      contents: "read",
      issues: "write",
      "pull-requests": "write",
    });
    // Job-level, so the apply beside it keeps the workflow's own read-only set.
    expect(pushDoc().permissions).toEqual({ contents: "read" });
    expect(pushDoc().jobs!["app-apply"].permissions).toBeUndefined();
  });

  test("a failing run stays a failing job: the pipe cannot swallow its exit code", () => {
    const step = pushDoc().jobs!["app-apply"].steps.find((s) => s.id === "chant-run");
    expect(step?.run).toContain(
      '{ chant run app-apply --gated-exit 0 --json; echo "$?" >"$status"; } | tee "$json"',
    );
    expect(step?.run).toContain('code=$(cat "$status")');
    expect(step?.run).toContain('[ "$code" -eq 0 ] || exit "$code"');
  });

  /**
   * chant #2299 — every Op job carries `container:` (this generator sets one
   * unconditionally, default `node:22`), and a container job's default
   * shell on GitHub Actions is `sh`, not bash. `sh` rejects `set -o pipefail`
   * outright (`Illegal option -o pipefail`) and fails the step before `chant`
   * is ever reached, which is exactly what happened on a real run (choudoufu
   * #1026, run 34312967579). The exit-code capture above needs neither
   * `pipefail` nor a `shell:` override to survive that — it is plain POSIX
   * `sh`, so the default shell a `container:` job gets already runs it.
   */
  test("the run step needs no shell override — its script is POSIX sh, not bash (#2299)", () => {
    const doc = pushDoc();
    const job = doc.jobs!["app-apply"];
    expect(job.container).toBe("node:22");
    const step = job.steps.find((s) => s.id === "chant-run");
    expect(step?.shell).toBeUndefined();
    expect(step?.run).not.toContain("pipefail");
  });

  /**
   * chant #2321 — #2307 fixed #2299 by pairing the `pipefail` line with an
   * unconditional `shell: "bash"` on this step, which then broke every
   * consumer whose `options.image` has no bash on it at all (alpine,
   * distroless, …): `shell: bash` on such an image fails with `bash: not
   * found` before `chant` is ever reached, a failure busybox `ash` never had
   * before #2307 introduced the unconditional `shell: bash`. The fix removes
   * the bash-ism instead of moving it, so a non-bash image's own default
   * `sh` runs the step unchanged.
   */
  test("a consumer-set non-bash image's gated job can still start (#2321)", () => {
    const doc = parseFile(generateGithubOpPipeline([pushSpec], { image: "alpine:3.20" }).files[0].yaml);
    const job = doc.jobs!["app-apply"];
    expect(job.container).toBe("alpine:3.20");
    const step = job.steps.find((s) => s.id === "chant-run");
    expect(step?.shell).toBeUndefined();
    expect(step?.run).not.toContain("pipefail");
  });
});

/**
 * chant #2257 — the second gate. A GitHub environment carries its own
 * protection rules (required reviewers above all), and until this existed no
 * generated job named one, so a `production` environment declared in a
 * repository bound nothing chant generated. What is asserted here is the key
 * on the right job, the key's absence everywhere else, and that adding it
 * changes nothing else in the document.
 */
describe("generateGithubOpPipeline: a deployment environment on the Op's job (#2257)", () => {
  const APPLY: ScheduledOpSpec = { name: "app-apply", trigger: { kind: "push", branches: ["main"] } };
  const GATED: ScheduledOpSpec = { ...APPLY, environment: { name: "production" } };

  /**
   * The exact document a spec with no `environment` emitted before the option
   * existed, produced by the generator at the commit this change branched
   * from. The claim the option makes is that it is additive; this is what
   * makes that claim falsifiable rather than a sentence in a PR body. The
   * `name:` line came later, from #2580, for every spec alike.
   */
  const AUDIT_YAML_BEFORE_2257 =
    [
      "name: actions-audit",
      "",
      "on:",
      "  schedule:",
      "    - cron: '0 6 * * *'",
      "  workflow_dispatch: {}",
      "",
      "concurrency:",
      "  group: actions-audit",
      "  cancel-in-progress: false",
      "",
      "permissions:",
      "  contents: read",
      "  issues: write",
      "",
      "jobs:",
      "  actions-audit:",
      "    runs-on: ubuntu-latest",
      "    container: node:22",
      "    steps:",
      "      - uses: actions/checkout@v7",
      "      - run: chant run actions-audit",
      "        env:",
      "          GITHUB_TOKEN: '${{ github.token }}'",
      "          GH_TOKEN: '${{ github.token }}'",
    ].join("\n") + "\n";

  test("a spec with no environment emits the bytes it emitted before the option existed", () => {
    const yaml = generateGithubOpPipeline([
      { name: "actions-audit", schedule: "0 6 * * *", findingMode: "issue" },
    ]).files[0].yaml;
    expect(yaml).toBe(AUDIT_YAML_BEFORE_2257);
  });

  test("emits environment: on the Op's job, as a mapping rather than the string shorthand", () => {
    const job = parseFile(generateGithubOpPipeline([GATED]).files[0].yaml).jobs!["app-apply"];
    expect(job.environment).toEqual({ name: "production" });
  });

  test("carries the url when the spec sets one", () => {
    const spec: ScheduledOpSpec = {
      ...APPLY,
      environment: { name: "production", url: "https://app.example.com" },
    };
    const job = parseFile(generateGithubOpPipeline([spec]).files[0].yaml).jobs!["app-apply"];
    expect(job.environment).toEqual({
      name: "production",
      url: "https://app.example.com",
    });
  });

  test("adding the environment changes exactly the environment block and nothing else", () => {
    const before = generateGithubOpPipeline([APPLY]).files[0].yaml;
    const after = generateGithubOpPipeline([GATED]).files[0].yaml;
    expect(after).toContain("    environment:\n      name: production\n");
    expect(after.replace("    environment:\n      name: production\n", "")).toBe(before);
  });

  test("the gate-notice job is not held behind the same reviewer", () => {
    // It exists to say a chant gate is pending. Behind the environment it
    // would only be readable after somebody had already released the job it
    // is reporting on, which is after the message stops being useful.
    const notice = parseFile(generateGithubOpPipeline([GATED]).files[0].yaml).jobs![
      "app-apply-gate-notice"
    ];
    expect(notice.environment).toBeUndefined();
  });

  test("costs no token scope: environment protection is repository configuration", () => {
    // `permissionsFor` gains nothing from the option — the reviewer lives on
    // the environment object, not on GITHUB_TOKEN — so the workflow-level set
    // is identical with and without it.
    const withEnv = parseFile(generateGithubOpPipeline([GATED]).files[0].yaml);
    const withoutEnv = parseFile(generateGithubOpPipeline([APPLY]).files[0].yaml);
    expect(withEnv.permissions).toEqual(withoutEnv.permissions);
    expect(withEnv.permissions).toEqual({ contents: "read" });
  });

  test("applies to any trigger, so a pull_request plan can name a review environment too", () => {
    const spec: ScheduledOpSpec = {
      name: "app-plan",
      trigger: { kind: "pull_request", branches: ["main"] },
      findingMode: "comment",
      environment: { name: "review", url: "${{ steps.deploy.outputs.url }}" },
    };
    const job = parseFile(generateGithubOpPipeline([spec]).files[0].yaml).jobs!["app-plan"];
    expect(job.environment?.name).toBe("review");
  });

  test("refuses a blank environment name, which resolves to nothing", () => {
    expect(() =>
      generateGithubOpPipeline([{ ...APPLY, environment: { name: "   " } }]),
    ).toThrow(/environment has an empty `name`/);
  });

  test("refuses a url that is neither absolute nor an expression, which renders as a dead link", () => {
    expect(() =>
      generateGithubOpPipeline([{ ...APPLY, environment: { name: "production", url: "/deploys" } }]),
    ).toThrow(/neither an absolute http\(s\) URL nor a/);
  });

  test("refuses an empty url rather than emitting one", () => {
    expect(() =>
      generateGithubOpPipeline([{ ...APPLY, environment: { name: "production", url: "" } }]),
    ).toThrow(/has an empty `url`/);
  });
});

/**
 * chant #2290 — per-Op credentials, so a pull-request job need not hold the
 * apply credential. `variables` lands as the Op's own job-level `env:`, one
 * level more specific than `options.variables`'s workflow-level `env:`, and
 * never on the gate-notice job beside it.
 */
describe("generateGithubOpPipeline: per-Op variables on the job (#2290)", () => {
  const CREDENTIAL = { AWS_ACCESS_KEY_ID: "${{ secrets.AWS_ACCESS_KEY_ID }}" };

  test("a spec with no variables emits no job-level env:, even when options.variables is set", () => {
    const doc = parseFile(
      generateGithubOpPipeline([{ name: "live-check", trigger: { kind: "pull_request", branches: ["main"] } }], {
        variables: { CHANT_FORGE: "github" },
      }).files[0].yaml,
    );
    expect(doc.jobs!["live-check"].env).toBeUndefined();
  });

  test("a spec's own variables land as the job's env:, beside the workflow env:", () => {
    const doc = parseFile(
      generateGithubOpPipeline(
        [{ name: "live-apply", trigger: { kind: "push", branches: ["main"] }, variables: CREDENTIAL }],
        { variables: { CHANT_FORGE: "github" } },
      ).files[0].yaml,
    );
    expect(doc.jobs!["live-apply"].env).toEqual(CREDENTIAL);
  });

  test("a per-Op key wins over a same-named forge-wide one", () => {
    const doc = parseFile(
      generateGithubOpPipeline(
        [
          {
            name: "live-apply",
            trigger: { kind: "push", branches: ["main"] },
            variables: { CHANT_FORGE: "overridden" },
          },
        ],
        { variables: { CHANT_FORGE: "github" } },
      ).files[0].yaml,
    );
    expect(doc.jobs!["live-apply"].env).toEqual({ CHANT_FORGE: "overridden" });
  });

  test("the gate-notice job never carries the Op's own job-level variables", () => {
    const doc = parseFile(
      generateGithubOpPipeline([
        { name: "live-apply", trigger: { kind: "push", branches: ["main"] }, variables: CREDENTIAL },
      ]).files[0].yaml,
    );
    expect(doc.jobs!["live-apply-gate-notice"].env).toBeUndefined();
  });

  test("a spec declaring variables changes exactly the job's env: block and nothing else", () => {
    const spec: ScheduledOpSpec = { name: "actions-audit", schedule: "0 6 * * *" };
    const before = generateGithubOpPipeline([spec]).files[0].yaml;
    const after = generateGithubOpPipeline([{ ...spec, variables: CREDENTIAL }]).files[0].yaml;
    expect(after).toContain("    env:\n      AWS_ACCESS_KEY_ID: '${{ secrets.AWS_ACCESS_KEY_ID }}'\n");
    expect(
      after.replace("    env:\n      AWS_ACCESS_KEY_ID: '${{ secrets.AWS_ACCESS_KEY_ID }}'\n", ""),
    ).toBe(before);
  });
});

describe("an empty branch list means the default, as on GitLab (#3765)", () => {
  test("push with branches: [] filters on main, and pull_request with branches: [] runs on every pull request", () => {
    const push = parseYAML(generateGithubOpPipeline([{ name: "apply", trigger: { kind: "push", branches: [] } }]).files[0]!.yaml);
    expect(push.on).toEqual({ push: { branches: ["main"] } });
    const pr = parseYAML(generateGithubOpPipeline([{ name: "plan", trigger: { kind: "pull_request", branches: [] } }]).files[0]!.yaml);
    expect(pr.on).toEqual({ pull_request: {} });
  });
});
