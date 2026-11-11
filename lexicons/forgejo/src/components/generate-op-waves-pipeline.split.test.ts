/**
 * #4987 on Forgejo: the split before-merge waves in Forgejo's dialect.
 * Forgejo ignores `permissions:`, so its job token can write; the jobs that
 * run the change's code keep it to the checkout step's environment, check
 * out with git and no actions/checkout (whose credentials stay in the git
 * config and whose post step takes the token again), and start every later
 * step without the token variables.
 */
import { describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";

const spec: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  plan: ["terragucci", "plan", "{target}", "--out", "{plan}"],
  apply: ["terragucci", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], setup: [{ run: "npm ci" }] },
    { name: "prod", runs: [{ target: "prod" }, { target: "prod-eu" }], shares: 2, idTokens: { CLOUD_TOKEN: "sts.example.com" } },
  ],
} as OpWavesSpec;
const options = { specFile: ".chant/op-waves/tf-apply.spec.json", bin: "terragucci", beforeMerge: { merge: "manual" as const } };

type Step = { name?: string; env?: Record<string, string>; run?: string; uses?: string };
type Job = { needs?: string[]; permissions?: Record<string, string>; env?: Record<string, string>; steps: Step[] };
const HEAD_CHECKOUT = 'git checkout -q --detach "$CHANT_BEFORE_MERGE_HEAD"';
const TOKEN = /\$\{\{\s*(github\.token|secrets\.)/;

describe("a split wave before merge on Forgejo (#4987)", () => {
  const { jobs } = parseYAML(generateForgejoOpWavesPipeline(spec, options).files[0]!.yaml) as { jobs: Record<string, Job> };
  const change = Object.entries(jobs).filter(([, job]) => job.steps.some((s) => s.run?.includes(HEAD_CHECKOUT)));

  test("each wave is a plan, a gate, its applying jobs and a record job", () => {
    expect(Object.keys(jobs)).toEqual(["wave-1-dev-plan", "wave-1-dev-gate", "wave-1-dev", "wave-1-dev-record", "wave-2-prod-plan", "wave-2-prod-gate", "wave-2-prod-share-1", "wave-2-prod-share-2", "wave-2-prod-record", "before-merge-done"]);
    expect(change.map(([n]) => n)).toEqual(["wave-1-dev-plan", "wave-1-dev", "wave-2-prod-plan", "wave-2-prod-share-1", "wave-2-prod-share-2"]);
  });

  test("no job that runs the change's code has a write token or persisted credentials", () => {
    for (const [name, job] of change) {
      // The dialect keeps id-token: write alone, for a wave's OIDC tokens.
      expect(Object.keys(job.permissions ?? {}).filter((s) => s !== "id-token"), name).toEqual([]);
      expect(job.steps.filter((s) => s.uses?.includes("checkout")), name).toEqual([]);
      expect(JSON.stringify(job.env ?? {}), name).not.toMatch(TOKEN);
      const checkout = job.steps.findIndex((s) => s.run?.includes(HEAD_CHECKOUT));
      expect(job.steps[checkout]!.env, name).toEqual({ CHANT_CHECKOUT_TOKEN: "${{ github.token }}" });
      job.steps.forEach((step, i) => {
        if (i !== 0 && i !== checkout) expect(JSON.stringify(step.env ?? {}), `${name} step ${i}`).not.toMatch(TOKEN);
        if (i > checkout && step.run !== undefined) expect(step.run.startsWith('if [ -z "${CHANT_NO_FORGE_TOKEN:-}" ]'), `${name} step ${step.name ?? i}`).toBe(true);
      });
    }
    expect(jobs["wave-2-prod-share-1"]!.permissions).toEqual({ "id-token": "write" });
    // The gate and record jobs check out the default branch alone.
    for (const name of ["wave-1-dev-gate", "wave-1-dev-record", "wave-2-prod-gate", "wave-2-prod-record"]) {
      expect(jobs[name]!.steps.some((s) => s.run?.includes(HEAD_CHECKOUT)), name).toBe(false);
      expect(jobs[name]!.steps.some((s) => /--phase (gate|record)$/.test(s.run ?? "")), name).toBe(true);
    }
  });
});

describe("a split wave hands its plan on without the runner's token on Forgejo (#4992)", () => {
  const withReport = { ...options, waveJobs: { dev: { report: { name: "Report", run: ["terragucci report"] }, artifact: { name: "report-{job}", step: "Keep the report", path: "terragucci-report" } } } };
  const { jobs } = parseYAML(generateForgejoOpWavesPipeline(spec, withReport as never).files[0]!.yaml) as { jobs: Record<string, Job & { outputs?: Record<string, string>; if?: string }> };
  const change = Object.entries(jobs).filter(([, job]) => job.steps.some((s) => s.run?.includes(HEAD_CHECKOUT)));

  test("no job that runs the change's code uploads an artifact: its files go on as its outputs, from a last step with no token", () => {
    expect(change.map(([n]) => n)).toEqual(["wave-1-dev-plan", "wave-1-dev", "wave-2-prod-plan", "wave-2-prod-share-1", "wave-2-prod-share-2"]);
    for (const [name, job] of change) {
      const checkout = job.steps.findIndex((s) => s.run?.includes(HEAD_CHECKOUT));
      // After the change's code could start, no `uses:` step: the artifact upload takes the runner's token.
      expect(job.steps.slice(checkout + 1).filter((s) => s.uses?.includes("upload-artifact")), name).toEqual([]);
      const last = job.steps.at(-1)! as Step & { id?: string };
      expect(last.id, name).toBe("chant-handover");
      expect(last.run!.startsWith('if [ -z "${CHANT_NO_FORGE_TOKEN:-}" ]'), name).toBe(true);
      expect(last.run, name).toContain('"${GITHUB_OUTPUT:-/dev/null}"');
      expect(job.outputs, name).toEqual({
        report_0: "${{ steps.chant-handover.outputs.report_0 }}",
        report_1: "${{ steps.chant-handover.outputs.report_1 }}",
        report_2: "${{ steps.chant-handover.outputs.report_2 }}",
        report_3: "${{ steps.chant-handover.outputs.report_3 }}",
      });
    }
    // The plan job hands on its saved plan, its outcome, its claims and the product's artifact path; an applying job its outcome and run record.
    const plan = jobs["wave-1-dev-plan"]!.steps.at(-1)!.run!;
    expect(plan).toContain("for p in '.chant/op-waves/tf-apply/wave-1' '.chant/op-waves/tf-apply/outcomes/outcome-wave-1.json' '.chant/op-waves/tf-apply/checks' 'terragucci-report'; do");
    expect(jobs["wave-2-prod-share-2"]!.steps.at(-1)!.run).toContain("for p in '.chant/op-waves/tf-apply/outcomes/outcome-wave-2-share-2.json' '.chant/op-waves/tf-apply/outcomes/run-record-wave-2-share-2.json'; do");
    // The product's report still runs, without a token, before the hand-off.
    expect(jobs["wave-1-dev-plan"]!.steps.at(-2)!.name).toBe("Report");
  });

  test("the gate job takes the plan back from the plan job's outputs and keeps it as the artifact the applying job downloads", () => {
    const gate = jobs["wave-1-dev-gate"]!;
    const names = gate.steps.map((s) => s.name);
    expect(names).not.toContain("Download wave 1's saved plan");
    const take = gate.steps.find((s) => s.name === "Take the plan job of wave 1 (dev) of tf-apply's files from its outputs")!;
    expect(take.run).toContain("node -e ");
    expect(take.run).toContain(".chant/op-waves/tf-apply/handover/wave-1-dev-plan <<'END_OF_REPORT'");
    expect(take.run).toContain("${{ toJSON(needs.wave-1-dev-plan.outputs.report_3) }}");
    // Only the files the plan job hands on are copied out of the hand-off, so nothing else it wrote lands in the gate's checkout.
    expect(take.run).toContain(`for p in '.chant/op-waves/tf-apply/wave-1' '.chant/op-waves/tf-apply/outcomes/outcome-wave-1.json' '.chant/op-waves/tf-apply/checks' 'terragucci-report'; do if [ -e ".chant/op-waves/tf-apply/handover/wave-1-dev-plan/$p" ]`);
    expect(names.indexOf(take.name)).toBeLessThan(names.indexOf("Decide wave 1 (dev)'s gate on the saved plan"));
    const kept = gate.steps.find((s) => s.name === "Keep wave 1's saved plan")! as Step & { with?: Record<string, unknown> };
    expect(kept.with).toMatchObject({ name: "tf-apply-wave-1-plan", path: ".chant/op-waves/tf-apply/wave-1" });
    expect((gate.steps.find((s) => s.name === "Keep the report") as Step & { with?: Record<string, unknown> }).with).toMatchObject({ name: "report-wave-1-dev-plan", path: "terragucci-report" });
    expect(jobs["wave-1-dev"]!.steps.some((s) => s.name === "Download wave 1's saved plan")).toBe(true);
  });

  test("the record job takes each applying job's outcome and run record back, and keeps them for the later jobs", () => {
    const record = jobs["wave-2-prod-record"]!;
    expect(record.needs).toEqual(["wave-2-prod-share-1", "wave-2-prod-share-2", "wave-2-prod-gate"]);
    for (const share of [1, 2]) {
      expect(record.steps.find((s) => s.name === `Take share ${share} of wave 2 (prod) of tf-apply's files from its outputs`)!.run).toContain(`needs.wave-2-prod-share-${share}.outputs.report_0`);
      const kept = record.steps.find((s) => s.name === `Keep share ${share} of wave 2 (prod) of tf-apply's outcome and run record`)! as Step & { with?: Record<string, unknown> };
      expect(kept.with).toMatchObject({ name: `tf-apply-wave-2-prod-share-${share}-outcome`, path: `.chant/op-waves/tf-apply/outcomes/outcome-wave-2-share-${share}.json\n.chant/op-waves/tf-apply/outcomes/run-record-wave-2-share-${share}.json\n` });
    }
    expect(record.steps.some((s) => s.name === "Download wave 2's decision")).toBe(true);
  });

  test("the hand-off round-trips: the gate job takes back what the plan job packed, at its own paths, and nothing else", () => {
    const planJob = mkdtempSync(join(tmpdir(), "forgejo-handoff-plan-"));
    const gateJob = mkdtempSync(join(tmpdir(), "forgejo-handoff-gate-"));
    try {
      const put = (root: string, path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      put(planJob, ".chant/op-waves/tf-apply/wave-1/saved-plan.json", '{"version":1}');
      put(planJob, ".chant/op-waves/tf-apply/wave-1/dev.plan.json", '{"planDigest":"sha256:1"}');
      put(planJob, ".chant/op-waves/tf-apply/outcomes/outcome-wave-1.json", '{"members":{}}');
      // What the change's code left in the hand-off directory goes along, and is never copied out of it.
      put(planJob, ".chant/op-waves/tf-apply/handover/wave-1-dev-plan/.git/hooks/post-checkout", "echo owned");
      const script = join(planJob, "step.sh");
      writeFileSync(script, jobs["wave-1-dev-plan"]!.steps.at(-1)!.run!);
      const output = join(planJob, "github-output");
      execFileSync("sh", ["-e", script], { cwd: planJob, env: { PATH: process.env.PATH!, GITHUB_OUTPUT: output }, stdio: "pipe" });
      const outputs = Object.fromEntries(readFileSync(output, "utf-8").trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
      expect(Object.keys(outputs)).toEqual(["report_0"]);
      const take = jobs["wave-1-dev-gate"]!.steps.find((s) => s.name === "Take the plan job of wave 1 (dev) of tf-apply's files from its outputs")!.run!;
      const filled = take.replace(/\$\{\{ toJSON\(needs\.wave-1-dev-plan\.outputs\.(report_\d)\) \}\}/g, (_, k: string) => JSON.stringify(outputs[k] ?? ""));
      writeFileSync(join(gateJob, "step.sh"), filled);
      execFileSync("sh", ["-e", join(gateJob, "step.sh")], { cwd: gateJob, env: { PATH: process.env.PATH! }, stdio: "pipe" });
      expect(readFileSync(join(gateJob, ".chant/op-waves/tf-apply/wave-1/saved-plan.json"), "utf-8")).toBe('{"version":1}');
      expect(readFileSync(join(gateJob, ".chant/op-waves/tf-apply/wave-1/dev.plan.json"), "utf-8")).toBe('{"planDigest":"sha256:1"}');
      expect(readFileSync(join(gateJob, ".chant/op-waves/tf-apply/outcomes/outcome-wave-1.json"), "utf-8")).toBe('{"members":{}}');
      expect(existsSync(join(gateJob, ".git"))).toBe(false);
    } finally {
      rmSync(planJob, { recursive: true, force: true });
      rmSync(gateJob, { recursive: true, force: true });
    }
  });

  test("a step spec splits on Forgejo too", () => {
    const step = { ...spec, plan: undefined, apply: undefined, step: { kind: "terragrunt-apply", unit: "{target}" } } as OpWavesSpec;
    const doc = parseYAML(generateForgejoOpWavesPipeline(step, options).files[0]!.yaml) as { jobs: Record<string, Job> };
    expect(Object.keys(doc.jobs)).toContain("wave-1-dev-gate");
    expect(doc.jobs["wave-1-dev-plan"]!.steps.at(-1)!.name).toBe("Hand the job's files to the next job as its outputs");
  });
});
