/**
 * Mock outputs in Terragrunt waves (#3416), with Terragrunt stubbed. The
 * render and output text is what Terragrunt 1.1.6 printed on the five-unit
 * fixture; `terragrunt.acceptance.test.ts` runs the real binary.
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { composeChangeSet, type ChangeSetPart } from "@intentius/chant/change-set";
import { ProvisionalWaveMemberError, waveSetDigest } from "@intentius/chant/gated-waves";
import { groupChangeSet, renderPlanSummaryText } from "@intentius/chant/plan-summary";
import {
  applyTerragruntWave,
  checkTerragruntWaveMocks,
  describeMockRefusal,
  failMockedParts,
  markProvisional,
  parseRenderedDependencies,
  parseTerragruntOutputs,
  planTerragruntWave,
  PROVISIONAL_MARKER,
  TerragruntMockRefusal,
  terragruntMockReads,
  terragruntMockWarnings,
  terragruntWaveParts,
  upstreamOfConfigPath,
  parseTerragruntReport,
  type RenderedDependency,
  type TerragruntExec,
} from "./index";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "../__fixtures__/terragrunt/five-units");
const recorded = join(here, "../__fixtures__/terragrunt/recorded");
const read = (p: string): string => readFileSync(join(recorded, p), "utf8");

const tmps: string[] = [];
afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
});
const tmp = (): string => {
  const t = mkdtempSync(join(tmpdir(), "chant-tg-mocks-"));
  tmps.push(t);
  return t;
};

/** `terragrunt render --json` in live/dev/app, as 1.1.6 printed it (trimmed to the parts read). */
const RENDER_DEV_APP = JSON.stringify({
  dependencies: null,
  dependency: {
    live_dev_db: {
      config_path: "../db",
      enabled: null,
      mock_outputs: { id: "mock" },
      mock_outputs_allowed_terraform_commands: ["validate", "plan"],
      mock_outputs_merge_strategy_with_state: null,
      mock_outputs_merge_with_state: null,
      name: "live_dev_db",
      outputs: null,
      skip: null,
    },
    live_dev_vpc: {
      config_path: "../vpc",
      enabled: null,
      mock_outputs: { id: "mock" },
      mock_outputs_allowed_terraform_commands: ["validate", "plan"],
      mock_outputs_merge_strategy_with_state: null,
      mock_outputs_merge_with_state: null,
      name: "live_dev_vpc",
      outputs: null,
      skip: null,
    },
  },
  inputs: { name: "live-dev-app", upstream: ["mock", "mock"] },
});

/** `output -json` from an applied vpc, and from one never applied. */
const OUTPUT_APPLIED = `{\n  "id": {\n    "sensitive": false,\n    "type": "string",\n    "value": "live-dev-vpc-id"\n  }\n}\n`;
const OUTPUT_NONE = "{}\n";

const dep = (d: Partial<RenderedDependency> & { upstream: string }): RenderedDependency => ({ name: d.upstream.split("/").pop()!, mockOutputs: { id: "mock" }, mockAllowed: ["validate", "plan"], ...d });

describe("reading dependency blocks from terragrunt render", () => {
  it("takes each block's upstream relative to the unit, its mocks, allow-list and merge strategy", () => {
    expect(parseRenderedDependencies("live/dev/app", RENDER_DEV_APP, "/repo")).toEqual([
      { name: "live_dev_db", upstream: "live/dev/db", mockOutputs: { id: "mock" }, mockAllowed: ["validate", "plan"] },
      { name: "live_dev_vpc", upstream: "live/dev/vpc", mockOutputs: { id: "mock" }, mockAllowed: ["validate", "plan"] },
    ]);
  });

  it("reads skip_outputs (printed as skip), enabled = false and both merge attributes", () => {
    const doc = {
      dependency: {
        a: { name: "a", config_path: "/repo/live/a/terragrunt.hcl", skip: true, mock_outputs: { x: 1 } },
        b: { name: "b", config_path: "../b", enabled: false },
        c: { name: "c", config_path: "../c", mock_outputs_merge_with_state: true, mock_outputs: { x: 1 } },
        d: { name: "d", config_path: "../d", mock_outputs_merge_strategy_with_state: "no_merge" },
        e: { name: "e", config_path: "../e", mock_outputs_merge_strategy_with_state: "deep_map_only" },
      },
    };
    expect(parseRenderedDependencies("live/u", doc, ["/link", "/repo"])).toEqual([
      { name: "a", upstream: "live/a", mockOutputs: { x: 1 }, skipOutputs: true },
      { name: "b", upstream: "live/b", disabled: true },
      { name: "c", upstream: "live/c", mockOutputs: { x: 1 }, mergeStrategy: "shallow" },
      { name: "d", upstream: "live/d" },
      { name: "e", upstream: "live/e", mergeStrategy: "deep_map_only" },
    ]);
  });

  it("resolves config paths the way Terragrunt prints them", () => {
    expect(upstreamOfConfigPath("live/prod/app", "../../dev/vpc/", "/r")).toBe("live/dev/vpc");
    expect(upstreamOfConfigPath(".", "/private/var/r/live/vpc/terragrunt.hcl", ["/var/r", "/private/var/r"])).toBe("live/vpc");
    expect(upstreamOfConfigPath(".", "/elsewhere/vpc", "/r")).toBe("/elsewhere/vpc");
  });

  it("reads output -json with or without log lines before it", () => {
    expect(parseTerragruntOutputs(OUTPUT_APPLIED)).toEqual({ id: "live-dev-vpc-id" });
    expect(parseTerragruntOutputs(OUTPUT_NONE)).toEqual({});
    expect(parseTerragruntOutputs("INFO tofu: init\n{}")).toEqual({});
    expect(parseTerragruntOutputs("no json")).toBeUndefined();
  });
});

