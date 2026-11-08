/**
 * `terragrunt-apply` (#4842): a Terragrunt repo's units as an op wave's
 * step, found at plan time and run with one `run --all`, against output
 * recorded from Terragrunt 1.1.6 (`../__fixtures__/terragrunt/`). Nothing
 * here runs Terragrunt.
 */

import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityRegistry } from "@intentius/chant/components/capability";
import { memoryGateLedgerPort, runOpWave, type OpWavesSpec } from "@intentius/chant/op";
import { parseTerragruntFind, terragruntApplyCapability, terragruntListedWaves, TerragruntWaveError, type TerragruntExec } from "./index";
import { terraformCapabilityPlugin } from "../components/capability-plugin";

const recorded = join(dirname(fileURLToPath(import.meta.url)), "../__fixtures__/terragrunt/recorded");
const read = (p: string): string => readFileSync(join(recorded, p), "utf8");
const units = parseTerragruntFind(read("find.json"));

const tmps: string[] = [];
afterAll(() => {
  for (const t of tmps) rmSync(t, { recursive: true, force: true });
});
const tmp = (): string => {
  const t = mkdtempSync(join(tmpdir(), "chant-tg-cap-"));
  tmps.push(t);
  return t;
};

interface Call {
  args: string[];
  env: Record<string, string>;
}

