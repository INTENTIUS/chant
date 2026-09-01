/**
 * Tests for generate mode's component → Forgejo Actions workflow YAML
 * synthesis (#969, epic #885). Mirrors the github generator's suite
 * (`lexicons/github/src/components/generate-pipeline.test.ts`) — Forgejo Actions
 * is a GitHub-Actions dialect, so the pipeline SHAPE is identical (one job per
 * component, `needs:` = `dependsOn`, cross-stack outputs as artifacts) and this
 * suite additionally proves the Forgejo dialect is applied: runner labels
 * remapped (`ubuntu-latest` → `docker`) and `uses:` refs rewritten to a
 * Forgejo-resolvable form.
 */

import { describe, test, expect } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoPipeline } from "./generate-pipeline";
import { generateGithubPipeline } from "@intentius/chant-lexicon-github/components/generate-pipeline";
import { type DriverComponent } from "@intentius/chant/components/driver";
import { searchService } from "@intentius/chant/components/pilots/alb-ecs.pilot";
import { ordersTable } from "@intentius/chant/components/pilots/dynamodb.pilot";

function pilotComponents(): DriverComponent[] {
  return [
    { name: ordersTable.name, dependsOn: ordersTable.dependsOn, deploy: ordersTable.deploy },
    { name: "shared-alb", dependsOn: [], deploy: [] },
    { name: searchService.name, dependsOn: searchService.dependsOn, deploy: searchService.deploy },
  ];
}

interface ParsedStep {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface ParsedJob {
  "runs-on"?: string;
  container?: string;
  needs?: string[];
  steps: ParsedStep[];
}
function parsedJobs(yaml: string): Record<string, ParsedJob> {
  return (parseYAML(yaml).jobs ?? {}) as Record<string, ParsedJob>;
}
function usesRefs(job: ParsedJob): string[] {
  return job.steps.filter((s) => typeof s.uses === "string").map((s) => s.uses as string);
}

describe("generateForgejoPipeline: structure (github-shaped)", () => {
  test("valid workflow — on: + one job per component with runs-on/steps", () => {
    const result = generateForgejoPipeline(pilotComponents());
    const parsed = parseYAML(result.yaml);
    expect(parsed.on).toBeDefined();
    const jobs = parsedJobs(result.yaml);
    expect(Object.keys(jobs).sort()).toEqual(["orders-table", "search-service", "shared-alb"]);
    for (const job of Object.values(jobs)) {
      expect(job["runs-on"]).toBeDefined();
      expect(Array.isArray(job.steps)).toBe(true);
    }
  });

  test("the environment identity passes through the dialect untransformed (#2046)", () => {
    const result = generateForgejoPipeline(pilotComponents(), { env: "staging" });
    const parsed = parseYAML(result.yaml);
    expect(parsed.name).toBe("chant-components-staging");
    expect(parsed.env).toEqual({ CHANT_ENV: "staging" });
    expect(result.env).toBe("staging");
  });

  test("needs: mirrors dependsOn — search-service waits on shared-alb, nothing else", () => {
    const jobs = parsedJobs(generateForgejoPipeline(pilotComponents()).yaml);
    expect(jobs["search-service"].needs).toEqual(["shared-alb"]);
    expect(jobs["orders-table"].needs ?? []).toEqual([]);
    expect(jobs["shared-alb"].needs ?? []).toEqual([]);
  });

  test("cross-stack outputs threaded as artifacts: producer uploads, dependent downloads", () => {
    const jobs = parsedJobs(generateForgejoPipeline(pilotComponents()).yaml);
    const upload = jobs["shared-alb"].steps.find((s) => (s.uses ?? "").includes("upload-artifact"));
    expect(upload?.with).toEqual({ name: "shared-alb-outputs", path: "shared-alb.outputs.json" });
    const download = jobs["search-service"].steps.find((s) => (s.uses ?? "").includes("download-artifact"));
    expect(download?.with).toEqual({ name: "shared-alb-outputs", path: "." });
  });

  test("stages/jobs parity with the github generator (same graph resolution)", () => {
    const fj = generateForgejoPipeline(pilotComponents());
    const gh = generateGithubPipeline(pilotComponents());
    expect(fj.stages).toEqual(gh.stages);
    expect(fj.jobs).toEqual(gh.jobs);
  });
});

describe("generateForgejoPipeline: dialect applied", () => {
  test("runner label ubuntu-latest is remapped to the Forgejo default (docker)", () => {
    const jobs = parsedJobs(generateForgejoPipeline(pilotComponents()).yaml);
    for (const job of Object.values(jobs)) {
      expect(job["runs-on"]).toBe("docker");
    }
    // The github generator uses the un-remapped label — proving the dialect ran.
    const ghJobs = parsedJobs(generateGithubPipeline(pilotComponents()).yaml);
    expect(ghJobs["shared-alb"]["runs-on"]).toBe("ubuntu-latest");
  });

  test("uses: refs are rewritten to a Forgejo-resolvable mirror (not bare actions/*)", () => {
    const jobs = parsedJobs(generateForgejoPipeline(pilotComponents()).yaml);
    const all = Object.values(jobs).flatMap(usesRefs);
    expect(all.length).toBeGreaterThan(0);
    for (const ref of all) {
      expect(ref.startsWith("actions/")).toBe(false);
      expect(ref).toContain("code.forgejo.org/actions/");
    }
    // checkout is present and mirrored.
    expect(all.some((r) => r === "https://code.forgejo.org/actions/checkout@v4")).toBe(true);
  });
});