describe("which dependencies would read mock_outputs", () => {
  const reads = (deps: RenderedDependency[], outputs: Record<string, Record<string, unknown>>) =>
    terragruntMockReads({ dependencies: new Map([["live/app", deps]]), outputs: new Map(Object.entries(outputs)) });

  it("an upstream with no outputs, whether or not the block sets mocks", () => {
    expect(reads([dep({ upstream: "live/vpc" })], { "live/vpc": {} })).toEqual([
      { unit: "live/app", dependency: "vpc", upstream: "live/vpc", reason: "no-outputs" },
    ]);
    expect(reads([{ name: "vpc", upstream: "live/vpc" }], {})).toEqual([
      { unit: "live/app", dependency: "vpc", upstream: "live/vpc", reason: "no-outputs" },
    ]);
  });

  it("nothing when the upstream has real outputs and no merge strategy", () => {
    expect(reads([dep({ upstream: "live/vpc" })], { "live/vpc": { id: "real" } })).toEqual([]);
  });

  it("a partial mock: a merge strategy fills keys the real outputs lack", () => {
    const d = dep({ upstream: "live/vpc", mockOutputs: { id: "m", subnets: { a: "m", b: "m" } }, mergeStrategy: "shallow" });
    expect(reads([d], { "live/vpc": { id: "real" } })).toEqual([
      { unit: "live/app", dependency: "vpc", upstream: "live/vpc", reason: "partial", keys: ["subnets"] },
    ]);
    expect(reads([d], { "live/vpc": { id: "real", subnets: { a: "real" } } })).toEqual([]);
    expect(reads([{ ...d, mergeStrategy: "deep_map_only" }], { "live/vpc": { id: "real", subnets: { a: "real" } } })).toEqual([
      { unit: "live/app", dependency: "vpc", upstream: "live/vpc", reason: "partial", keys: ["subnets.b"] },
    ]);
    // Mocks not allowed for plan: Terragrunt does not merge them at plan.
    expect(reads([{ ...d, mockAllowed: ["validate"] }], { "live/vpc": { id: "real" } })).toEqual([]);
  });

  it("skip_outputs or enabled = false with mocks always reads the mock", () => {
    expect(reads([dep({ upstream: "live/a", skipOutputs: true }), dep({ upstream: "live/b", disabled: true }), { name: "c", upstream: "live/c", skipOutputs: true }], {})).toEqual([
      { unit: "live/app", dependency: "a", upstream: "live/a", reason: "skip-outputs" },
      { unit: "live/app", dependency: "b", upstream: "live/b", reason: "disabled" },
    ]);
  });

  it("the refusal names the upstream that must apply first", () => {
    const text = describeMockRefusal(reads([dep({ upstream: "live/vpc" })], {}));
    expect(text).toMatch(/not planned and is not gated/);
    expect(text).toMatch(/Apply live\/vpc first/);
    expect(text).toMatch(/live\/app \(dependency "vpc" on live\/vpc\): live\/vpc has no outputs yet/);
  });

  it("reads Terragrunt's mock warning from a plan log, relative to where it ran", () => {
    const log =
      "23:51:46.380 WARN   [live/dev/db] Config /private/r/live/dev/vpc/terragrunt.hcl is a dependency of /private/r/live/dev/db/terragrunt.hcl that has no outputs, but mock outputs provided and returning those in dependency output.\n";
    expect(terragruntMockWarnings(log + log, ["/r", "/private/r"])).toEqual([{ unit: "live/dev/db", upstream: "live/dev/vpc" }]);
  });
});

