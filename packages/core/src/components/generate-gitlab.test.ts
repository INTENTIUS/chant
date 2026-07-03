/**
 * Tests for generate mode's component → GitLab CI YAML synthesis (#563,
 * epic #551, Phase 3). Three things this must prove, matching the issue's
 * acceptance criteria:
 *
 *  1. A component set produces structurally valid GitLab CI YAML (parses
 *     back via `../yaml.ts`'s `parseYAML`, with `stages:` + one job per
 *     component, each job carrying a `script:`/`stage:`/`image:`).
 *  2. Jobs map onto components in wave order — a component's job lands in
 *     the same wave `resolveComponentGraph` (the driver's own graph
 *     resolution, ../driver.ts) computes, and depends (`needs:`) only on its
 *     own `dependsOn` edges, never on unrelated jobs.
 *  3. A cross-cutting generator change (e.g. "sign every image before
 *     deploy") is a single edit to the generator's options — reflected in
 *     every job's script — never a per-component edit.
 */

import { describe, test, expect } from "vitest";
import { parseYAML } from "../yaml";
import { generateGitlabPipeline } from "./generate-gitlab";
import { resolveComponentGraph, DependencyCycleError, UnknownDependencyError, type DriverComponent } from "./driver";
import { searchService } from "./pilots/alb-ecs.pilot";
import { ordersTable } from "./pilots/dynamodb.pilot";

/** Real pilot components (#555) plus the shared-alb infra `search-service` depends on, as a realistic multi-wave input. */
function pilotComponents(): DriverComponent[] {
  return [
    { name: ordersTable.name, dependsOn: ordersTable.dependsOn, deploy: ordersTable.deploy },
    { name: "shared-alb", dependsOn: [], deploy: [] },
    { name: searchService.name, dependsOn: searchService.dependsOn, deploy: searchService.deploy },
  ];
}

describe("generateGitlabPipeline: structurally valid YAML", () => {
  test("produces YAML with a stages: list and one job per component", () => {
    const result = generateGitlabPipeline(pilotComponents(), { env: "staging" });

    const parsed = parseYAML(result.yaml);
    expect(Array.isArray(parsed.stages)).toBe(true);
    expect(parsed.stages).toEqual(["wave-1", "wave-2"]);

    for (const name of ["orders-table", "shared-alb", "search-service"]) {
      const job = parsed[name] as Record<string, unknown>;
      expect(job).toBeDefined();
      expect(typeof job.stage).toBe("string");
      expect(typeof job.image).toBe("string");
      expect(Array.isArray(job.script)).toBe(true);
      expect((job.script as string[]).length).toBeGreaterThan(0);
    }
  });

  test("every job's script is a single thin trigger invocation, not inlined deploy steps", () => {
    const result = generateGitlabPipeline(pilotComponents(), { env: "staging" });
    const parsed = parseYAML(result.yaml);

    for (const job of result.jobs) {
      const props = parsed[job.jobName] as Record<string, unknown>;
      const script = props.script as string[];
      // The thin trigger: hands off to the component via `chant run`, carrying
      // no build/publish/apply/cfn-deploy/ecs-update-service keywords — those
      // verbs live in the component's own composition, never in the YAML.
      expect(script.some((line) => line.includes(`chant run --components ${job.component}`))).toBe(true);
      for (const line of script) {
        expect(line).not.toMatch(/docker build|docker push|aws cloudformation|ecs update-service/);
      }
    }
  });

  test("an empty component set produces a pipeline with no stages and no jobs", () => {
    const result = generateGitlabPipeline([]);
    expect(result.stages).toEqual([]);
    expect(result.jobs).toEqual([]);
    const parsed = parseYAML(result.yaml);
    expect(parsed.stages).toEqual([]);
  });

  test("propagates a dependency cycle error the same way the interpret driver's own graph resolution does", () => {
    const cyclical: DriverComponent[] = [
      { name: "a", dependsOn: ["b"], deploy: [] },
      { name: "b", dependsOn: ["a"], deploy: [] },
    ];
    expect(() => generateGitlabPipeline(cyclical)).toThrow(DependencyCycleError);
  });

  test("propagates an unknown-dependency error for a dangling dependsOn", () => {
    const dangling: DriverComponent[] = [{ name: "a", dependsOn: ["ghost"], deploy: [] }];
    expect(() => generateGitlabPipeline(dangling)).toThrow(UnknownDependencyError);
  });
});

