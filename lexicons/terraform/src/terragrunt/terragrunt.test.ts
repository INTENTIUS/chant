/**
 * Terragrunt units as roots (#3414), against output recorded from Terragrunt
 * 1.1.6 and OpenTofu 1.12.5 on the five-unit fixture
 * (`../__fixtures__/terragrunt/`, re-recorded by its `record.ts`). Nothing
 * here runs Terragrunt; `terragrunt.acceptance.test.ts` does.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { composeChangeSet } from "@intentius/chant/change-set";
import {
  applyTerragruntWave,
  discoverTerragruntUnits,
  matchesUnitGlob,
  parseTerragruntFind,
  parseTerragruntReport,
  planTerragruntWave,
  stackOfUnit,
  terraformBinaryWarnings,
  terragruntDependents,
  terragruntEnv,
  terragruntFindArgs,
  terragruntUnitResults,
  terragruntVersionProblem,
  terragruntWaveArgs,
  TerragruntWaveError,
  terragruntWaveParts,
  terragruntWaves,
  type TerragruntExec,
} from "./index";

const recorded = join(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/terragrunt/recorded");
const read = (p: string): string => readFileSync(join(recorded, p), "utf8");
const units = parseTerragruntFind(read("find.json"));

const tmps: string[] = [];
afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
});
const tmp = (): string => {
  const t = mkdtempSync(join(tmpdir(), "chant-tg-test-"));
  tmps.push(t);
  return t;
};

describe("Terragrunt version floor", () => {
  it("runs 1.1 and later, release candidates included", () => {
    expect(terragruntVersionProblem(read("version.txt"))).toBeUndefined();
    expect(terragruntVersionProblem("terragrunt version v1.2.0-rc1")).toBeUndefined();
    expect(terragruntVersionProblem("terragrunt version v2.0.0")).toBeUndefined();
  });
  it("refuses 1.0 and the 0.x line, and output with no version", () => {
    expect(terragruntVersionProblem("terragrunt version v1.0.3")).toMatch(/older than 1\.1\.0/);
    expect(terragruntVersionProblem("terragrunt version v0.93.4")).toMatch(/older than 1\.1\.0/);
    expect(terragruntVersionProblem("command not found")).toMatch(/could not read a version/);
  });
});

describe("discovery from terragrunt find", () => {
  it("asks for the DAG with dependencies, excludes catalog templates and the cache, and leaves .terragrunt-filters on", () => {
    const args = terragruntFindArgs({ exclude: ["sandbox/**"] });
    expect(args.slice(0, 4)).toEqual(["find", "--json", "--dag", "--dependencies"]);
    expect(args).toContain("!./catalog/**");
    expect(args).toContain("!./**/.terragrunt-cache/**");
    expect(args).toContain("!./sandbox/**");
    expect(args).not.toContain("--no-filters-file");
  });

  it("reads the five units with their edges, and not the catalog template", () => {
    expect(units.map((u) => u.path)).toEqual(["live/dev/vpc", "live/prod/vpc", "live/dev/db", "live/prod/app", "live/dev/app"]);
    expect(Object.fromEntries(units.map((u) => [u.path, u.dependencies]))).toEqual({
      "live/dev/vpc": [],
      "live/prod/vpc": [],
      "live/dev/db": ["live/dev/vpc"],
      "live/prod/app": ["live/prod/vpc"],
      "live/dev/app": ["live/dev/db", "live/dev/vpc"],
    });
    expect(units[0]!.include).toEqual({ root: "root.hcl" });
    expect(units[0]!.reading).toEqual(["modules/thing/main.tf", "root.hcl"]);
  });

  it("drops stacks and malformed rows, and refuses output that is not an array", () => {
    expect(parseTerragruntFind([{ type: "stack", path: "live" }, { type: "unit" }, { type: "unit", path: "./a/" }])).toEqual([
      { path: "a", dependencies: [] },
    ]);
    expect(parseTerragruntFind("")).toEqual([]);
    expect(() => parseTerragruntFind("{}")).toThrow(/did not print an array/);
  });

  it("runs find in the project directory and passes TG_TF_PATH only when a binary is named", async () => {
    const calls: Array<{ args: readonly string[]; env: Record<string, string> }> = [];
    const exec: TerragruntExec = async (_f, args, o) => {
      calls.push({ args, env: o.env });
      return { code: 0, stdout: read("find.json"), stderr: "" };
    };
    const dir = tmp();
    const found = await discoverTerragruntUnits({ dir, exec });
    expect(found.units).toHaveLength(5);
    expect(calls[0]!.env).toEqual({});
    await discoverTerragruntUnits({ dir, exec, binary: "tofu" });
    expect(calls[1]!.env).toEqual({ TG_TF_PATH: "tofu" });
  });
});

describe("terraform_binary beside a named binary", () => {
  it("warns for a unit, or a file it includes, that names another binary, and not for one naming the same", () => {
    const dir = tmp();
    const write = (p: string, text: string): void => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), text);
    };
    write("a/terragrunt.hcl", 'terraform_binary = "terraform"\n');
    write("b/terragrunt.hcl", 'include "root" { path = find_in_parent_folders("root.hcl") }\n');
    write("root.hcl", 'terraform_binary = get_env("TF", "terraform")\n');
    write("c/terragrunt.hcl", 'terraform_binary = "tofu"\n');
    write("d/terragrunt.hcl", "inputs = {}\n");
    const warnings = terraformBinaryWarnings(
      dir,
      [
        { path: "a", dependencies: [] },
        { path: "b", dependencies: [], include: { root: "root.hcl" } },
        { path: "c", dependencies: [] },
        { path: "d", dependencies: [] },
      ],
      "tofu",
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/^a: a\/terragrunt\.hcl sets terraform_binary = "terraform".*TG_TF_PATH=tofu overrides it/);
    expect(warnings[1]).toMatch(/^b: root\.hcl sets terraform_binary = get_env/);
  });
});

describe("the unit graph as an order source", () => {
  it("layers the units into waves, roots first", () => {
    expect(terragruntWaves(units)).toEqual([["live/dev/vpc", "live/prod/vpc"], ["live/dev/db", "live/prod/app"], ["live/dev/app"]]);
  });

  it("puts canary globs first, layered among themselves", () => {
    expect(terragruntWaves(units, { canary: ["live/dev/**"] })).toEqual([
      ["live/dev/vpc"],
      ["live/dev/db"],
      ["live/dev/app"],
      ["live/prod/vpc"],
      ["live/prod/app"],
    ]);
  });

  it("refuses a canary that reads a unit that is not a canary", () => {
    expect(() => terragruntWaves(units, { canary: ["live/dev/app"] })).toThrow(TerragruntWaveError);
    expect(() => terragruntWaves(units, { canary: ["live/dev/app"] })).toThrow(/depends on live\/dev\/db, live\/dev\/vpc/);
  });

  it("orders a subset without waiting on units outside it", () => {
    const subset = units.filter((u) => ["live/dev/db", "live/dev/app"].includes(u.path));
    expect(terragruntWaves(subset)).toEqual([["live/dev/db"], ["live/dev/app"]]);
  });

  it("refuses a cycle", () => {
    expect(() =>
      terragruntWaves([
        { path: "a", dependencies: ["b"] },
        { path: "b", dependencies: ["a"] },
      ]),
    ).toThrow(/cycle among: a, b/);
  });

  it("finds dependents through the graph, and through the edges a caller chooses", () => {
    expect(terragruntDependents(units, ["live/dev/vpc"])).toEqual(["live/dev/app", "live/dev/db"]);
    expect(terragruntDependents(units, ["live/prod/app"])).toEqual([]);
    const dependencyOnly = (u: { path: string; dependencies: string[] }): string[] => (u.path === "live/dev/app" ? ["live/dev/db"] : u.dependencies);
    expect(terragruntDependents(units, ["live/dev/vpc"], dependencyOnly)).toEqual(["live/dev/app", "live/dev/db"]);
    expect(terragruntDependents(units, ["live/dev/db"], () => [])).toEqual([]);
  });

  it("matches unit globs by segment", () => {
    expect(matchesUnitGlob("live/dev/vpc", "live/dev/**")).toBe(true);
    expect(matchesUnitGlob("live/dev/vpc", "live/*/vpc")).toBe(true);
    expect(matchesUnitGlob("live/dev/vpc", "live/*")).toBe(false);
    expect(matchesUnitGlob("live/dev/vpc", "**/vpc")).toBe(true);
    expect(matchesUnitGlob("live/dev/vpc", "./live/dev/vpc")).toBe(true);
    expect(stackOfUnit("live/dev/vpc")).toBe("live/dev");
    expect(stackOfUnit("vpc")).toBe(".");
  });
});