/** A planned wave-2 part set from the recorded fixture. */
function wave2Parts() {
  const units = ["live/dev/db", "live/prod/app"];
  const report = parseTerragruntReport(read("wave-2/plan-report.json"));
  const planFor = (u: string): unknown => JSON.parse(read(`wave-2/json/${u}/tfplan.json`));
  return terragruntWaveParts({ units, report, planFor, planner: "tofu" });
}

describe("provisional plans", () => {
  it("are left out of the change-set digest and refused by a wave's set digest", () => {
    const real = wave2Parts();
    const provisional = markProvisional(real);
    expect(provisional.every((p) => p.member.provisional === true)).toBe(true);
    const mixed = composeChangeSet([real[0]!, provisional[1]!]);
    expect(mixed.digest).toBe(composeChangeSet([real[0]!]).digest);
    expect(() => waveSetDigest(provisional.map((p) => ({ member: p.member.member, planDigest: p.member.planDigest!, provisional: p.member.provisional })))).toThrow(
      ProvisionalWaveMemberError,
    );
  });

  it("never fold into a group of real plans, even with the same change", () => {
    const real = wave2Parts()[0]!;
    // The same unit's plan under a second name: the same change, by the summary's rules.
    const twin = (member: string, provisional: boolean): ChangeSetPart => ({
      member: { ...real.member, member, ...(provisional ? { provisional: true as const } : {}) },
      entries: real.entries.map((e) => ({ ...e, member })),
    });
    const together = groupChangeSet(composeChangeSet([real, twin("copy/dev/db", false)]));
    expect(together.groups.map((g) => g.units)).toEqual([["copy/dev/db", "live/dev/db"]]);

    const summary = groupChangeSet(composeChangeSet([real, twin("copy/dev/db", true)]));
    expect(summary.groups.map((g) => [g.units, g.provisional])).toEqual([
      [["live/dev/db"], undefined],
      [["copy/dev/db"], true],
    ]);
    expect(summary.groups[1]!.id).not.toBe(summary.groups[0]!.id);
    expect(summary.groups[1]!.extends).toBeUndefined();
    expect(summary.groups.some((g) => g.outlier)).toBe(false);
    expect(renderPlanSummaryText(summary)).toMatch(/\(provisional\)/);
    expect(renderPlanSummaryText(summary).split("\n")[0]).toMatch(/1 provisional/);
  });

  it("a member the plan log shows reading a mock becomes a failed member", () => {
    const parts = failMockedParts(wave2Parts(), [{ unit: "live/dev/db", upstream: "live/dev/vpc" }]);
    expect(parts[0]!.member).toMatchObject({ status: "failed", planDigest: null });
    expect(parts[0]!.member.error).toMatch(/planned on mock_outputs: live\/dev\/vpc/);
    expect(parts[1]!.member.status).toBe("planned");
  });
});

