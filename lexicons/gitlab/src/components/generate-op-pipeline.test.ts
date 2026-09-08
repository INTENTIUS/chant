/**
 * Tests for generate mode's scheduled Op → GitLab CI YAML synthesis (#927).
 * Three things this must prove, mirroring `./generate-pipeline.test.ts`'s
 * acceptance style:
 *
 *  1. Every scheduled Op lands as one job in a single generated file (GitLab
 *     has no in-file cron — see the module doc), each job gated to its own
 *     Pipeline Schedule via `rules:`.
 *  2. The header comment names every Op's cron and finding-mode, since the
 *     cron itself can't live in the YAML.
 *  3. A cross-cutting generator change (runCommand/beforeScript/extraScript)
 *     is a single edit reflected in every job's script.
 */

import { describe, test, expect } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpPipeline } from "./generate-op-pipeline";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";

describe("generateGitlabOpPipeline: one file, one job per scheduled Op", () => {
  test("produces a single file with stages: and one job per Op", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "actions-audit", schedule: "0 6 * * *" },
      { name: "prod-reconcile", schedule: "0 * * * *", findingMode: "merge-request" },
    ];
    const result = generateGitlabOpPipeline(specs);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe("scheduled-ops.gitlab-ci.yml");

    const parsed = parseYAML(result.files[0].yaml);
    expect(parsed.stages).toEqual(["scheduled-ops"]);
    expect(parsed["actions-audit"]).toBeDefined();
    expect(parsed["prod-reconcile"]).toBeDefined();
  });

  test("each job is gated to its own Pipeline Schedule via rules:, runs chant run <name>", () => {
    const result = generateGitlabOpPipeline([{ name: "actions-audit", schedule: "0 6 * * *" }]);
    const parsed = parseYAML(result.files[0].yaml);
    const job = parsed["actions-audit"] as Record<string, unknown>;

    expect(job.stage).toBe("scheduled-ops");
    expect(job.rules).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "schedule" && $CHANT_SCHEDULED_OP == "actions-audit"' },
    ]);
    expect(job.script).toEqual(["chant run actions-audit"]);
  });

  test("the header comment names every Op's cron, selector value, and finding-mode", () => {
    const result = generateGitlabOpPipeline([
      { name: "actions-audit", schedule: "0 6 * * *", findingMode: "issue" },
    ]);
    expect(result.files[0].yaml).toContain('cron "0 6 * * *"');
    expect(result.files[0].yaml).toContain('CHANT_SCHEDULED_OP="actions-audit"');
    expect(result.files[0].yaml).toContain("finding-mode issue");
    expect(result.files[0].yaml).toContain("GITLAB_TOKEN");
  });

  test("report mode's header line carries no token requirement", () => {
    const result = generateGitlabOpPipeline([{ name: "actions-audit", schedule: "0 6 * * *" }]);
    expect(result.files[0].yaml).not.toContain("GITLAB_TOKEN");
  });

  test("an empty Op set still produces the (empty) stages file", () => {
    const result = generateGitlabOpPipeline([]);
    expect(result.files).toHaveLength(1);
    expect(result.jobs).toEqual([]);
    const parsed = parseYAML(result.files[0].yaml);
    expect(parsed.stages).toEqual(["scheduled-ops"]);
  });
});

/**
 * #2084's trigger pair, now that GitLab has both events after all (#2256).
 *
 * The two refusals this replaces ("GitLab has no pull_request/push event
 * model" on either trigger) were wrong about GitLab rather than about chant:
 * `$CI_PIPELINE_SOURCE` distinguishes `merge_request_event` from `push` on
 * every pipeline, and `rules:` selects a job on either. What is genuinely
 * absent is in-file cron, which is why the cron path still runs off a
 * project-level Pipeline Schedule and is unchanged below.
 */
