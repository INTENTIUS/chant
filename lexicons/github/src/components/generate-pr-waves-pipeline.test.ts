/**
 * The GitHub pull-request workflow with a gate per wave on merge (#4003):
 * `--pr-loop --wave-gate <gate>` keeps the plan job on the pull request and
 * writes one apply job per wave of the component graph, each running
 * `pr-apply --wave-gate <gate> --wave <k>` after the one before it. The whole
 * file has a golden, and actionlint checks it when it is installed.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGithubPipeline } from "./generate-pipeline";

const root = (name: string, dependsOn: string[] = []): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name }] }],
});
/** Three waves: net, then app, then web. */
const ESTATE: DriverComponent[] = [root("net"), root("app", ["net"]), root("web", ["app"])];

const GOLDEN = join(import.meta.dirname, "__fixtures__", "pr-loop-waves.github.golden.yml");

interface Step {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}
interface Job {
  if: string;
  needs?: string[];
  concurrency?: Record<string, unknown>;
  permissions: Record<string, string>;
  steps: Step[];
}

function hasActionlint(): boolean {
  try {
    execFileSync("actionlint", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("the GitHub pull-request workflow with a gate per wave (#4003)", () => {
  const result = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true }, gatedWaves: { gate: "release" } });
  const doc = parseYAML(result.yaml) as { jobs: Record<string, Job> };

  test("matches its golden", () => {
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, result.yaml);
    expect(result.yaml).toBe(readFileSync(GOLDEN, "utf-8"));
  });

  test("wave 1 takes the newest green commit, and each later wave applies the one wave 1 took (#4221)", () => {
    const jobs = doc.jobs as unknown as Record<string, { outputs?: Record<string, string>; steps: Array<{ id?: string; run?: string; env?: Record<string, string> }> }>;
    const waves = Object.keys(jobs).filter((name) => name.startsWith("apply-wave-")).length;
    expect(waves).toBeGreaterThan(1);
    for (let k = 1; k <= waves; k++) {
      const job = jobs[`apply-wave-${k}`]!;
      expect(job.outputs).toEqual({ "green-sha": "${{ steps.apply.outputs.green-sha }}" });
      const step = job.steps.find((s) => s.id === "apply")!;
      expect(step.run).toContain('echo "green-sha=$GREEN_SHA" >> "$GITHUB_OUTPUT"');
      if (k === 1) {
        expect(step.run).toContain('GREEN_SHA="$(chant ci last-green)"');
        expect(step.env?.GREEN_SHA).toBeUndefined();
      } else {
        expect(step.run).not.toContain("chant ci last-green");
        expect(step.run).toContain('test -n "$GREEN_SHA"');
        expect(step.env?.GREEN_SHA).toBe(`\${{ needs.apply-wave-${k - 1}.outputs.green-sha }}`);
      }
    }
  });

  test("keeps the plan and record jobs, and writes one apply job per wave, each needing the one before", () => {
    expect(Object.keys(doc.jobs)).toEqual(["plan", "record", "apply-wave-1", "apply-wave-2", "apply-wave-3"]);
    expect(result.jobs.map((j) => [j.jobName, j.needs])).toEqual([
      ["plan", []],
      ["record", []],
      ["apply-wave-1", []],
      ["apply-wave-2", ["apply-wave-1"]],
      ["apply-wave-3", ["apply-wave-2"]],
    ]);
    expect(doc.jobs["apply-wave-2"]!.needs).toEqual(["apply-wave-1"]);
    const plan = doc.jobs.plan!.steps.find((s) => s.run?.includes("ci run plan"))!;
    // The plan passes the wave gate for its note (#4003), and runs no wave.
    expect(plan.run).toContain("--forge github --wave-gate release");
    expect(plan.run).not.toContain("--wave ");
    for (const k of [1, 2, 3]) {
      const job = doc.jobs[`apply-wave-${k}`]!;
      // #4168 step 9: the waves apply the newest green commit once the tick ran.
      // #4291: a wave after the first runs after one that failed, so a failure blocks only its dependents.
      const onGreen = "github.event_name == 'workflow_run' || github.event_name == 'workflow_dispatch'";
      expect(job.if).toBe(k === 1 ? onGreen : `!cancelled() && needs.apply-wave-${k - 1}.result != 'skipped' && (${onGreen})`);
      expect(job.concurrency).toEqual({ group: "chant-apply-prod", "cancel-in-progress": false });
      expect(job.permissions.contents).toBe("write");
      const run = job.steps.find((s) => s.run?.includes("ci run apply"))!.run!;
      // #4156: through chant ci run, which runs pr-apply --wave-gate release (no --require-review since #4168) --resume ... --wave <k>.
      expect(run).toContain(`chant ci run apply --in-place --env prod --gate pr-apply --forge github --wave-gate release --wave ${k}`);
      expect(job.steps.find((s) => s.run?.includes("ci run apply"))!.env?.CHANT_RUNNER_KEY).toBe("${{ secrets.CHANT_RUNNER_KEY }}");
    }
  });

  test("each wave restores the commit's newest record and saves its own, so wave k reads what wave k-1 left", () => {
    for (const k of [1, 2, 3]) {
      const steps = doc.jobs[`apply-wave-${k}`]!.steps;
      const restore = steps.find((s) => s.uses === "actions/cache/restore@v4")!;
      const save = steps.find((s) => s.uses === "actions/cache/save@v4")!;
      const key = `chant-apply-prod-\${{ github.sha }}-\${{ github.run_id }}-\${{ github.run_attempt }}-wave-${k}`;
      expect(restore.with).toEqual({ path: ".chant/pr-resume/pr-apply.json", key, "restore-keys": "chant-apply-prod-${{ github.sha }}-" });
      expect(save).toMatchObject({ if: "always()", with: { path: ".chant/pr-resume/pr-apply.json", key } });
      const keep = steps.find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
      expect(keep.with?.name).toBe(`chant-pr-apply-wave-${k}`);
    }
  });

  test("without --wave-gate the workflow is the one apply job it was", () => {
    const plain = generateGithubPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true } });
    expect(plain.jobs.map((j) => j.jobName)).toEqual(["plan", "record", "apply"]);
    expect(plain.yaml).not.toContain("--wave");
  });

  test.skipIf(!hasActionlint())("actionlint passes it", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pr-waves-actionlint-"));
    try {
      mkdirSync(join(tmp, ".github", "workflows"), { recursive: true });
      const file = join(tmp, ".github", "workflows", "chant-pr.yml");
      writeFileSync(file, result.yaml);
      execFileSync("actionlint", [file], { cwd: tmp, stdio: "pipe" });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
