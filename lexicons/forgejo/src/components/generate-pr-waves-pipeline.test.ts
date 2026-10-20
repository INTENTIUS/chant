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

const root = (name: string, dependsOn: string[] = []): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name }] }],
});
const ESTATE: DriverComponent[] = [root("net"), root("app", ["net"])];

const GOLDEN = join(import.meta.dirname, "__fixtures__", "pr-loop-waves.forgejo.golden.yml");

describe("the Forgejo pull-request workflow with a gate per wave (#4003)", () => {
  const result = generateForgejoPipeline(ESTATE, { env: "prod", prLoop: {}, gatedWaves: { gate: "release" } });
  const doc = parseYAML(result.yaml) as { jobs: Record<string, { needs?: string[]; "runs-on": string; steps: Array<{ run?: string; uses?: string }> }> };

  test("matches its golden", () => {
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, result.yaml);
    expect(result.yaml).toBe(readFileSync(GOLDEN, "utf-8"));
  });

  test("an apply job per wave on Forgejo's runner, each passing its wave and talking to Forgejo", () => {
    expect(Object.keys(doc.jobs)).toEqual(["plan", "apply-wave-1", "apply-wave-2"]);
    expect(doc.jobs["apply-wave-2"]!.needs).toEqual(["apply-wave-1"]);
    for (const k of [1, 2]) {
      const job = doc.jobs[`apply-wave-${k}`]!;
      expect(job["runs-on"]).toBe("docker");
      expect(job.steps.find((s) => s.run?.includes("pr-apply"))!.run).toContain(`--forge forgejo --require-review --wave-gate release --resume .chant/pr-resume/pr-apply.json --wave ${k}`);
      expect(job.steps.some((s) => s.uses === "https://code.forgejo.org/actions/cache/restore@v4")).toBe(true);
    }
  });
});