/** Terragrunt as recorded: find, render with no dependency, and wave 1's plan and apply (`failPlan` swaps in a report with a failed unit). */
const stub = (calls: Call[], opts: { failPlan?: boolean } = {}): TerragruntExec => async (_f, args, o) => {
  calls.push({ args: [...args], env: o.env });
  if (args[0] === "find") return { code: 0, stdout: read("find.json"), stderr: "" };
  if (args[0] === "render") return { code: 0, stdout: '{"dependency":null}', stderr: "" };
  const at = (flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const report = at("--report-file")!;
  mkdirSync(dirname(report), { recursive: true });
  const cmd = args[args.indexOf("--") + 1];
  const filtered = args.filter((_, i) => args[i - 1] === "--filter").map((f) => f.replace(/^\{\.\//, "").replace(/\}$/, ""));
  if (cmd === "plan" && opts.failPlan) {
    writeFileSync(report, JSON.stringify([{ Name: filtered[0], Result: "failed", Reason: "run error", Cause: "exit status 1" }]));
    return { code: 1, stdout: "", stderr: "" };
  }
  writeFileSync(report, read(cmd === "plan" ? "wave-1/plan-report.json" : "wave-1/apply-report.json"));
  if (cmd === "plan") {
    for (const u of filtered) {
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

const runAll = (calls: Call[]) => calls.filter((c) => c.args[0] === "run").map((c) => [c.args[c.args.indexOf("--") + 1], ...c.args.filter((_, i) => c.args[i - 1] === "--filter")]);

function spec(dir: string, together = true): OpWavesSpec {
  return {
    name: "tf-apply",
    op: "tf-apply",
    gateName: "wave-{k}",
    step: { kind: "terragrunt-apply", unit: "{target}", dir },
    waves: [
      { name: "layer-1", runs: [], discover: true, ...(together ? { together: true } : {}), gate: "never" },
      { name: "layer-2", runs: [], discover: true, ...(together ? { together: true } : {}), gate: "never" },
    ],
  };
}

const wave = (s: OpWavesSpec, cwd: string, exec: TerragruntExec, runHooks?: Parameters<typeof runOpWave>[0]["runHooks"]) =>
  runOpWave({
    spec: s,
    specFile: "waves.json",
    wave: 1,
    cwd,
    show: () => ({ sha: "b".repeat(40), text: JSON.stringify(s) }),
    gates: memoryGateLedgerPort(),
    capabilities: new CapabilityRegistry().register(terragruntApplyCapability({ exec })),
    log: () => {},
    ...(runHooks ? { runHooks } : {}),
  });

describe("terragrunt-apply finds a wave's units", () => {
  it("answers wave k of the graph's layers, and how many there are", async () => {
    const calls: Call[] = [];
    const cap = terragruntApplyCapability({ exec: stub(calls) });
    const dir = tmp();
    expect(await cap.discoverRuns!({ env: "prod", wave: { name: "layer", number: 1 } }, { unit: "{target}", dir })).toEqual({ targets: ["live/dev/vpc", "live/prod/vpc"], waves: 3 });
    expect(await cap.discoverRuns!({ env: "prod", wave: { name: "layer", number: 4 } }, { unit: "{target}", dir })).toEqual({ targets: [], waves: 3 });
    expect(calls[0]!.args.slice(0, 2)).toEqual(["find", "--json"]);
  });

  it("cuts the waves a pipeline lists again by the graph, and refuses a list that is stale", () => {
    expect(terragruntListedWaves([["live/dev/vpc", "live/dev/db", "live/dev/app"], ["live/prod/vpc", "live/prod/app"]], units)).toEqual([
      ["live/dev/vpc"],
      ["live/dev/db"],
      ["live/dev/app"],
      ["live/prod/vpc"],
      ["live/prod/app"],
    ]);
    expect(() => terragruntListedWaves([["live/dev/db"], ["live/dev/vpc"]], units)).toThrow(TerragruntWaveError);
    expect(() => terragruntListedWaves([["live/dev/db"], ["live/dev/vpc"]], units)).toThrow("live/dev/db depends on live/dev/vpc, which the pipeline applies in a later wave");
  });

  it("is one of the terraform lexicon's capabilities", () => {
    expect(terraformCapabilityPlugin.capabilities().map((c) => c.kind)).toContain("terragrunt-apply");
  });
});

describe("an op wave on terragrunt-apply (#4842)", () => {
  it("a together wave plans its units with one run --all and applies those saved plans with one", async () => {
    const dir = tmp();
    const calls: Call[] = [];
    const s = spec(dir);
    const result = await wave(s, dir, stub(calls));
    expect(result.exitCode).toBe(0);
    expect(runAll(calls)).toEqual([
      ["plan", "{./live/dev/vpc}", "{./live/prod/vpc}"],
      ["apply", "{./live/dev/vpc}", "{./live/prod/vpc}"],
    ]);
    // The apply reads the plans the plan saved.
    const outDirs = calls.filter((c) => c.args[0] === "run").map((c) => c.args[c.args.indexOf("--out-dir") + 1]);
    expect(outDirs[0]).toBe(outDirs[1]);
    expect(result.applied).toEqual(["live/dev/vpc", "live/prod/vpc"]);
    expect(result.decision?.discovered).toEqual({ waves: 3 });
    expect(result.decision?.members.map((m) => m.member)).toEqual(["live/dev/vpc", "live/prod/vpc"]);
    // Each unit's plan file names its plan document, for a cost hold and the after-plan hooks.
    const file = JSON.parse(readFileSync(join(dir, ".chant/op-waves/tf-apply/wave-1/live_dev_vpc.plan.json"), "utf-8")) as { artifact: { planJson: string } };
    expect(JSON.parse(readFileSync(file.artifact.planJson, "utf-8"))).toEqual(JSON.parse(read("wave-1/json/live/dev/vpc/tfplan.json")));
  });

  it("a wave planned run by run plans and applies each unit alone", async () => {
    const dir = tmp();
    const calls: Call[] = [];
    const result = await wave(spec(dir, false), dir, stub(calls));
    expect(result.exitCode).toBe(0);
    expect(runAll(calls)).toEqual([
      ["plan", "{./live/dev/vpc}"],
      ["plan", "{./live/prod/vpc}"],
      ["apply", "{./live/dev/vpc}"],
      ["apply", "{./live/prod/vpc}"],
    ]);
  });

  it("a run hook's environment reaches every Terragrunt call of the wave, and a check runs before the plan", async () => {
    const dir = tmp();
    const calls: Call[] = [];
    const checked: string[] = [];
    const result = await wave(spec(dir), dir, stub(calls), {
      name: "role",
      beforePlan: (r) => ({ env: { AWS_ROLE_ARN: "arn:aws:iam::1:role/apply" }, afterInit: async () => void checked.push(r.target) }),
    });
    expect(result.exitCode).toBe(0);
    expect(checked).toEqual(["live/dev/vpc", "live/prod/vpc"]);
    for (const c of calls.filter((x) => x.args[0] === "run")) expect(c.env.AWS_ROLE_ARN).toBe("arn:aws:iam::1:role/apply");
  });

  it("units the run hooks give different environments cannot run as one run --all", async () => {
    const dir = tmp();
    const calls: Call[] = [];
    await expect(wave(spec(dir), dir, stub(calls), { name: "role", beforePlan: (r) => ({ env: { AWS_ROLE_ARN: `arn:${r.target}` } }) })).rejects.toThrow(/one environment, and the run hooks gave them different ones/);
    expect(runAll(calls)).toEqual([]);
  });

  it("a unit that does not plan fails the wave, and nothing applies", async () => {
    const dir = tmp();
    const calls: Call[] = [];
    await expect(wave(spec(dir), dir, stub(calls, { failPlan: true }))).rejects.toThrow(/terragrunt-apply: live\/dev\/vpc: failed \(run error: exit status 1\)/);
    expect(runAll(calls).map((c) => c[0])).toEqual(["plan"]);
  });
});
