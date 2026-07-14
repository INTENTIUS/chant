/**
 * Tests for generate mode's component → GitHub Actions workflow YAML
 * synthesis (#891, epic #885). Mirrors the gitlab generator's own test suite
 * (`lexicons/gitlab/src/components/generate-pipeline.test.ts`) so both
 * providers prove the same seam contract:
 *
 *  1. A component set produces a structurally valid GitHub Actions workflow
 *     (parses back via `../yaml.ts`'s `parseYAML`, with `on:` + a `jobs:` map
 *     carrying one entry per component, each job with `runs-on:`/`steps:`).
 *  2. Jobs map onto components in wave order — a component's job depends
 *     (`needs:`) only on its own `dependsOn` edges, never on unrelated jobs,
 *     and lands in the same wave `resolveComponentGraph` (the driver's own
 *     graph resolution) computes — even though GitHub Actions has no `stage`
 *     concept, so ordering is expressed purely through `needs:`.
 *  3. A cross-cutting generator change (e.g. "sign every image before
 *     deploy") is a single edit to the generator's options — reflected in
 *     every job's steps — never a per-component edit.
 */

import { describe, test, expect } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGithubPipeline } from "./generate-pipeline";
import { resolveComponentGraph, DependencyCycleError, UnknownDependencyError, type DriverComponent } from "@intentius/chant/components/driver";
import { searchService } from "@intentius/chant/components/pilots/alb-ecs.pilot";
import { ordersTable } from "@intentius/chant/components/pilots/dynamodb.pilot";

/** Real pilot components (#555) plus the shared-alb infra `search-service` depends on, as a realistic multi-wave input. */
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
  const parsed = parseYAML(yaml);
  return (parsed.jobs ?? {}) as Record<string, ParsedJob>;
}

function runLines(job: ParsedJob): string[] {
  return job.steps.filter((s) => typeof s.run === "string").map((s) => s.run as string);
}

describe("generateGithubPipeline: cross-stack output threading (artifacts)", () => {
  test("a depended-upon component uploads its outputs as an artifact; its dependents download and seed from it", () => {
    // search-service dependsOn shared-alb; orders-table is depended on by nothing.
    const jobs = parsedJobs(generateGithubPipeline(pilotComponents()).yaml);

    // Producer: shared-alb hands its resolved outputs to a separate downstream
    // job, so it dumps them and uploads the file as a workflow artifact.
    const shared = jobs["shared-alb"];
    expect(runLines(shared).some((line) => line.includes("--dump-outputs shared-alb.outputs.json"))).toBe(true);
    const uploadStep = shared.steps.find((s) => s.uses === "actions/upload-artifact@v4");
    expect(uploadStep?.with).toEqual({ name: "shared-alb-outputs", path: "shared-alb.outputs.json" });

    // Consumer: search-service downloads shared-alb's uploaded artifact and
    // seeds from the dumped file so its stackOutput() references resolve.
    const svc = jobs["search-service"];
    const downloadStep = svc.steps.find((s) => s.uses === "actions/download-artifact@v4");
    expect(downloadStep?.with).toEqual({ name: "shared-alb-outputs", path: "." });
    expect(runLines(svc).some((line) => line.includes("--seed-outputs shared-alb.outputs.json"))).toBe(true);

    // A component nothing depends on neither dumps nor uploads an artifact.
    const orders = jobs["orders-table"];
    expect(runLines(orders).some((line) => line.includes("--dump-outputs"))).toBe(false);
    expect(orders.steps.some((s) => s.uses === "actions/upload-artifact@v4")).toBe(false);
    expect(orders.steps.some((s) => s.uses === "actions/download-artifact@v4")).toBe(false);
    expect(runLines(orders).some((line) => line.includes("--seed-outputs"))).toBe(false);
  });
});

