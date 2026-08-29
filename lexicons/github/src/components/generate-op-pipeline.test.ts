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