describe("generateGitlabOpPipeline: the merge_request and push triggers (#2084, #2256)", () => {
  test("a pull_request trigger becomes a merge_request_event rule filtered to the target branch", () => {
    const result = generateGitlabOpPipeline([
      { name: "tf-plan", trigger: { kind: "pull_request", branches: ["main"] } },
    ]);
    const job = parseYAML(result.files[0].yaml)["tf-plan"] as Record<string, unknown>;
    expect(job.rules).toEqual([
      {
        if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "main"',
      },
    ]);
  });

  test("an unfiltered pull_request trigger fires on every merge request", () => {
    const result = generateGitlabOpPipeline([{ name: "tf-plan", trigger: { kind: "pull_request" } }]);
    const job = parseYAML(result.files[0].yaml)["tf-plan"] as Record<string, unknown>;
    expect(job.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "merge_request_event"' }]);
  });

  test("two target branches are two rules, which is how GitLab spells an OR", () => {
    const result = generateGitlabOpPipeline([
      { name: "tf-plan", trigger: { kind: "pull_request", branches: ["main", "release"] } },
    ]);
    const job = parseYAML(result.files[0].yaml)["tf-plan"] as { rules: Array<{ if: string }> };
    expect(job.rules.map((r) => r.if)).toEqual([
      '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "main"',
      '$CI_PIPELINE_SOURCE == "merge_request_event" && $CI_MERGE_REQUEST_TARGET_BRANCH_NAME == "release"',
    ]);
  });

  test("a push trigger becomes a push rule on the named branch", () => {
    const result = generateGitlabOpPipeline([
      { name: "tf-apply", trigger: { kind: "push", branches: ["release"] } },
    ]);
    const job = parseYAML(result.files[0].yaml)["tf-apply"] as Record<string, unknown>;
    expect(job.rules).toEqual([
      { if: '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "release"' },
    ]);
  });

  test("an unfiltered push trigger defaults to main, the same branch github's generator assumes", () => {
    const result = generateGitlabOpPipeline([{ name: "tf-apply", trigger: { kind: "push" } }]);
    const job = parseYAML(result.files[0].yaml)["tf-apply"] as { rules: Array<{ if: string }> };
    expect(job.rules[0].if).toBe('$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main"');
  });

  test("every job carries a resource_group, GitLab's own per-Op concurrency", () => {
    // github's `concurrency: { group, cancel-in-progress: false }` queues a
    // second run rather than cancelling the first, which is exactly what a
    // resource_group does — and on an apply job it is also the thing that
    // stops two runs racing for the same state lock.
    const result = generateGitlabOpPipeline([
      { name: "tf-plan", trigger: { kind: "pull_request" } },
      { name: "tf-apply", trigger: { kind: "push" } },
      { name: "nightly", schedule: "0 6 * * *" },
    ]);
    const parsed = parseYAML(result.files[0].yaml);
    for (const name of ["tf-plan", "tf-apply", "nightly"]) {
      expect((parsed[name] as Record<string, unknown>).resource_group).toBe(name);
    }
  });

  test("mixed triggers still land in one file, because a GitLab trigger is job-scoped", () => {
    const result = generateGitlabOpPipeline([
      { name: "tf-plan", trigger: { kind: "pull_request", branches: ["main"] } },
      { name: "tf-apply", trigger: { kind: "push", branches: ["main"] } },
      { name: "nightly", schedule: "0 6 * * *" },
    ]);
    expect(result.files).toHaveLength(1);
    expect(result.jobs.map((j) => j.trigger.kind)).toEqual(["pull_request", "push", "cron"]);
  });

  test("the header sets up a Pipeline Schedule only for the Ops that need one", () => {
    const yaml = generateGitlabOpPipeline([
      { name: "tf-plan", trigger: { kind: "pull_request", branches: ["main"] } },
      { name: "tf-apply", trigger: { kind: "push", branches: ["main"] } },
    ]).files[0].yaml;
    // No cron Op here, so nothing has to be created in Settings > CI/CD.
    expect(yaml).not.toContain("Pipeline Schedule");
    expect(yaml).toContain("merge_request_event onto main");
    expect(yaml).toContain("push to main");
  });

  test("a branch name that would break out of the rule expression is refused by name", () => {
    // A `rules:` if-expression is a string GitLab parses; a quote in a branch
    // name would end it early and silently change which pipelines match.
    expect(() =>
      generateGitlabOpPipeline([
        { name: "tf-plan", trigger: { kind: "pull_request", branches: ['main" || $CI_PIPELINE_SOURCE == "push'] } },
      ]),
    ).toThrow(/branch/i);
  });
});

/**
 * #2231's finding mode, now that there is a GitLab merge-request note
 * activity to spend it (#2256). The blanket refusal this replaces was about
 * chant having no way to post the note; what remains is the same constraint
 * github already has — the mode posts onto the merge request that triggered
 * the run, so it needs a trigger that has one.
 */
describe("generateGitlabOpPipeline: the comment finding mode on a merge request (#2231, #2256)", () => {
  test("findingMode comment is accepted on a pull_request trigger", () => {
    const result = generateGitlabOpPipeline([
      { name: "app-plan", trigger: { kind: "pull_request", branches: ["main"] }, findingMode: "comment" },
    ]);
    expect(result.jobs[0].findingMode).toBe("comment");
    const job = parseYAML(result.files[0].yaml)["app-plan"] as { rules: Array<{ if: string }> };
    expect(job.rules[0].if).toContain("merge_request_event");
  });

  test("the header names the token the note is written with", () => {
    const yaml = generateGitlabOpPipeline([
      { name: "app-plan", trigger: { kind: "pull_request" }, findingMode: "comment" },
    ]).files[0].yaml;
    expect(yaml).toContain("GITLAB_TOKEN");
  });

  test("findingMode comment on a cron trigger is refused, because a schedule has no merge request", () => {
    expect(() =>
      generateGitlabOpPipeline([{ name: "app-plan", schedule: "0 6 * * *", findingMode: "comment" }]),
    ).toThrow(/findingMode "comment".*trigger is "cron"/s);
  });

  test("findingMode comment on a push trigger is refused, naming the trigger", () => {
    expect(() =>
      generateGitlabOpPipeline([
        { name: "app-plan", trigger: { kind: "push" }, findingMode: "comment" },
      ]),
    ).toThrow(/findingMode "comment".*trigger is "push"/s);
  });
});

/**
 * #2243's green-gated apply, in the two surfaces GitLab has: the job's own
 * log, and an artifact. There is no step summary to write to and no
 * cross-job output to publish, so there is also no follow-up job.
 */
describe("generateGitlabOpPipeline: a gated apply is a green run (#2243, #2256)", () => {
  function applyJob(): Record<string, unknown> {
    const result = generateGitlabOpPipeline([
      { name: "app-apply", trigger: { kind: "push", branches: ["main"] } },
    ]);
    return parseYAML(result.files[0].yaml)["app-apply"] as Record<string, unknown>;
  }

  test("the push job maps the gated exit code and nothing else", () => {
    expect((applyJob().script as string[]).at(-1)).toBe("chant run app-apply --gated-exit 0");
  });

  test("the pending gate is written to a path the job also publishes as an artifact", () => {
    const job = applyJob();
    expect((job.variables as Record<string, string>).CHANT_GATE_SUMMARY).toBe(
      "chant-gate-app-apply.md",
    );
    expect(job.artifacts).toEqual({
      when: "always",
      paths: ["chant-gate-app-apply.md"],
      expire_in: "30 days",
    });
  });

  test("no other trigger is gated: a plan or a watch that stops is a signal, not noise", () => {
    const result = generateGitlabOpPipeline([
      { name: "app-plan", trigger: { kind: "pull_request" } },
      { name: "nightly", schedule: "0 6 * * *" },
    ]);
    const parsed = parseYAML(result.files[0].yaml);
    for (const name of ["app-plan", "nightly"]) {
      const job = parsed[name] as Record<string, unknown>;
      expect((job.script as string[]).at(-1)).toBe(`chant run ${name}`);
      expect(job.artifacts).toBeUndefined();
      expect(job.variables).toBeUndefined();
    }
  });
});

describe("generateGitlabOpPipeline: a cross-cutting change is one generator edit, not per-job", () => {
  test("runCommand/beforeScript/extraScript apply uniformly across every job", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "actions-audit", schedule: "0 6 * * *" },
      { name: "prod-reconcile", schedule: "0 * * * *" },
    ];
    const result = generateGitlabOpPipeline(specs, {
      runCommand: ["chant", "run", "{name}", "--json"],
      beforeScript: ["npm ci"],
      extraScript: ["echo done"],
    });
    const parsed = parseYAML(result.files[0].yaml);

    for (const spec of specs) {
      const job = parsed[spec.name] as Record<string, unknown>;
      const script = job.script as string[];
      expect(script[0]).toBe("npm ci");
      expect(script[1]).toContain("--json");
      expect(script[2]).toBe("echo done");
    }
  });
});

