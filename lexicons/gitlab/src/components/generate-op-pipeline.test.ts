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

describe("generateGitlabOpPipeline: a cross-cutting change is one generator edit, not per-job", () => {
  test("runCommand/beforeScript/extraScript apply uniformly across every job", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "actions-audit", schedule: "0 6 * * *" },
      { name: "prod-reconcile", schedule: "0 * * * *" },
    ];
    const result = generateGitlabOpPipeline(specs, {
      runCommand: ["chant", "run", "{name}", "--temporal"],
      beforeScript: ["npm ci"],
      extraScript: ["echo done"],
    });
    const parsed = parseYAML(result.files[0].yaml);

    for (const spec of specs) {
      const job = parsed[spec.name] as Record<string, unknown>;
      const script = job.script as string[];
      expect(script[0]).toBe("npm ci");
      expect(script[1]).toContain("--temporal");
      expect(script[2]).toBe("echo done");
    }
  });
});
