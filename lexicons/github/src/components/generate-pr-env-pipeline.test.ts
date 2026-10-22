/**
 * A pull request's environment in the generated GitHub workflow (#4298):
 * `env-up` on an opened, updated or reopened pull request, `env-down` when
 * it closes, `env-sweep` on the schedule, and a plan job that skips the close.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { PR_ENV_SWEEP_CRON } from "@intentius/chant/components/pr-pipeline";
import { generateGithubPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "app", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "kubectl-apply", manifest: "app.yaml" } as never] }] }];

interface Job {
  if: string;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  steps: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string>; with?: Record<string, unknown> }>;
}

function hasActionlint(): boolean {
  try {
    execFileSync("actionlint", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("the GitHub pull-request workflow with a pull request environment", () => {
  const result = generateGithubPipeline(ESTATE, { env: "staging", prLoop: { prEnvironment: true } });
  const doc = parseYAML(result.yaml) as { on: Record<string, unknown>; jobs: Record<string, Job> };

  test("the pull_request trigger fires on close too, and a schedule starts the sweep", () => {
    expect(doc.on.pull_request).toEqual({ branches: ["main"], types: ["opened", "synchronize", "reopened", "closed"] });
    expect(doc.on.schedule).toEqual([{ cron: PR_ENV_SWEEP_CRON }]);
    expect(doc.jobs.plan!.if).toBe("github.event_name == 'pull_request' && github.event.action != 'closed'");
  });

  test("env-up applies to pr-<n>, env-down tears it down from the base branch, one run at a time per pull request", () => {
    const upJob = doc.jobs["env-up"]!;
    const down = doc.jobs["env-down"]!;
    expect(upJob.if).toBe("github.event_name == 'pull_request' && github.event.action != 'closed'");
    expect(down.if).toBe("github.event_name == 'pull_request' && github.event.action == 'closed'");
    const run = (j: Job) => j.steps.find((s) => s.run?.startsWith("chant components pr-env"))!;
    expect(run(upJob).run).toBe('chant components pr-env up --base "$BASE_SHA" --pr "$PR_NUMBER" --forge github --output .chant/pr-env');
    expect(run(upJob).env?.CHANT_ENV).toBe("pr-${{ github.event.pull_request.number }}");
    expect(run(down).run).toBe('chant components pr-env down --pr "$PR_NUMBER" --reason closed --forge github --output .chant/pr-env');
    expect(down.steps[0]!.with?.ref).toBe("${{ github.event.pull_request.base.ref }}");
    expect(upJob.concurrency).toEqual({ group: "chant-pr-env-${{ github.event.pull_request.number }}", "cancel-in-progress": false });
    expect(down.concurrency).toEqual(upJob.concurrency);
    expect(upJob.permissions).toEqual({ contents: "write", "pull-requests": "write", statuses: "write" });
  });

  test("env-sweep runs only from the schedule", () => {
    expect(doc.jobs["env-sweep"]!.if).toBe("github.event_name == 'schedule'");
    expect(result.jobs.map((j) => j.jobName)).toEqual(expect.arrayContaining(["env-up", "env-down", "env-sweep"]));
  });

  test("without the option nothing changes", () => {
    const plain = parseYAML(generateGithubPipeline(ESTATE, { env: "staging", prLoop: {} }).yaml) as { on: Record<string, unknown>; jobs: Record<string, Job> };
    expect(plain.on.pull_request).toEqual({ branches: ["main"] });
    expect(plain.jobs["env-up"]).toBeUndefined();
  });

  test.skipIf(!hasActionlint())("passes actionlint", () => {
    const dir = mkdtempSync(join(tmpdir(), "chant-actionlint-"));
    try {
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(join(dir, ".github", "workflows", "chant-pr.yml"), result.yaml);
      expect(() => execFileSync("actionlint", [".github/workflows/chant-pr.yml"], { cwd: dir, encoding: "utf8" })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