describe("one run --all per wave", () => {
  it("plans exactly the wave's units by path, with the filters file off and every output named", () => {
    const args = terragruntWaveArgs({
      units: ["live/prod/vpc", "live/dev/vpc"],
      command: "plan",
      outDir: "/w/plans",
      jsonOutDir: "/w/json",
      reportFile: "/w/report.json",
      parallelism: 16,
    });
    expect(args).toEqual([
      "run", "--all", "--non-interactive", "--no-color", "--no-filters-file",
      "--filter", "{./live/dev/vpc}", "--filter", "{./live/prod/vpc}",
      "--out-dir", "/w/plans", "--json-out-dir", "/w/json",
      "--report-file", "/w/report.json", "--report-format", "json",
      "--parallelism", "16",
      "--", "plan",
    ]);
  });

  it("applies with the same filters from the saved plans, and a destroy wave allows destroys on both", () => {
    const apply = terragruntWaveArgs({ units: ["live/dev/vpc"], command: "apply", outDir: "/w/plans", jsonOutDir: "/w/json", reportFile: "/w/a.json", destroy: true });
    expect(apply).toContain("--filter-allow-destroy");
    expect(apply).not.toContain("--json-out-dir");
    expect(apply.slice(apply.indexOf("--"))).toEqual(["--", "apply"]);
    const plan = terragruntWaveArgs({ units: ["live/dev/vpc"], command: "plan", outDir: "/w/plans", reportFile: "/w/p.json", destroy: true });
    expect(plan).toContain("--filter-allow-destroy");
    expect(plan.slice(plan.indexOf("--"))).toEqual(["--", "plan", "-destroy"]);
  });

  it("refuses an empty wave, which with no filter would run every unit", () => {
    expect(() => terragruntWaveArgs({ units: [], command: "plan", outDir: "o", reportFile: "r" })).toThrow(/at least one unit/);
    expect(() => terragruntWaveArgs({ units: ["a"], command: "plan", outDir: "o", reportFile: "r", parallelism: 0 })).toThrow(/parallelism/);
  });

  it("sets TG_TF_PATH only when the project names a binary", () => {
    expect(terragruntEnv(undefined)).toEqual({});
    expect(terragruntEnv("choudoufu")).toEqual({ TG_TF_PATH: "choudoufu" });
  });
});