/**
 * #2242's two per-Op options against a provider that has neither concept.
 * Both degrade by name at build time rather than being dropped into a job
 * that would run without the thing the option asked for.
 */
describe("generateGitlabOpPipeline: setup steps and additive permissions (#2242)", () => {
  test("refuses a `uses` setup step by name, and names the action", () => {
    expect(() =>
      generateGitlabOpPipeline([
        {
          name: "actions-audit",
          schedule: "0 6 * * *",
          setup: [{ uses: "aws-actions/configure-aws-credentials@v6" }],
        },
      ]),
    ).toThrow(/setup step 1 is `uses: "aws-actions\/configure-aws-credentials@v6"`.*GitLab CI jobs run/s);
  });

  test("emits a `run` setup entry ahead of the beforeScript lines", () => {
    const result = generateGitlabOpPipeline(
      [
        {
          name: "actions-audit",
          schedule: "0 6 * * *",
          setup: [{ run: "aws sts get-caller-identity" }],
        },
      ],
      { beforeScript: ["npm ci"], extraScript: ["echo done"] },
    );
    const job = parseYAML(result.files[0].yaml)["actions-audit"] as { script: string[] };
    expect(job.script).toEqual([
      "aws sts get-caller-identity",
      "npm ci",
      "chant run actions-audit",
      "echo done",
    ]);
  });

  /**
   * `id-token: write` is the one additive scope that has a GitLab meaning
   * (#2256): the refusal it replaces already named `id_tokens:` as the shape
   * to reach for, and this reaches for it rather than describing it. Every
   * other scope is still refused, because GitLab has no per-job token-scope
   * mapping to put it in.
   */
  test("id-token: write becomes an id_tokens declaration, GitLab's own OIDC surface", () => {
    const result = generateGitlabOpPipeline([
      {
        name: "app-apply",
        trigger: { kind: "push", branches: ["main"] },
        permissions: { "id-token": "write" },
      },
    ]);
    const job = parseYAML(result.files[0].yaml)["app-apply"] as Record<string, unknown>;
    expect(job.id_tokens).toEqual({ CHANT_ID_TOKEN: { aud: "$CI_SERVER_URL" } });
  });

  test("an Op that adds no permissions declares no id_tokens", () => {
    const result = generateGitlabOpPipeline([{ name: "actions-audit", schedule: "0 6 * * *" }]);
    const job = parseYAML(result.files[0].yaml)["actions-audit"] as Record<string, unknown>;
    expect(job.id_tokens).toBeUndefined();
  });

  test("id-token: read is refused: GitLab either mints the token or does not", () => {
    expect(() =>
      generateGitlabOpPipeline([
        { name: "actions-audit", schedule: "0 6 * * *", permissions: { "id-token": "read" } },
      ]),
    ).toThrow(/id-token: read/);
  });

  test("any other additive scope is still refused by name", () => {
    expect(() =>
      generateGitlabOpPipeline([
        { name: "actions-audit", schedule: "0 6 * * *", permissions: { "pull-requests": "write" } },
      ]),
    ).toThrow(/adds permission "pull-requests: write".*no per-job token-scope/s);
  });
});