describe("generateGitlabPipeline: jobs map to components in wave order", () => {
  test("independent components share one stage; a dependent lands in a strictly later stage", () => {
    const components = pilotComponents();
    const { waves } = resolveComponentGraph(components);
    const result = generateGitlabPipeline(components);

    // Same wave count/membership as the driver's own graph resolution — no
    // separate, divergent ordering logic in the generator.
    expect(result.stages).toHaveLength(waves.length);

    const stageOf = (name: string) => result.jobs.find((j) => j.component === name)!.stage;
    expect(stageOf("orders-table")).toBe(stageOf("shared-alb")); // independent, same wave
    expect(result.stages.indexOf(stageOf("search-service"))).toBeGreaterThan(
      result.stages.indexOf(stageOf("shared-alb")),
    ); // dependent, later wave
  });

  test("a job's needs: are exactly its component's dependsOn edges, no more and no less", () => {
    const result = generateGitlabPipeline(pilotComponents());

    const ordersJob = result.jobs.find((j) => j.component === "orders-table")!;
    const albJob = result.jobs.find((j) => j.component === "shared-alb")!;
    const searchJob = result.jobs.find((j) => j.component === "search-service")!;

    expect(ordersJob.needs).toEqual([]);
    expect(albJob.needs).toEqual([]);
    expect(searchJob.needs).toEqual(["shared-alb"]);
  });

  test("a three-wave fan-out produces three stages in dependency order", () => {
    const components: DriverComponent[] = [
      { name: "base", dependsOn: [], deploy: [] },
      { name: "middle", dependsOn: ["base"], deploy: [] },
      { name: "top", dependsOn: ["middle"], deploy: [] },
    ];
    const result = generateGitlabPipeline(components);

    expect(result.stages).toEqual(["wave-1", "wave-2", "wave-3"]);
    expect(result.jobs.find((j) => j.component === "base")!.stage).toBe("wave-1");
    expect(result.jobs.find((j) => j.component === "middle")!.stage).toBe("wave-2");
    expect(result.jobs.find((j) => j.component === "top")!.stage).toBe("wave-3");
  });
});

describe("generateGitlabPipeline: a cross-cutting change is one generator edit, not per-pipeline", () => {
  test("adding extraScript (e.g. image signing) appears in every job with no per-component changes", () => {
    const components = pilotComponents();

    const before = generateGitlabPipeline(components, { env: "production" });
    for (const job of before.jobs) {
      const parsed = parseYAML(before.yaml);
      const script = (parsed[job.jobName] as Record<string, unknown>).script as string[];
      expect(script).not.toContain("cosign sign --yes $IMAGE_REF");
    }

    // Simulates the cross-cutting change from the epic's worked example
    // ("sign every image"): ONE edit to the generator's options, applied
    // uniformly, with the component declarations themselves untouched.
    const after = generateGitlabPipeline(components, {
      env: "production",
      extraScript: ["cosign sign --yes $IMAGE_REF"],
    });

    const parsedAfter = parseYAML(after.yaml);
    expect(after.jobs.length).toBe(before.jobs.length);
    for (const job of after.jobs) {
      const script = (parsedAfter[job.jobName] as Record<string, unknown>).script as string[];
      expect(script).toContain("cosign sign --yes $IMAGE_REF");
    }
  });

  test("changing the trigger command (runCommand) updates every job's script uniformly", () => {
    const components = pilotComponents();
    const result = generateGitlabPipeline(components, {
      runCommand: ["chant", "run", "--components", "{name}", "--env", "staging", "--temporal"],
    });
    const parsed = parseYAML(result.yaml);

    for (const job of result.jobs) {
      const script = (parsed[job.jobName] as Record<string, unknown>).script as string[];
      expect(script[0]).toBe(`chant run --components ${job.component} --env staging --temporal`);
    }
  });

  test("changing beforeScript (e.g. a registry login) prepends to every job uniformly", () => {
    const components = pilotComponents();
    const result = generateGitlabPipeline(components, {
      beforeScript: ["echo $CI_REGISTRY_PASSWORD | docker login -u $CI_REGISTRY_USER --password-stdin $CI_REGISTRY"],
    });
    const parsed = parseYAML(result.yaml);

    for (const job of result.jobs) {
      const script = (parsed[job.jobName] as Record<string, unknown>).script as string[];
      expect(script[0]).toMatch(/docker login/);
    }
  });
});

describe("generateGitlabPipeline: options", () => {
  test("emits a variables: block when provided", () => {
    const result = generateGitlabPipeline(pilotComponents(), {
      variables: { CHANT_ENV: "staging" },
    });
    const parsed = parseYAML(result.yaml);
    expect(parsed.variables).toEqual({ CHANT_ENV: "staging" });
  });

  test("uses a custom image for every job when provided", () => {
    const result = generateGitlabPipeline(pilotComponents(), { image: "chant/cli:latest" });
    const parsed = parseYAML(result.yaml);
    for (const job of result.jobs) {
      expect((parsed[job.jobName] as Record<string, unknown>).image).toBe("chant/cli:latest");
    }
  });

  test("defaults env to production when not provided", () => {
    const result = generateGitlabPipeline(pilotComponents());
    const parsed = parseYAML(result.yaml);
    const job = parsed["shared-alb"] as Record<string, unknown>;
    expect((job.script as string[])[0]).toContain("--env production");
  });
});
