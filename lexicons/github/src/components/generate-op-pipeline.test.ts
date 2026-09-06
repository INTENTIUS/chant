/**
 * Tests for generate mode's scheduled Op → GitHub Actions workflow YAML
 * synthesis (#927). Mirrors `./generate-pipeline.test.ts`'s style:
 *
 *  1. Each `ScheduledOpSpec` produces its own structurally valid workflow
 *     (parses back via `../yaml.ts`'s `parseYAML`) with a `schedule` +
 *     `workflow_dispatch` trigger and one job.
 *  2. `permissions:` is least-privilege per finding-mode — read-only for
 *     `report`, scoped write for `issue`/`pull-request`.
 *  3. A cross-cutting generator change (extraScript/beforeScript/runCommand)
 *     is a single edit reflected in every generated file.
 */

import { describe, test, expect } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubOpPipeline } from "./generate-op-pipeline";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";

interface ParsedStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
}

interface ParsedJob {
  "runs-on"?: string;
  container?: string;
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
    expect(job.steps[0].uses).toBe("actions/checkout@v4");
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
      runCommand: ["chant", "run", "{name}", "--temporal"],
      beforeScript: ["npm ci"],
      extraScript: ["echo done"],
    });

    for (const file of result.files) {
      const doc = parseFile(file.yaml);
      const jobName = Object.keys(doc.jobs!)[0];
      const runLines = doc.jobs![jobName].steps.filter((s) => typeof s.run === "string").map((s) => s.run as string);
      expect(runLines[0]).toBe("npm ci");
      expect(runLines[1]).toContain("--temporal");
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