describe("generateGithubPipeline: structurally valid YAML", () => {
  test("produces YAML with an on: trigger and one job per component under jobs:", () => {
    const result = generateGithubPipeline(pilotComponents(), { env: "staging" });

    const parsed = parseYAML(result.yaml);
    expect(parsed.on).toEqual({ workflow_dispatch: {} });
    expect(result.stages).toEqual(["wave-1", "wave-2"]);

    const jobs = parsedJobs(result.yaml);
    for (const name of ["orders-table", "shared-alb", "search-service"]) {
      const job = jobs[name];
      expect(job).toBeDefined();
      expect(job["runs-on"]).toBe("ubuntu-latest");
      expect(typeof job.container).toBe("string");
      expect(Array.isArray(job.steps)).toBe(true);
      expect(job.steps.length).toBeGreaterThan(0);
      // Every job starts with a checkout step — a job runs on a fresh runner
      // with no repo present, unlike GitLab's auto-cloned workspace.
      expect(job.steps[0].uses).toBe("actions/checkout@v4");
    }
  });

  test("every job's trigger step is a single thin invocation, not inlined deploy steps", () => {
    const result = generateGithubPipeline(pilotComponents(), { env: "staging" });
    const jobs = parsedJobs(result.yaml);

    for (const job of result.jobs) {
      const props = jobs[job.jobName];
      const lines = runLines(props);
      // The thin trigger: hands off to the component via `chant run`, carrying
      // no build/publish/apply/cfn-deploy/ecs-update-service keywords — those
      // verbs live in the component's own composition, never in the YAML.
      expect(lines.some((line) => line.includes(`chant run --components ${job.component}`))).toBe(true);
      for (const line of lines) {
        expect(line).not.toMatch(/docker build|docker push|aws cloudformation|ecs update-service/);
      }
    }
  });

  test("an empty component set produces a pipeline with no jobs", () => {
    const result = generateGithubPipeline([]);
    expect(result.stages).toEqual([]);
    expect(result.jobs).toEqual([]);
    const jobs = parsedJobs(result.yaml);
    expect(Object.keys(jobs)).toHaveLength(0);
  });

  test("propagates a dependency cycle error the same way the interpret driver's own graph resolution does", () => {
    const cyclical: DriverComponent[] = [
      { name: "a", dependsOn: ["b"], deploy: [] },
      { name: "b", dependsOn: ["a"], deploy: [] },
    ];
    expect(() => generateGithubPipeline(cyclical)).toThrow(DependencyCycleError);
  });

  test("propagates an unknown-dependency error for a dangling dependsOn", () => {
    const dangling: DriverComponent[] = [{ name: "a", dependsOn: ["ghost"], deploy: [] }];
    expect(() => generateGithubPipeline(dangling)).toThrow(UnknownDependencyError);
  });
});

describe("generateGithubPipeline: jobs map to components in wave order", () => {
  test("independent components share a wave; a dependent lands in a strictly later wave", () => {
    const components = pilotComponents();
    const { waves } = resolveComponentGraph(components);
    const result = generateGithubPipeline(components);

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
    const result = generateGithubPipeline(pilotComponents());

    const ordersJob = result.jobs.find((j) => j.component === "orders-table")!;
    const albJob = result.jobs.find((j) => j.component === "shared-alb")!;
    const searchJob = result.jobs.find((j) => j.component === "search-service")!;

    expect(ordersJob.needs).toEqual([]);
    expect(albJob.needs).toEqual([]);
    expect(searchJob.needs).toEqual(["shared-alb"]);

    // needs: renders in the YAML too, not just the result object.
    const jobs = parsedJobs(generateGithubPipeline(pilotComponents()).yaml);
    expect(jobs["search-service"].needs).toEqual(["shared-alb"]);
    expect(jobs["orders-table"].needs ?? []).toEqual([]);
  });

  test("a three-wave fan-out produces three waves in dependency order", () => {
    const components: DriverComponent[] = [
      { name: "base", dependsOn: [], deploy: [] },
      { name: "middle", dependsOn: ["base"], deploy: [] },
      { name: "top", dependsOn: ["middle"], deploy: [] },
    ];
    const result = generateGithubPipeline(components);

    expect(result.stages).toEqual(["wave-1", "wave-2", "wave-3"]);
    expect(result.jobs.find((j) => j.component === "base")!.stage).toBe("wave-1");
    expect(result.jobs.find((j) => j.component === "middle")!.stage).toBe("wave-2");
    expect(result.jobs.find((j) => j.component === "top")!.stage).toBe("wave-3");
  });
});