describe("a wave's plan with the mock check, Terragrunt stubbed", () => {
  /** Answers render from the recorded text, output from `applied`, and records every call. */
  const stub = (seen: string[][], applied: Set<string>, planLog = ""): TerragruntExec => async (_f, args) => {
    seen.push([...args]);
    if (args[0] === "render") {
      const unit = args[args.indexOf("--working-dir") + 1]!;
      return { code: 0, stdout: unit === "live/dev/app" ? RENDER_DEV_APP : '{"dependency":null}', stderr: "" };
    }
    if (args.includes("output")) {
      const unit = args[args.indexOf("--working-dir") + 1]!;
      return { code: 0, stdout: applied.has(unit) ? OUTPUT_APPLIED : OUTPUT_NONE, stderr: "" };
    }
    const at = (flag: string): string => args[args.indexOf(flag) + 1]!;
    mkdirSync(dirname(at("--report-file")), { recursive: true });
    writeFileSync(at("--report-file"), JSON.stringify([{ Name: "live/dev/app", Result: "succeeded" }]));
    if (args.includes("plan")) {
      mkdirSync(join(at("--json-out-dir"), "live/dev/app"), { recursive: true });
      writeFileSync(join(at("--json-out-dir"), "live/dev/app/tfplan.json"), read("wave-2/json/live/dev/db/tfplan.json"));
      mkdirSync(join(at("--out-dir"), "live/dev/app"), { recursive: true });
      writeFileSync(join(at("--out-dir"), "live/dev/app/tfplan.tfplan"), "binary plan");
    }
    return { code: 0, stdout: "", stderr: planLog };
  };
  const repo = (): string => {
    const dir = tmp();
    cpSync(fixture, dir, { recursive: true });
    return dir;
  };

  it("refuses the wave before planning anything while an upstream has no outputs", async () => {
    const dir = repo();
    const seen: string[][] = [];
    const err = await planTerragruntWave({ dir, units: ["live/dev/app"], workDir: "w", exec: stub(seen, new Set(["live/dev/vpc"])) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TerragruntMockRefusal);
    expect((err as TerragruntMockRefusal).reads).toEqual([{ unit: "live/dev/app", dependency: "live_dev_db", upstream: "live/dev/db", reason: "no-outputs" }]);
    expect((err as Error).message).toMatch(/Apply live\/dev\/db first/);
    expect(seen.some((a) => a[0] === "run" && a.includes("--out-dir"))).toBe(false);
    expect(existsSync(join(dir, "w", "plans"))).toBe(false);
  });

  it("plans once every upstream has outputs", async () => {
    const dir = repo();
    const seen: string[][] = [];
    const plan = await planTerragruntWave({ dir, units: ["live/dev/app"], workDir: "w", exec: stub(seen, new Set(["live/dev/vpc", "live/dev/db"])) });
    expect(plan.provisional).toBe(false);
    expect(plan.parts.map((p) => [p.member.member, p.member.status, p.member.provisional])).toEqual([["live/dev/app", "planned", undefined]]);
    expect(seen.filter((a) => a.includes("output")).map((a) => a[a.indexOf("--working-dir") + 1]).sort()).toEqual(["live/dev/db", "live/dev/vpc"]);
  });

  it("checks the plan log after the fact", async () => {
    const dir = repo();
    const log = `WARN [live/dev/app] Config ${dir}/live/dev/db/terragrunt.hcl is a dependency of ${dir}/live/dev/app/terragrunt.hcl that has no outputs, but mock outputs provided and returning those in dependency output.`;
    const plan = await planTerragruntWave({ dir, units: ["live/dev/app"], workDir: "w", exec: stub([], new Set(["live/dev/vpc", "live/dev/db"]), log) });
    expect(plan.parts[0]!.member).toMatchObject({ status: "failed", planDigest: null });
  });

  it("a provisional plan skips the check, marks its members, and is never applied", async () => {
    const dir = repo();
    const seen: string[][] = [];
    const plan = await planTerragruntWave({ dir, units: ["live/dev/app"], workDir: "w", provisional: true, exec: stub(seen, new Set()) });
    expect(plan.provisional).toBe(true);
    expect(seen.some((a) => a[0] === "render" || a.includes("output"))).toBe(false);
    expect(plan.parts[0]!.member).toMatchObject({ status: "planned", provisional: true });
    expect(existsSync(join(dir, "w", PROVISIONAL_MARKER))).toBe(true);
    const before = seen.length;
    await expect(applyTerragruntWave({ dir, units: ["live/dev/app"], workDir: "w", exec: stub(seen, new Set()) })).rejects.toThrow(/provisional/);
    expect(seen.length).toBe(before);

    // Planned for real once the upstream applied, the marker is gone and the plan applies.
    await planTerragruntWave({ dir, units: ["live/dev/app"], workDir: "w", exec: stub(seen, new Set(["live/dev/vpc", "live/dev/db"])) });
    expect(existsSync(join(dir, "w", PROVISIONAL_MARKER))).toBe(false);
    const applied = await applyTerragruntWave({ dir, units: ["live/dev/app"], workDir: "w", exec: stub(seen, new Set()) });
    expect(applied.results.map((r) => r.status)).toEqual(["succeeded"]);
  });

  it("refuses when an upstream's outputs cannot be read", async () => {
    const dir = repo();
    const exec: TerragruntExec = async (f, args, o) =>
      args.includes("output") ? { code: 1, stdout: "", stderr: "Error: backend not reachable" } : stub([], new Set())(f, args, o);
    await expect(checkTerragruntWaveMocks({ dir, units: ["live/dev/app"], exec })).rejects.toThrow(/could not read the outputs of live\/dev\/db.*backend not reachable/s);
  });
});
