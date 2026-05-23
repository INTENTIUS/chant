import { describe, test, expect } from "vitest";
import { inferStages, type GhJobSummary } from "./stages";

function job(name: string, needs: string[] = [], id?: string): GhJobSummary {
  return { logicalId: id ?? name, originalName: name, needs };
}

describe("inferStages", () => {
  test("single job → build", () => {
    const r = inferStages([job("build")]);
    expect(r.stageByJob.get("build")).toBe("build");
    expect(r.stages).toEqual(["build"]);
  });

  test("name heuristic: lint goes to lint stage", () => {
    const r = inferStages([job("lint-check")]);
    expect(r.stageByJob.get("lint-check")).toBe("lint");
  });

  test("name heuristic: deploy at depth 0 still maps to deploy", () => {
    const r = inferStages([job("deploy-prod")]);
    expect(r.stageByJob.get("deploy-prod")).toBe("deploy");
  });

  test("linear chain build → test → deploy", () => {
    const r = inferStages([
      job("build"),
      job("test", ["build"]),
      job("deploy", ["test"]),
    ]);
    expect(r.stageByJob.get("build")).toBe("build");
    expect(r.stageByJob.get("test")).toBe("test");
    expect(r.stageByJob.get("deploy")).toBe("deploy");
    expect(r.stages).toEqual(["build", "test", "deploy"]);
  });

  test("diamond DAG", () => {
    const r = inferStages([
      job("setup"),
      job("test-unit", ["setup"]),
      job("test-int", ["setup"]),
      job("ship", ["test-unit", "test-int"]),
    ]);
    expect(r.stageByJob.get("setup")).toBe("build");
    expect(r.stageByJob.get("test-unit")).toBe("test");
    expect(r.stageByJob.get("test-int")).toBe("test");
    expect(r.stageByJob.get("ship")).toBe("deploy");
  });

  test("multiple roots", () => {
    const r = inferStages([
      job("build-a"),
      job("build-b"),
      job("test-a", ["build-a"]),
      job("test-b", ["build-b"]),
    ]);
    expect(r.stageByJob.get("build-a")).toBe("build");
    expect(r.stageByJob.get("build-b")).toBe("build");
    expect(r.stageByJob.get("test-a")).toBe("test");
    expect(r.stageByJob.get("test-b")).toBe("test");
  });

  test("cycle: each job in its own stage + needs-review", () => {
    const r = inferStages([
      job("a", ["b"]),
      job("b", ["a"]),
    ]);
    expect(r.stageByJob.get("a")).toBe("cycle-a");
    expect(r.stageByJob.get("b")).toBe("cycle-b");
    expect(r.provenance.some((p) => p.rule === "MIG-NEEDS-CYCLE-001")).toBe(true);
  });

  test("post-N for depths beyond deploy", () => {
    const r = inferStages([
      job("a"),
      job("b", ["a"]),
      job("c", ["b"]),
      job("d", ["c"]),
      job("e", ["d"]),
    ]);
    expect(r.stageByJob.get("d")).toBe("post-1");
    expect(r.stageByJob.get("e")).toBe("post-2");
  });

  test("stages sorted lint < build < test < deploy", () => {
    const r = inferStages([
      job("deploy"),
      job("test", ["build"]),
      job("build"),
      job("lint"),
    ]);
    // lint and build are both at depth 0, deploy is at depth 0 too (no needs)
    // The sort guarantees lint, build, deploy ordering for those at the same depth.
    const indexOf = (s: string) => r.stages.indexOf(s);
    expect(indexOf("lint")).toBeLessThan(indexOf("build"));
    expect(indexOf("build")).toBeLessThan(indexOf("test"));
    expect(indexOf("test")).toBeLessThan(indexOf("deploy"));
  });
});
