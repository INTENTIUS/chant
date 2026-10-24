/**
 * The Forgejo pull-request workflow with a gate per wave on merge (#4003):
 * github's wave jobs with the Forgejo dialect applied and the commands
 * talking to Forgejo. The whole file has a golden.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateForgejoPipeline } from "./generate-pipeline";
import { ACTION_PINS, usesRef } from "@intentius/chant/action-pins";

const root = (name: string, dependsOn: string[] = []): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name }] }],
});
const ESTATE: DriverComponent[] = [root("net"), root("app", ["net"])];

const GOLDEN = join(import.meta.dirname, "__fixtures__", "pr-loop-waves.forgejo.golden.yml");

describe("the Forgejo pull-request workflow with a gate per wave (#4003)", () => {
  const result = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true }, gatedWaves: { gate: "release" } });
  const doc = parseYAML(result.yaml) as { jobs: Record<string, { needs?: string[]; "runs-on": string; steps: Array<{ run?: string; uses?: string }> }> };

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

  test("an apply job per wave on Forgejo's runner, each passing its wave and talking to Forgejo", () => {
    expect(Object.keys(doc.jobs)).toEqual(["plan", "plan-note", "record", "apply-wave-1", "apply-wave-2"]);
    expect(doc.jobs["apply-wave-2"]!.needs).toEqual(["apply-wave-1"]);
    for (const k of [1, 2]) {
      const job = doc.jobs[`apply-wave-${k}`]!;
      expect(job["runs-on"]).toBe("docker");
      expect(job.steps.find((s) => s.run?.includes("ci run apply"))!.run).toContain(`--forge forgejo --wave-gate release --wave ${k}`);
      expect(job.steps.some((s) => s.uses === `https://code.forgejo.org/${usesRef(ACTION_PINS.cacheRestore4)}`)).toBe(true);
    }
  });
});
