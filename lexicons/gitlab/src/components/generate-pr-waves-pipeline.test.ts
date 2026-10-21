/**
 * The GitLab merge-request pipeline with a gate per wave on merge (#4003):
 * the plan job in each merge request pipeline, and one apply job per wave of
 * the component graph, one stage each, sharing the commit's record in the
 * job cache. The whole file has a golden, and it validates against the GitLab
 * CI schema this lexicon vendors.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";

const root = (name: string, dependsOn: string[] = []): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name }] }],
});
const ESTATE: DriverComponent[] = [root("net"), root("app", ["net"]), root("web", ["app"])];

const GOLDEN = join(import.meta.dirname, "__fixtures__", "pr-loop-waves.gitlab.golden.yml");
const SCHEMA = join(import.meta.dirname, "..", "codegen", "vendored", "gitlab-ci-schema.json");

interface Job {
  stage: string;
  needs?: string[];
  rules: Array<{ if: string }>;
  script: string[];
  resource_group?: string;
  cache?: Record<string, unknown>;
}

describe("the GitLab merge-request pipeline with a gate per wave (#4003)", () => {
  const result = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true }, gatedWaves: { gate: "release" } });
  const doc = parseYAML(result.yaml) as Record<string, unknown> & { stages: string[] };

  test("matches its golden", () => {
    if (process.env.UPDATE_GOLDEN) writeFileSync(GOLDEN, result.yaml);
    expect(result.yaml).toBe(readFileSync(GOLDEN, "utf-8"));
  });

  test("wave 1 takes the newest green commit, and each later wave applies the one wave 1 took (#4221)", () => {
    for (const k of [1, 2, 3]) {
      const job = doc[`apply-wave-${k}`] as { script: string[]; artifacts: { reports?: { dotenv?: string } } };
      expect(job.artifacts.reports).toEqual({ dotenv: "chant-green.env" });
      expect(job.script).toContain('echo "GREEN_SHA=$GREEN_SHA" > "$CI_PROJECT_DIR/chant-green.env"');
      const lastGreen = job.script.some((l) => l.includes("chant ci last-green"));
      expect(lastGreen).toBe(k === 1);
      if (k > 1) expect(job.script.some((l) => l.startsWith('test -n "$GREEN_SHA"'))).toBe(true);
    }
  });

  test("validates against the vendored GitLab CI schema", () => {
    const req = createRequire(import.meta.url);
    const mod = req("ajv") as { default?: unknown };
    const Ajv = (mod.default ?? mod) as new (opts: object) => { compile(s: object): ((d: unknown) => boolean) & { errors?: unknown } };
    const validate = new Ajv({ strict: false, allErrors: true }).compile(JSON.parse(readFileSync(SCHEMA, "utf-8")));
    expect(validate(doc), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  test("one apply job and stage per wave, each needing the one before, on the merge, one at a time", () => {
    expect(doc.stages).toEqual(["plan", "record", "apply-wave-1", "apply-wave-2", "apply-wave-3"]);
    expect(result.jobs.map((j) => [j.jobName, j.needs])).toEqual([
      ["plan", []],
      ["record", []],
      ["apply-wave-1", []],
      ["apply-wave-2", ["apply-wave-1"]],
      ["apply-wave-3", ["apply-wave-2"]],
    ]);
    for (const k of [1, 2, 3]) {
      const job = doc[`apply-wave-${k}`] as Job;
      expect(job.stage).toBe(`apply-wave-${k}`);
      expect(job.needs).toEqual(k > 1 ? [`apply-wave-${k - 1}`] : undefined);
      expect(job.resource_group).toBe("chant-apply-prod");
      // #4156: through chant ci run, which runs pr-apply --wave-gate release (no --require-review since #4168) --resume ... --wave <k>.
      expect(job.script.at(-1)).toBe(`chant ci run apply --in-place --env prod --gate pr-apply --forge gitlab --wave-gate release --wave ${k}`);
      // Every wave shares the commit's record, so wave k pulls what wave k-1 pushed.
      expect(job.cache).toEqual({ key: "chant-apply-prod-$CI_COMMIT_SHA", paths: [".chant/pr-resume/pr-apply.json"], when: "always" });
    }
    expect((doc.plan as Job).script.at(-1)).toContain("--forge gitlab --wave-gate release");
    expect((doc.plan as Job).script.at(-1)).not.toContain("--wave ");
  });

  test("inside a workspace member the wave jobs carry the member's name", () => {
    const member = { name: "network", dir: "infra/network", file: ".gitlab/ci/chant-pr.network.prod.gitlab-ci.yml" };
    const scoped = generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyOnMerge: true }, gatedWaves: { gate: "release" }, member });
    expect(scoped.jobs.map((j) => [j.jobName, j.needs])).toEqual([
      ["network-plan", []],
      ["network-record", []],
      ["network-apply-wave-1", []],
      ["network-apply-wave-2", ["network-apply-wave-1"]],
      ["network-apply-wave-3", ["network-apply-wave-2"]],
    ]);
    // ci run, started in the member's directory, passes --member network to pr-apply.
    expect(scoped.yaml).toContain("cd infra/network");
    expect(scoped.yaml).toContain("chant ci run apply --in-place --env prod --gate pr-apply --forge gitlab --wave-gate release --wave 3");
  });
});