describe("generateGithubPipeline: a cross-cutting change is one generator edit, not per-pipeline", () => {
  test("adding extraScript (e.g. image signing) appears in every job with no per-component changes", () => {
    const components = pilotComponents();

    const before = generateGithubPipeline(components, { env: "production" });
    const beforeJobs = parsedJobs(before.yaml);
    for (const job of before.jobs) {
      expect(runLines(beforeJobs[job.jobName])).not.toContain("cosign sign --yes $IMAGE_REF");
    }

    // Simulates the cross-cutting change from the epic's worked example
    // ("sign every image"): ONE edit to the generator's options, applied
    // uniformly, with the component declarations themselves untouched.
    const after = generateGithubPipeline(components, {
      env: "production",
      extraScript: ["cosign sign --yes $IMAGE_REF"],
    });

    const afterJobs = parsedJobs(after.yaml);
    expect(after.jobs.length).toBe(before.jobs.length);
    for (const job of after.jobs) {
      expect(runLines(afterJobs[job.jobName])).toContain("cosign sign --yes $IMAGE_REF");
    }
  });

  test("changing the trigger command (runCommand) updates every job's script uniformly", () => {
    const components = pilotComponents();
    const result = generateGithubPipeline(components, {
      runCommand: ["chant", "run", "--components", "{name}", "--env", "staging", "--temporal"],
    });
    const jobs = parsedJobs(result.yaml);

    for (const job of result.jobs) {
      const lines = runLines(jobs[job.jobName]);
      // The runCommand prefix reflects in every job; output-threading flags
      // (--seed-outputs/--dump-outputs) may be appended per the dependency graph.
      expect(lines[0].startsWith(`chant run --components ${job.component} --env staging --temporal`)).toBe(true);
    }
  });

  test("changing beforeScript (e.g. a registry login) prepends to every job uniformly", () => {
    const components = pilotComponents();
    const result = generateGithubPipeline(components, {
      beforeScript: ["echo $REGISTRY_PASSWORD | docker login -u $REGISTRY_USER --password-stdin $REGISTRY"],
    });
    const jobs = parsedJobs(result.yaml);

    for (const job of result.jobs) {
      const lines = runLines(jobs[job.jobName]);
      expect(lines[0]).toMatch(/docker login/);
    }
  });
});

describe("generateGithubPipeline: options", () => {
  test("emits a top-level env: block when variables are provided", () => {
    const result = generateGithubPipeline(pilotComponents(), {
      variables: { CHANT_ENV: "staging" },
    });
    const parsed = parseYAML(result.yaml);
    expect(parsed.env).toEqual({ CHANT_ENV: "staging" });
  });

  test("omits the env: block when no variables are provided", () => {
    const result = generateGithubPipeline(pilotComponents());
    const parsed = parseYAML(result.yaml);
    expect(parsed.env).toBeUndefined();
  });

  test("uses a custom container image for every job when provided", () => {
    const result = generateGithubPipeline(pilotComponents(), { image: "chant/cli:latest" });
    const jobs = parsedJobs(result.yaml);
    for (const job of result.jobs) {
      expect(jobs[job.jobName].container).toBe("chant/cli:latest");
    }
  });

  test("defaults env to production when not provided", () => {
    const result = generateGithubPipeline(pilotComponents());
    const jobs = parsedJobs(result.yaml);
    expect(runLines(jobs["shared-alb"])[0]).toContain("--env production");
  });
});