/**
 * chant #2257 — the one option of the three that GitLab actually has. An
 * environment is a project object here too, with the same two fields on the
 * job and a protected-environment approval rule behind it, so the reviewer
 * gate the option exists for is expressible and is emitted rather than
 * refused. What is not expressible is the protection itself, which is a
 * project setting, so the header names it the way it already names the
 * schedule to create.
 */
describe("generateGitlabOpPipeline: a deployment environment (#2257)", () => {
  const AUDIT: ScheduledOpSpec = { name: "actions-audit", schedule: "0 6 * * *", findingMode: "issue" };

  /** The document a spec with no `environment` emitted before the option existed. */
  const YAML_BEFORE_2257 =
    [
      "# Scheduled Ops (chant #927) — GitLab has no in-file cron. Create one",
      "# Pipeline Schedule per Op below (Settings > CI/CD > Schedules): set its",
      "# cron to the value noted here and its CHANT_SCHEDULED_OP CI/CD variable to",
      "# the Op's name, so only that job runs on that schedule.",
      "#",
      '#   actions-audit: cron "0 6 * * *", CHANT_SCHEDULED_OP="actions-audit", finding-mode issue' +
        " — needs a GITLAB_TOKEN CI/CD variable (masked, scope: api)",
      "",
      "stages:",
      "  - scheduled-ops",
      "",
      "actions-audit:",
      "  stage: scheduled-ops",
      "  image: node:22-slim",
      "  rules:",
      `    - if: '$CI_PIPELINE_SOURCE == "schedule" && $CHANT_SCHEDULED_OP == "actions-audit"'`,
      "  script:",
      "    - chant run actions-audit",
    ].join("\n") + "\n";

  test("a spec with no environment emits the bytes it emitted before the option existed", () => {
    expect(generateGitlabOpPipeline([AUDIT]).files[0].yaml).toBe(YAML_BEFORE_2257);
  });

  test("maps it onto GitLab's own environment: key, with the url when there is one", () => {
    const spec: ScheduledOpSpec = {
      ...AUDIT,
      environment: { name: "production", url: "https://app.example.com" },
    };
    const job = parseYAML(generateGitlabOpPipeline([spec]).files[0].yaml)["actions-audit"] as {
      environment?: Record<string, string>;
    };
    expect(job.environment).toEqual({ name: "production", url: "https://app.example.com" });
  });

  test("names the environment to protect in the header, beside the schedule to create", () => {
    const spec: ScheduledOpSpec = { ...AUDIT, environment: { name: "production" } };
    const yaml = generateGitlabOpPipeline([spec]).files[0].yaml;
    expect(yaml).toContain('deploys to environment "production"');
    expect(yaml).toContain("Settings > CI/CD > Protected environments");
    // The approval rule is a project setting; this file can only bind the job
    // to the environment, so the header says where the rule is set.
    expect(yaml).toContain("require an approval before the job runs");
  });

  test("adding the environment changes only the header line and the job's own key", () => {
    const spec: ScheduledOpSpec = { ...AUDIT, environment: { name: "production" } };
    const after = generateGitlabOpPipeline([spec]).files[0].yaml;
    const withoutHeaderLine = after
      .split("\n")
      .filter((line) => !line.startsWith("#     deploys to environment"))
      .join("\n");
    expect(withoutHeaderLine.replace("  environment:\n    name: production\n", "")).toBe(
      YAML_BEFORE_2257,
    );
  });

  test("refuses a blank name and a url that is neither absolute nor a variable expression", () => {
    expect(() => generateGitlabOpPipeline([{ ...AUDIT, environment: { name: " " } }])).toThrow(
      /environment has an empty `name`/,
    );
    expect(() =>
      generateGitlabOpPipeline([{ ...AUDIT, environment: { name: "production", url: "/deploys" } }]),
    ).toThrow(/neither an absolute http\(s\) URL nor a variable expression/);
  });
});
