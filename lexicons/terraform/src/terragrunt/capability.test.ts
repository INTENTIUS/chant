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
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import {
  parseTerragruntFind,
  terragruntApplyCapability,
  terragruntListedWaves,
  terragruntUnitPinResolver,
  terragruntUnitPins,
  TerragruntWaveError,
  type TerragruntApplyDeps,
  type TerragruntExec,
} from "./index";
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
  file: string;
  args: string[];
  env: Record<string, string>;
}

/** Terragrunt as recorded: find, render with no dependency, and wave 1's plan and apply (`failPlan` swaps in a report with a failed unit). */
const stub = (calls: Call[], opts: { failPlan?: boolean; planJson?: (unit: string) => string | undefined } = {}): TerragruntExec => async (f, args, o) => {
  calls.push({ file: f, args: [...args], env: o.env });
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
        [at("--json-out-dir")!, "tfplan.json", opts.planJson?.(u) ?? read(`wave-1/json/${u}/tfplan.json`)],
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

const wave = (s: OpWavesSpec, cwd: string, exec: TerragruntExec, runHooks?: Parameters<typeof runOpWave>[0]["runHooks"], deps: Omit<TerragruntApplyDeps, "exec"> = {}) =>
  runOpWave({
    spec: s,
    specFile: "waves.json",
    wave: 1,
    cwd,
    show: () => ({ sha: "b".repeat(40), text: JSON.stringify(s) }),
    gates: memoryGateLedgerPort(),
    capabilities: new CapabilityRegistry().register(terragruntApplyCapability({ exec, ...deps })),
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

describe("units that pin their own releases (#4849)", () => {
  /** Where each Terragrunt call of the wave ran: the command, its units, the Terragrunt and TG_TF_PATH, and the out dir. */
  const runs = (calls: Call[]) =>
    calls.filter((c) => c.args[0] === "run").map((c) => ({
      cmd: c.args[c.args.indexOf("--") + 1],
      units: c.args.filter((_, i) => c.args[i - 1] === "--filter"),
      terragrunt: c.file,
      binary: c.env.TG_TF_PATH,
      outDir: c.args[c.args.indexOf("--out-dir") + 1],
    }));
  const prodPinned: TerragruntApplyDeps["resolveUnit"] = (unit) => (unit === "live/prod/vpc" ? { terragrunt: "/opt/tg-1.1.5/terragrunt", binary: "/opt/tofu-1.9.0/tofu" } : {});

  it("a together wave plans and applies one run --all per pair of releases, each with its own binaries and saved plans", async () => {
    const dir = tmp();
    const calls: Call[] = [];
    const s = { ...spec(dir), step: { ...spec(dir).step!, terragrunt: "/opt/tg/terragrunt", binary: "/opt/tofu/tofu" } };
    const result = await wave(s, dir, stub(calls), undefined, { resolveUnit: prodPinned });
    expect(result.exitCode).toBe(0);
    const r = runs(calls);
    expect(r.map(({ cmd, units, terragrunt, binary }) => ({ cmd, units, terragrunt, binary }))).toEqual([
      { cmd: "plan", units: ["{./live/dev/vpc}"], terragrunt: "/opt/tg/terragrunt", binary: "/opt/tofu/tofu" },
      { cmd: "plan", units: ["{./live/prod/vpc}"], terragrunt: "/opt/tg-1.1.5/terragrunt", binary: "/opt/tofu-1.9.0/tofu" },
      { cmd: "apply", units: ["{./live/dev/vpc}"], terragrunt: "/opt/tg/terragrunt", binary: "/opt/tofu/tofu" },
      { cmd: "apply", units: ["{./live/prod/vpc}"], terragrunt: "/opt/tg-1.1.5/terragrunt", binary: "/opt/tofu-1.9.0/tofu" },
    ]);
    // Each group applies the plans it saved, in a directory of its own.
    expect(r[2]!.outDir).toBe(r[0]!.outDir);
    expect(r[3]!.outDir).toBe(r[1]!.outDir);
    expect(r[0]!.outDir).not.toBe(r[1]!.outDir);
    expect(result.applied).toEqual(["live/dev/vpc", "live/prod/vpc"]);
    // Each unit keeps its own member digest, beside the wave plan's.
    const members = result.decision!.members.map((m) => m.member);
    expect(members).toEqual(["live/dev/vpc", "live/prod/vpc"]);
    for (const unit of ["live/dev/vpc", "live/prod/vpc"]) {
      const file = JSON.parse(readFileSync(join(dir, `.chant/op-waves/tf-apply/wave-1/${unit.replaceAll("/", "_")}.plan.json`), "utf-8")) as { artifact: { planJson: string } };
      expect(JSON.parse(readFileSync(file.artifact.planJson, "utf-8"))).toEqual(JSON.parse(read(`wave-1/json/${unit}/tfplan.json`)));
    }
  });

  it("a wave whose units all run the step's releases plans as one run --all, with the same wave plan digest", async () => {
    const cap = terragruntApplyCapability({ exec: stub([]), resolveUnit: () => ({}) });
    const dir = tmp();
    const members = ["live/dev/vpc", "live/prod/vpc"].map((unit) => ({ component: unit, step: { unit, dir }, input: { unit, dir }, ctx: { env: "prod" } }));
    const calls: Call[] = [];
    const planned = await terragruntApplyCapability({ exec: stub(calls), resolveUnit: () => ({}) }).planGroup!({ env: "prod" } as never, members as never);
    expect(runs(calls).map((c) => c.cmd)).toEqual(["plan"]);
    expect(planned.digest).toBe(computePlanDigest("terragrunt-apply-wave", { units: ["live/dev/vpc", "live/prod/vpc"], destroy: false }));
    expect(cap.kind).toBe("terragrunt-apply");
  });

  it("a wave planned run by run plans and applies each unit with its own releases", async () => {
    const dir = tmp();
    const calls: Call[] = [];
    const result = await wave(spec(dir, false), dir, stub(calls), undefined, { resolveUnit: prodPinned });
    expect(result.exitCode).toBe(0);
    expect(runs(calls).map(({ cmd, terragrunt, binary }) => [cmd, terragrunt, binary])).toEqual([
      ["plan", "terragrunt", undefined],
      ["plan", "/opt/tg-1.1.5/terragrunt", "/opt/tofu-1.9.0/tofu"],
      ["apply", "terragrunt", undefined],
      ["apply", "/opt/tg-1.1.5/terragrunt", "/opt/tofu-1.9.0/tofu"],
    ]);
  });

  it("reads a unit's pins as terragucci does, and asks the product where each pinned release is", async () => {
    const dir = tmp();
    const put = (path: string, text: string) => {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    };
    put("live/a/.opentofu-version", "# pinned\nv1.9.0\n");
    put("live/a/terragrunt.hcl", 'terragrunt_version_constraint = "= 1.1.5" # exact\n');
    put("live/b/main.tf", 'terraform {\n  required_version = "= 1.8.2"\n}\n');
    put("live/c/.opentofu-version", "latest\n");
    put("live/c/terragrunt.hcl", 'terragrunt_version_constraint = ">= 1.1"\n');
    put("live/d/.terraform-version", "1.13.1\n");
    expect(terragruntUnitPins(dir, "live/a", "tofu")).toEqual({ binary: { tool: "tofu", version: "1.9.0", source: ".opentofu-version" }, terragrunt: { version: "1.1.5", source: "terragrunt_version_constraint" } });
    expect(terragruntUnitPins(dir, "live/b", "/usr/bin/tofu")).toEqual({ binary: { tool: "tofu", version: "1.8.2", source: "required_version" } });
    expect(terragruntUnitPins(dir, "live/c", "tofu")).toEqual({});
    // A .terraform-version pins terraform only; a stand-in binary pins nothing.
    expect(terragruntUnitPins(dir, "live/d", "tofu")).toEqual({});
    expect(terragruntUnitPins(dir, "live/d", "terraform")).toEqual({ binary: { tool: "terraform", version: "1.13.1", source: ".terraform-version" } });
    expect(terragruntUnitPins(dir, "live/a", "choudoufu")).toEqual({ terragrunt: { version: "1.1.5", source: "terragrunt_version_constraint" } });
    // A pin the step's release already is runs the step's.
    const asked: string[] = [];
    const resolve = terragruntUnitPinResolver({
      release: (tool, version) => {
        asked.push(`${tool}@${version}`);
        return `/opt/${tool}-${version}/${tool}`;
      },
      carried: { tofu: "1.8.2" },
    });
    const input = { unit: "{target}", dir, binary: "tofu" };
    expect(await resolve("live/a", input)).toEqual({ binary: "/opt/tofu-1.9.0/tofu", terragrunt: "/opt/terragrunt-1.1.5/terragrunt" });
    expect(await resolve("live/b", input)).toEqual({});
    expect(await resolve("live/c", input)).toEqual({});
    expect(asked).toEqual(["tofu@1.9.0", "terragrunt@1.1.5"]);
  });

  it("units whose pins name the same releases share one run --all", async () => {
    const dir = tmp();
    const calls: Call[] = [];
    const result = await wave(spec(dir), dir, stub(calls), undefined, { resolveUnit: () => ({ binary: "/opt/tofu-1.9.0/tofu" }) });
    expect(result.exitCode).toBe(0);
    expect(runs(calls).map(({ cmd, units, binary }) => [cmd, units.length, binary])).toEqual([
      ["plan", 2, "/opt/tofu-1.9.0/tofu"],
      ["apply", 2, "/opt/tofu-1.9.0/tofu"],
    ]);
  });
});

describe("a unit whose plan changes only outputs (#4849)", () => {
  // The recorded live/dev/vpc plan, with its resource already in place and only its output changing.
  const outputOnly = (unit: string): string | undefined => {
    if (unit !== "live/dev/vpc") return undefined;
    const plan = JSON.parse(read(`wave-1/json/${unit}/tfplan.json`)) as { resource_changes: { change: Record<string, unknown> }[]; output_changes: Record<string, Record<string, unknown>> };
    for (const r of plan.resource_changes) r.change = { ...r.change, actions: ["no-op"], before: r.change.after };
    plan.output_changes.id = { ...plan.output_changes.id, actions: ["update"], before: "old-id" };
    return JSON.stringify(plan);
  };

  it("is a change, so digest.over changing keeps it in the wave digest", async () => {
    const decisionOf = async (over: "all" | "changing") => {
      const dir = tmp();
      const s: OpWavesSpec = { ...spec(dir), digest: { over } };
      const result = await wave(s, dir, stub([], { planJson: outputOnly }));
      expect(result.exitCode).toBe(0);
      return result.decision!;
    };
    const changing = await decisionOf("changing");
    expect(changing.members.find((m) => m.member === "live/dev/vpc")).not.toHaveProperty("empty");
    expect(changing.digest).toBe((await decisionOf("all")).digest);
  });
});