describe("the run report reaches the change set", () => {
  it("makes each planned unit a member named by its path, scoped to its stack", () => {
    const wave = ["live/dev/db", "live/prod/app"];
    const parts = terragruntWaveParts({
      units: wave,
      report: parseTerragruntReport(read("wave-2/plan-report.json")),
      planFor: (u) => JSON.parse(read(`wave-2/json/${u}/tfplan.json`)),
      planner: "tofu",
    });
    const doc = composeChangeSet(parts);
    expect(doc.members.map((m) => [m.member, m.status, m.scope, m.planner])).toEqual([
      ["live/dev/db", "planned", "live/dev", "tofu"],
      ["live/prod/app", "planned", "live/prod", "tofu"],
    ]);
    expect(doc.members.every((m) => typeof m.planDigest === "string")).toBe(true);
    const db = doc.entries.find((e) => e.member === "live/dev/db")!;
    expect(db).toMatchObject({ address: "terraform_data.this", action: "create" });
    // Planned after wave 1 applied: the upstream is the real output, not the mock.
    expect(db.attributes.find((a) => a.path === "input")?.after).toEqual({ name: "live-dev-db", upstream: ["live-dev-vpc-id"] });
  });

  it("makes a failed unit, one that exited early and one the report leaves out failed members", () => {
    const report = parseTerragruntReport(read("failed-plan-report.json"));
    const wave = ["live/dev/db", "live/dev/app", "live/prod/app", "live/prod/vpc"];
    const results = terragruntUnitResults(wave, report);
    expect(results.map((r) => [r.unit, r.status, r.result])).toEqual([
      ["live/dev/app", "failed", "early exit"],
      ["live/dev/db", "failed", "failed"],
      ["live/prod/app", "succeeded", "succeeded"],
      ["live/prod/vpc", "failed", "not run"],
    ]);
    expect(results[0]!.error).toBe("early exit (ancestor error: db)");
    expect(results[1]!.error).toMatch(/^failed \(run error: error occurred:/);

    const prodApp = JSON.parse(read("wave-2/json/live/prod/app/tfplan.json"));
    const doc = composeChangeSet(
      terragruntWaveParts({ units: wave, report, planFor: (u) => (u === "live/prod/app" ? prodApp : undefined), planner: "tofu" }),
    );
    expect(doc.summary.failed).toEqual(["live/dev/app", "live/dev/db", "live/prod/vpc"]);
    expect(doc.members.find((m) => m.member === "live/prod/vpc")).toMatchObject({ status: "failed", planDigest: null, error: expect.stringMatching(/run report/) });
  });

  it("does not take a succeeded unit with no plan JSON as planned", () => {
    const report = parseTerragruntReport(read("wave-1/plan-report.json"));
    const [part] = terragruntWaveParts({ units: ["live/dev/vpc"], report, planFor: () => undefined, planner: "tofu" });
    expect(part!.member).toMatchObject({ status: "failed", planDigest: null, error: expect.stringMatching(/no plan JSON/) });
  });
});

describe("a wave's plan and apply, with Terragrunt stubbed", () => {
  /** A stub that writes what Terragrunt wrote for wave 1 into the directories the args name. */
  const stub = (seen: string[][]): TerragruntExec => async (_f, args) => {
    seen.push([...args]);
    const at = (flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const report = at("--report-file")!;
    mkdirSync(dirname(report), { recursive: true });
    const cmd = args[args.indexOf("--") + 1];
    writeFileSync(report, read(cmd === "plan" ? "wave-1/plan-report.json" : "wave-1/apply-report.json"));
    if (cmd === "plan") {
      for (const u of ["live/dev/vpc", "live/prod/vpc"]) {
        for (const [dir, file, text] of [
          [at("--json-out-dir")!, "tfplan.json", read(`wave-1/json/${u}/tfplan.json`)],
          [at("--out-dir")!, "tfplan.tfplan", "binary plan"],
        ] as const) {
          mkdirSync(join(dir, u), { recursive: true });
          writeFileSync(join(dir, u, file), text);
        }
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };

  it("plans into the work directory, clears what an earlier attempt left, and applies the saved plans", async () => {
    const dir = tmp();
    const seen: string[][] = [];
    const workDir = ".chant/terragrunt/wave-1";
    // A plan JSON from an earlier attempt for a unit that will not plan this time.
    mkdirSync(join(dir, workDir, "json/live/dev/app"), { recursive: true });
    writeFileSync(join(dir, workDir, "json/live/dev/app/tfplan.json"), "{}");
    const plan = await planTerragruntWave({ dir, units: ["live/dev/vpc", "live/prod/vpc"], workDir, exec: stub(seen) });
    expect(plan.parts.map((p) => [p.member.member, p.member.status])).toEqual([
      ["live/dev/vpc", "planned"],
      ["live/prod/vpc", "planned"],
    ]);
    expect(plan.parts[0]!.member.planner).toBe("tofu");
    expect(() => readFileSync(join(dir, workDir, "json/live/dev/app/tfplan.json"))).toThrow();

    const applied = await applyTerragruntWave({ dir, units: ["live/dev/vpc", "live/prod/vpc"], workDir, exec: stub(seen) });
    expect(applied.results.every((r) => r.status === "succeeded")).toBe(true);
    const filters = (args: string[]): string[] => args.filter((_, i) => args[i - 1] === "--filter");
    expect(filters(seen[1]!)).toEqual(filters(seen[0]!));
    expect(seen[1]![seen[1]!.indexOf("--out-dir") + 1]).toBe(seen[0]![seen[0]!.indexOf("--out-dir") + 1]);
  });

  it("refuses to apply a unit with no saved plan, before running anything", async () => {
    const dir = tmp();
    const seen: string[][] = [];
    await expect(applyTerragruntWave({ dir, units: ["live/dev/vpc"], workDir: "w", exec: stub(seen) })).rejects.toThrow(/no saved plan for live\/dev\/vpc/);
    expect(seen).toEqual([]);
  });
});
