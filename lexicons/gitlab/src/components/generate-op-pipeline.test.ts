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

describe("generateGitlabOpPipeline: no pull_request/push event model (#2084)", () => {
  test("a pull_request trigger throws a clear error instead of silently ignoring it", () => {
    const specs: ScheduledOpSpec[] = [{ name: "tf-plan", trigger: { kind: "pull_request" } }];
    expect(() => generateGitlabOpPipeline(specs)).toThrow(/pull_request.*GitLab has no pull_request\/push event model/s);
  });

  test("a push trigger throws a clear error instead of silently ignoring it", () => {
    const specs: ScheduledOpSpec[] = [{ name: "tf-apply", trigger: { kind: "push" } }];
    expect(() => generateGitlabOpPipeline(specs)).toThrow(/push.*GitLab has no pull_request\/push event model/s);
  });
});

describe("generateGitlabOpPipeline: no comment finding mode (#2231)", () => {
  test("findingMode comment is refused by name, even on a cron trigger GitLab does support", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "app-plan", schedule: "0 6 * * *", findingMode: "comment" },
    ];
    expect(() => generateGitlabOpPipeline(specs)).toThrow(
      /Scheduled Op "app-plan".*findingMode "comment".*GitLab has no pull_request event/s,
    );
  });

  test("the refusal names the modes GitLab does have", () => {
    const specs: ScheduledOpSpec[] = [{ name: "app-plan", schedule: "0 6 * * *", findingMode: "comment" }];
    expect(() => generateGitlabOpPipeline(specs)).toThrow(
      /findingMode "issue" or "merge-request"/,
    );
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

  test("refuses additive permissions by name, and points at GitLab's own OIDC surface", () => {
    expect(() =>
      generateGitlabOpPipeline([
        { name: "actions-audit", schedule: "0 6 * * *", permissions: { "id-token": "write" } },
      ]),
    ).toThrow(/adds permissions \{ id-token: write \}.*id_tokens:/s);
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
