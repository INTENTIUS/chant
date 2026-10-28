/**
 * Golden transcripts of both wave runners (#3766): `chant run wave` (an Op
 * waves spec, `runOpWave`) and `chant components fan-out --wave-gate`
 * (`runFanOut`). Each scenario records everything a job outside chant can
 * see: every command chant runs with its argv and the environment it adds,
 * the files those variables name as they stood when the command ran
 * (`CHANT_HOOKS`, `CHANT_RUNS`, `CHANT_DECISION`), every file chant left
 * under `.chant/`, every fact on the gate ledger, the result with its exit
 * code, and the log. For fan-out: the progress events, each wave record as
 * it settled, and the result.
 *
 * The transcripts are pinned in `__golden__/wave-loop/`. A change to how the
 * runners are built must leave them byte for byte as they are: terragucci
 * runs every wave through `chant run wave`, and approvals in flight are
 * bound to these gate names and digests.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { memoryGateLedgerPort } from "./op/gate";
import { runOpWave, runOpWaveApplyHooks, readOpWaveHooksFile, type OpWaveExec, type OpWaveRunsFile, type RunOpWaveOptions } from "./op/op-waves-run";
import type { OpWavesSpec } from "./op/op-waves";
import type { GatePointAsker, GatePointQuestion, GatePointRequest } from "./point-decision";
import type { GateResolutionRecord } from "./lifecycle/gate-ledger";
import type { AppliedGateRecord } from "./lifecycle/gate-applied";
import { waveSetDigest } from "./gated-waves";
import { CapabilityRegistry, type DeployContext } from "./components/capability";
import { planFanOut } from "./components/fan-out";
import { runFanOut, type FanOutRunOptions } from "./components/fan-out-run";
import { planWaveComponent } from "./components/wave-plan";
import type { DriverComponent } from "./components/driver";
import type { RunProgressEvent } from "./components/run-progress";
import type { WaveRecord } from "./gated-waves";

// #4020: every pending fact names the commit it was recorded at. The transcripts pin one.
vi.mock("./lifecycle/commit-sha", () => ({ resolveCommitSha: async () => "1".repeat(40) }));

const digest = (n: string) => `sha256:${n.repeat(64)}`;
const NOW = "2026-10-11T00:00:00.000Z";
const BEFORE = "2026-10-10T00:00:00Z";
const GOLDEN = "./__golden__/wave-loop";

beforeEach(() => {
  // A CI job's locator would land on every pending fact.
  vi.stubEnv("GITHUB_ACTIONS", "");
  vi.stubEnv("GITLAB_CI", "");
  // A pull request's address would land on every pending fact too.
  vi.stubEnv("GITHUB_REF_NAME", "");
  vi.stubEnv("CI_MERGE_REQUEST_IID", "");
  // A CI run's id would land on them as well (#4020).
  vi.stubEnv("GITHUB_RUN_ID", "");
  vi.stubEnv("CI_PIPELINE_ID", "");
  // And the commit the CI job started for, which a decision point's gate reads from the environment.
  vi.stubEnv("GITHUB_SHA", "");
  vi.stubEnv("CI_COMMIT_SHA", "");
});
afterEach(() => vi.unstubAllEnvs());

type PlanEntry = { planDigest: string; destructive?: boolean; empty?: boolean; denied?: { rules: string[]; reason?: string } };

interface Script {
  /** Each target's plan, for `tool plan` and `tg plan`. */
  plans?: Record<string, PlanEntry>;
  /** What wave k's plan finds, for a discovering wave. */
  layers?: Array<Record<string, PlanEntry>>;
  /** Fields a `tg plan` adds to its plans file, by wave number. */
  extra?: (k: number) => Record<string, unknown>;
  /** A hook (any argv not `tool`/`tg` plan or apply). Default exit 0. */
  hook?: (argv: string[], env: Record<string, string>, dir: string) => number;
  /** An apply call; `n` counts apply calls. Default exit 0. */
  apply?: (argv: string[], env: Record<string, string>, dir: string, n: number) => number;
}

interface Call {
  argv: string[];
  env?: Record<string, string>;
  /** The files the call's environment and argv name, as they stood when it ran. */
  read?: Record<string, unknown>;
}

function readMaybeJson(path: string): unknown {
  const text = readFileSync(path, "utf-8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Every file under `dir`, by path relative to `root`. */
function tree(root: string, dir = root, out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const at = join(dir, name);
    if (statSync(at).isDirectory()) tree(root, at, out);
    else out[relative(root, at)] = readMaybeJson(at);
  }
  return out;
}

function opHarness(script: Script) {
  const cwd = mkdtempSync(join(tmpdir(), "wave-golden-"));
  const calls: Call[] = [];
  const logs: string[] = [];
  let applies = 0;
  const exec: OpWaveExec = (argv, dir, env) => {
    const read: Record<string, unknown> = {};
    for (const key of ["CHANT_HOOKS", "CHANT_RUNS", "CHANT_DECISION"] as const) {
      const p = env?.[key];
      if (p && existsSync(isAbsolute(p) ? p : join(dir, p))) read[key] = readMaybeJson(isAbsolute(p) ? p : join(dir, p));
    }
    for (const part of argv) if (part.endsWith("runs.json") && existsSync(join(dir, part))) read[part] = readMaybeJson(join(dir, part));
    calls.push({ argv: [...argv], ...(env ? { env: { ...env } } : {}), ...(Object.keys(read).length ? { read } : {}) });
    if (argv[0] === "tool" && argv[1] === "plan") {
      const target = argv[2]!;
      writeFileSync(join(dir, argv[argv.length - 1]!), JSON.stringify(script.plans?.[target] ?? { planDigest: digest(target.slice(0, 1)) }));
      return 0;
    }
    if (argv[0] === "tg" && argv[1] === "plan") {
      const runs = JSON.parse(readFileSync(join(dir, argv[3]!), "utf-8")) as OpWaveRunsFile;
      const found = script.layers?.[runs.number - 1] ?? script.plans ?? {};
      const entries = runs.discover
        ? Object.entries(found).map(([target, p]) => ({ target, ...p }))
        : runs.runs.map((r) => ({ target: r.target, ...(found[r.target] ?? { planDigest: digest(r.target.slice(0, 1)) }) }));
      writeFileSync(
        join(dir, argv[4]!),
        JSON.stringify({ runs: entries, ...(script.layers ? { waves: script.layers.length } : {}), ...(script.extra?.(runs.number) ?? {}) }),
      );
      return 0;
    }
    if ((argv[0] === "tool" || argv[0] === "tg") && argv[1] === "apply") return script.apply?.(argv, env ?? {}, dir, ++applies) ?? 0;
    return script.hook?.(argv, env ?? {}, dir) ?? 0;
  };
  const scrub = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null).replaceAll(cwd, "<cwd>"));
  return {
    cwd,
    calls,
    logs,
    exec,
    log: (line: string) => logs.push(line),
    show: (atBase: OpWavesSpec | null) => () => ({ sha: "b".repeat(40), text: atBase === null ? null : JSON.stringify(atBase) }),
    transcript: (extra: Record<string, unknown>) => scrub({ ...extra, calls, logs, files: tree(cwd) }),
    done: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

type Gates = ReturnType<typeof memoryGateLedgerPort>;
const ledgerOf = (gates: Gates) => ({ appended: gates.appended, resolved: gates.resolved, applied: gates.applied });

const resolution = (op: string, gate: string, planDigest: string, extra: Partial<GateResolutionRecord> = {}): GateResolutionRecord => ({
  version: 1,
  op,
  gate,
  resolvedBy: "alice",
  timestamp: BEFORE,
  planDigest,
  ...extra,
});

/** Run one or more jobs of one spec in one working tree; each job's result goes into the transcript. */
async function opScenario(
  name: string,
  spec: OpWavesSpec,
  script: Script,
  jobs: Array<Partial<RunOpWaveOptions> & { wave: number; gates?: Gates; atBase?: OpWavesSpec | null; label?: string; before?: () => void }>,
): Promise<void> {
  const h = opHarness(script);
  try {
    const out: Array<Record<string, unknown>> = [];
    for (const job of jobs) {
      const { gates = memoryGateLedgerPort(), atBase = spec, label, before, ...rest } = job;
      before?.();
      const from = h.calls.length;
      const logFrom = h.logs.length;
      let result: unknown;
      try {
        result = await runOpWave({ spec, specFile: "waves.json", cwd: h.cwd, exec: h.exec, show: h.show(atBase), gates, now: NOW, log: h.log, ...rest });
      } catch (err) {
        result = { threw: err instanceof Error ? err.message : String(err) };
      }
      out.push({ ...(label ? { label } : {}), job: { wave: rest.wave, decide: rest.decide, share: rest.share }, result, ledger: ledgerOf(gates), calls: h.calls.slice(from).length, logs: h.logs.slice(logFrom).length });
    }
    // A target's start time and duration (#4555) are the clock's, so they read as 0, as in the fan-out goldens.
    await expect(JSON.stringify(scrubDurations(h.transcript({ jobs: out })), null, 2) + "\n").toMatchFileSnapshot(`${GOLDEN}/op-${name}.json`);
  } finally {
    h.done();
  }
}

const perRun: OpWavesSpec = {
  name: "migrations",
  op: "migrate",
  plan: ["tool", "plan", "{target}", "--out", "{plan}"],
  apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
  waves: [
    { name: "dev", runs: [{ target: "dev" }], gate: "never" },
    { name: "staging", runs: [{ target: "staging" }], gate: "on-destructive" },
    { name: "prod", runs: [{ target: "t3" }, { target: "t1" }, { target: "t2" }], shares: 2 },
  ],
};

const tg: OpWavesSpec = {
  name: "tf-apply",
  op: "tf-apply",
  gateName: "wave-{k}",
  digest: { over: "changing" },
  planWave: ["tg", "plan", "{wave}", "{runs}", "{plans}"],
  applyWave: ["tg", "apply", "{wave}", "{runs}", "{plans}"],
  hooks: { after: { gate: [{ name: "report", command: ["hook", "report", "{runs}"] }] } },
  waves: [
    { name: "net", runs: [{ target: "vpc" }, { target: "dns" }, { target: "nat" }], gate: "always" },
    { name: "apps", runs: [{ target: "a1" }, { target: "a2" }, { target: "a3" }], gate: "never", shares: 2 },
  ],
};

const stagingSet = waveSetDigest([{ member: "staging", planDigest: digest("a") }]);

describe("Op waves golden transcripts (#3766)", () => {
  test("per-run plans: never, on-destructive waiting then approved, not-required", async () => {
    const script: Script = { plans: { dev: { planDigest: digest("d") }, staging: { planDigest: digest("a"), destructive: true } } };
    await opScenario("per-run", perRun, script, [
      { wave: 1, label: "never" },
      { wave: 2, label: "waits", atBase: perRun },
      { wave: 2, label: "loosened in the change, still waits", atBase: perRun, spec: { ...perRun, waves: perRun.waves.map((w) => ({ ...w, gate: "never" as const })) } },
      { wave: 2, label: "approved", gates: memoryGateLedgerPort({ resolutions: [resolution("migrations", "migrations-wave-2", stagingSet)] }) },
      { wave: 2, label: "absent at base", atBase: null },
    ]);
  });

  test("a wide wave: the deciding job, its shares, a moved plan", async () => {
    const plans: Record<string, PlanEntry> = { t1: { planDigest: digest("1") }, t2: { planDigest: digest("2") }, t3: { planDigest: digest("3") } };
    const set = waveSetDigest(Object.entries(plans).map(([member, p]) => ({ member, planDigest: p.planDigest })));
    const gates = memoryGateLedgerPort({ resolutions: [resolution("migrations", "migrations-wave-3", set)] });
    await opScenario("wide", { ...perRun, approvals: { spend: true } }, { plans }, [
      { wave: 3, decide: true, gates, label: "decide, approved and spent" },
      { wave: 3, share: 2, gates, label: "share 2" },
      { wave: 3, share: 1, gates, label: "share 1, t2 moved", before: () => (plans.t2 = { planDigest: digest("9") }) },
    ]);
  });

  test("a share whose decision waits, and one whose decision was refused", async () => {
    const plans: Record<string, PlanEntry> = { t1: { planDigest: digest("1") }, t2: { planDigest: digest("2") }, t3: { planDigest: digest("3") } };
    await opScenario("wide-waiting", perRun, { plans }, [
      { wave: 3, decide: true, label: "decide, waits" },
      { wave: 3, share: 1, label: "share 1 of a waiting decision" },
    ]);
    const denied: Record<string, PlanEntry> = { ...plans, t2: { planDigest: digest("2"), denied: { rules: ["r1"], reason: "no" } } };
    const wide: OpWavesSpec = { ...tg, hooks: undefined, waves: [{ name: "apps", runs: [{ target: "t1" }, { target: "t2" }, { target: "t3" }], gate: "never", shares: 2 }] };
    await opScenario("wide-refused", wide, { plans: denied }, [
      { wave: 1, decide: true, label: "decide, refused" },
      { wave: 1, share: 2, label: "share 2 of a refused decision" },
    ]);
  });

  test("planWave, applyWave, a product's gate name, changing digest, pending fields, extras and neverOverMcp", async () => {
    const plans: Record<string, PlanEntry> = { vpc: { planDigest: digest("1"), destructive: true }, dns: { planDigest: digest("2"), empty: true }, nat: { planDigest: digest("3") } };
    const extra = () => ({ pending: { description: "net layer", commit: "c0ffee" }, members: [{ member: "cost", planDigest: "usd:12.00" }] });
    const spec: OpWavesSpec = { ...tg, neverOverMcp: true };
    const set = waveSetDigest([{ member: "vpc", planDigest: digest("1") }, { member: "nat", planDigest: digest("3") }, { member: "cost", planDigest: "usd:12.00" }]);
    await opScenario("wave-commands", spec, { plans, extra }, [
      { wave: 1, label: "waits" },
      { wave: 1, label: "approved", gates: memoryGateLedgerPort({ resolutions: [resolution("tf-apply", "wave-1", set)] }) },
      { wave: 1, label: "another digest approved", gates: memoryGateLedgerPort({ resolutions: [resolution("tf-apply", "wave-1", digest("9"))] }) },
      // #4322: wave 1's last job here waits, which would stop wave 2; the wide wave keeps its outcomes apart to show its own jobs.
      { wave: 2, decide: true, label: "decide a wide never wave", outcomeDir: "wide-outcomes" },
      { wave: 2, share: 1, label: "share 1", outcomeDir: "wide-outcomes" },
      { wave: 2, share: 2, label: "share 2", outcomeDir: "wide-outcomes" },
    ]);
  });

  test("hooks around plan and apply, perRun, holds, failures", async () => {
    const hooked: OpWavesSpec = {
      name: "migrations",
      op: "migrate",
      plan: ["tool", "plan", "{target}", "{plan}"],
      apply: ["tool", "apply", "{target}", "{plan}"],
      hooks: { before: { plan: [{ name: "lint", command: ["hook", "lint", "{runs}"] }] } },
      waves: [
        {
          name: "prod",
          runs: [{ target: "t1" }, { target: "t2" }],
          gate: "never",
          hooks: {
            after: { plan: [{ name: "check", command: ["hook", "check", "{target}", "{plan}"], perRun: true, onFailure: "approve" }], apply: [{ name: "smoke", command: ["hook", "smoke", "{wave}"] }] },
            before: { apply: [{ name: "backup", command: ["hook", "backup", "{runs}"] }] },
          },
        },
      ],
    };
    const set = waveSetDigest([{ member: "t1", planDigest: digest("t") }, { member: "t2", planDigest: digest("t") }]);
    await opScenario("hooks-pass", hooked, {}, [{ wave: 1 }]);
    await opScenario("hooks-held", hooked, { hook: (argv) => (argv[1] === "check" && argv[2] === "t2" ? 1 : 0) }, [
      { wave: 1, label: "held, waits" },
      { wave: 1, label: "held, approved", gates: memoryGateLedgerPort({ resolutions: [resolution("migrations", "migrations-wave-1", set)] }) },
    ]);
    await opScenario("hooks-fail-before-plan", hooked, { hook: (argv) => (argv[1] === "lint" ? 1 : 0) }, [{ wave: 1 }]);
    await opScenario("hooks-fail-after-apply", hooked, { hook: (argv) => (argv[1] === "smoke" ? 1 : 0) }, [{ wave: 1 }]);
    await opScenario("hooks-fail-before-apply", hooked, { hook: (argv) => (argv[1] === "backup" ? 1 : 0) }, [{ wave: 1 }]);
    await opScenario("hooks-apply-fails", hooked, { apply: (argv) => (argv[2] === "t1" ? 2 : 0) }, [{ wave: 1 }]);
    const holdBefore: OpWavesSpec = { ...hooked, waves: [{ ...hooked.waves[0]!, hooks: { before: { apply: [{ name: "lag", command: ["hook", "lag"], onFailure: "approve" }] } } }] };
    await opScenario("hooks-hold-before-apply", holdBefore, { hook: (argv) => (argv[1] === "lag" ? 1 : 0) }, [
      { wave: 1, label: "waits" },
      { wave: 1, label: "approved", gates: memoryGateLedgerPort({ resolutions: [resolution("migrations", "migrations-wave-1", set)] }) },
    ]);
    await opScenario("hooks-refused-at-base", hooked, {}, [
      { wave: 1, atBase: { ...hooked, hooks: { before: { plan: [{ command: [] as unknown as string[] }] } } } as OpWavesSpec },
    ]);
    await opScenario("hooks-share", { ...hooked, waves: [{ ...hooked.waves[0]!, shares: 2 }] }, { hook: (argv) => (argv[1] === "check" && argv[2] === "t2" ? 1 : 0) }, [
      { wave: 1, decide: true, label: "decide, held" },
      { wave: 1, share: 1, label: "share 1, waiting decision" },
      { wave: 1, decide: true, label: "decide, approved", gates: memoryGateLedgerPort({ resolutions: [resolution("migrations", "migrations-wave-1", set)] }) },
      { wave: 1, share: 2, label: "share 2, approved" },
    ]);
  });

  test("apply-stage hooks run by the apply (CHANT_HOOKS, CHANT_HOOKS_RESULT)", async () => {
    const spec: OpWavesSpec = {
      name: "migrations",
      op: "migrate",
      plan: ["tool", "plan", "{target}", "{plan}"],
      apply: ["tool", "apply", "{target}", "{plan}"],
      hooks: { apply: { runBy: "apply" }, before: { plan: [{ name: "lint", command: ["hook", "lint"] }] } },
      waves: [
        {
          name: "prod",
          runs: [{ target: "t1" }],
          gate: "never",
          hooks: {
            before: { apply: [{ name: "lag", command: ["hook", "lag", "{target}"], perRun: true, onFailure: "approve" }] },
            after: { apply: [{ name: "smoke", command: ["hook", "smoke", "{wave}"] }] },
          },
        },
      ],
    };
    const byApply = (fails: string[], obey = true): Script => ({
      apply: (_argv, env, dir) => {
        const file = readOpWaveHooksFile(env.CHANT_HOOKS, dir)!;
        if (!obey) return 0;
        const inner: OpWaveExec = (a) => (fails.includes(a[1]!) ? 1 : 0);
        const before = runOpWaveApplyHooks(file, "before-apply", { cwd: dir, exec: inner, log: () => {} });
        if (!before.proceed) return before.held.length > 0 ? 3 : 4;
        const after = runOpWaveApplyHooks(file, "after-apply", { cwd: dir, exec: inner, log: () => {} });
        return after.proceed ? 0 : 1;
      },
    });
    const set = waveSetDigest([{ member: "t1", planDigest: digest("t") }]);
    await opScenario("by-apply-pass", spec, byApply([]), [{ wave: 1 }]);
    await opScenario("by-apply-hold", spec, byApply(["lag"]), [
      { wave: 1, label: "waits" },
      { wave: 1, label: "approved", gates: memoryGateLedgerPort({ resolutions: [resolution("migrations", "migrations-wave-1", set)] }) },
    ]);
    await opScenario("by-apply-after-fails", spec, byApply(["smoke"]), [{ wave: 1 }]);
    await opScenario("by-apply-ignored", spec, byApply([], false), [{ wave: 1 }]);
    await opScenario("by-apply-skip", spec, {
      apply: (_argv, env, dir) => {
        const file = readOpWaveHooksFile(env.CHANT_HOOKS, dir)!;
        runOpWaveApplyHooks(file, "before-apply", { cwd: dir, skip: "nothing to apply", log: () => {} });
        runOpWaveApplyHooks(file, "after-apply", { cwd: dir, skip: "nothing to apply", log: () => {} });
        return 0;
      },
    }, [{ wave: 1 }]);
  });

  test("spend: approved once, then spent", async () => {
    const spec: OpWavesSpec = { ...perRun, approvals: { spend: true } };
    const gates = memoryGateLedgerPort({ resolutions: [resolution("migrations", "migrations-wave-2", stagingSet)] });
    await opScenario("spend", spec, { plans: { staging: { planDigest: digest("a"), destructive: true } } }, [
      { wave: 2, gates, label: "applies under the approval and spends it" },
      { wave: 2, gates, label: "the same approval is spent" },
      { wave: 2, label: "no appendApplied", gates: { ...memoryGateLedgerPort({ resolutions: [resolution("migrations", "migrations-wave-2", stagingSet)] }), appendApplied: undefined } as unknown as Gates },
    ]);
    await opScenario("spend-change-only", perRun, { plans: { staging: { planDigest: digest("a"), destructive: true } } }, [
      { wave: 2, spec, gates: memoryGateLedgerPort({ resolutions: [resolution("migrations", "migrations-wave-2", stagingSet)] }) },
    ]);
  });

  test("denials and overrides (exit 7)", async () => {
    const { overrideDigest } = await import("./override-gate");
    const od = overrideDigest("vpc", digest("1"), ["no-public-s3"]);
    const plans: Record<string, PlanEntry> = { vpc: { planDigest: digest("1"), denied: { rules: ["no-public-s3"] } }, dns: { planDigest: digest("2") }, nat: { planDigest: digest("3"), empty: true } };
    await opScenario("denied", tg, { plans }, [{ wave: 1 }]);
    await opScenario("denied-source", tg, { plans, extra: () => ({ overriders: ["github:dave"], overridersSource: "policy.override in terragucci.yml" }) }, [
      { wave: 1, gates: memoryGateLedgerPort({ resolutions: [resolution("policy-override", "vpc", od, { resolvedBy: "github:carol", note: "ok" })] }) },
    ]);
    const never: OpWavesSpec = { ...tg, waves: [{ ...tg.waves[0]!, gate: "never" }] };
    await opScenario("overridden", never, { plans, extra: () => ({ overriders: ["github:carol"] }) }, [
      { wave: 1, gates: memoryGateLedgerPort({ resolutions: [resolution("policy-override", "vpc", od, { resolvedBy: "github:carol", note: "the bucket is the docs site" })] }) },
    ]);
  });

  test("a hook holds the wave on other gates (CHANT_HOLD, CHANT_HOLD_APPROVED, CHANT_HOLDS_APPROVED)", async () => {
    const migrate = { name: "migrate", command: ["hook", "migrate", "{runs}"], onFailure: "approve" as const };
    const spec: OpWavesSpec = { ...tg, hooks: { before: { plan: [migrate] }, after: tg.hooks!.after } };
    const hook = (argv: string[], env: Record<string, string>, dir: string) => {
      if (argv[1] !== "migrate") return 0;
      const approved = env.CHANT_HOLDS_APPROVED ? (JSON.parse(env.CHANT_HOLDS_APPROVED) as unknown[]) : [];
      if (approved.length >= 2) return 0;
      const gate = approved.length === 0 ? "split-queues" : "split-topics";
      writeFileSync(join(dir, env.CHANT_HOLD!), JSON.stringify({ op: "tf-migrate", gate, digest: digest(gate.slice(6, 7)), description: `move the ${gate.slice(6)}`, pending: { members: [] } }));
      return 3;
    };
    const plans: Record<string, PlanEntry> = { vpc: { planDigest: digest("1"), empty: true }, dns: { planDigest: digest("2"), empty: true }, nat: { planDigest: digest("3"), empty: true } };
    const first = resolution("tf-migrate", "split-queues", digest("q"));
    await opScenario("held-on", spec, { plans, hook }, [
      { wave: 1, label: "waits on the first" },
      { wave: 1, label: "waits on the second", gates: memoryGateLedgerPort({ resolutions: [first] }) },
      { wave: 1, label: "both approved", gates: memoryGateLedgerPort({ resolutions: [first, resolution("tf-migrate", "split-topics", digest("t"))] }) },
    ]);
    const again = (argv: string[], env: Record<string, string>, dir: string) => {
      if (argv[1] !== "migrate") return 0;
      writeFileSync(join(dir, env.CHANT_HOLD!), JSON.stringify({ op: "tf-migrate", gate: "split-queues", digest: digest("q") }));
      return 3;
    };
    await opScenario("held-on-again", spec, { plans, hook: again }, [{ wave: 1, gates: memoryGateLedgerPort({ resolutions: [first] }) }]);
    const applyHold: OpWavesSpec = { ...tg, hooks: { before: { apply: [migrate] }, after: tg.hooks!.after } };
    await opScenario("held-on-before-apply", { ...applyHold, waves: [{ ...tg.waves[0]!, gate: "never" }] }, { plans, hook }, [{ wave: 1 }]);
  });

  test("discovered waves, rest, a cost member, applies that apply nothing, replans", async () => {
    const disc: OpWavesSpec = {
      ...tg,
      hooks: undefined,
      waves: [
        { name: "layer", runs: [], discover: true, gate: "never" },
        { name: "rest", runs: [], discover: true, rest: true, gate: "never" },
      ],
    };
    const layers: Array<Record<string, PlanEntry>> = [{ "a/vpc": { planDigest: digest("1") } }, { "b/db": { planDigest: digest("2") } }, { "c/app": { planDigest: digest("3") } }, { "d/dns": { planDigest: digest("4") } }];
    await opScenario("discover-rest", disc, { layers }, [{ wave: 1 }, { wave: 2 }]);
    const failsOn = (target: string): Script["apply"] => (argv, _env, dir) =>
      (JSON.parse(readFileSync(join(dir, argv[3]!), "utf-8")) as OpWaveRunsFile).runs.some((r) => r.target === target) ? 1 : 0;
    await opScenario("discover-rest-stops", disc, { layers, apply: failsOn("c/app") }, [{ wave: 2 }]);
    await opScenario("discover-rest-short", disc, { layers: [layers[0]!] }, [{ wave: 2 }]);
    const wide: OpWavesSpec = { ...disc, waves: [{ name: "layer", runs: [], discover: true, gate: "never", shares: 2 }] };
    await opScenario("discover-wide", wide, { layers: [{ "a/1": { planDigest: digest("1") }, "a/2": { planDigest: digest("2") }, "a/3": { planDigest: digest("3") } }] }, [
      { wave: 1, decide: true },
      { wave: 1, share: 2 },
    ]);
    const outcome = (said: (n: number) => unknown): Script["apply"] => (_argv, env, dir, n) => {
      const s = said(n);
      if (s) writeFileSync(join(dir, env.CHANT_APPLY_OUTCOME!), JSON.stringify(s));
      return 0;
    };
    const one = [{ "a/vpc": { planDigest: digest("1") } }];
    await opScenario("outcome-stood-down", disc, { layers: one, apply: outcome(() => ({ outcome: "stood-down", reason: "a newer push is on main" })) }, [{ wave: 1 }]);
    await opScenario("outcome-held", disc, { layers: one, apply: outcome(() => ({ outcome: "held", holder: { run: "github:123", url: "https://example.test/run/123" } })) }, [{ wave: 1 }]);
    await opScenario("outcome-unreadable", disc, { layers: one, apply: outcome(() => ({ outcome: "maybe" })) }, [{ wave: 1 }]);
    await opScenario("outcome-replan", disc, { layers: one, apply: outcome((n) => (n === 1 ? { outcome: "replan", reason: "run 123 let go" } : undefined)) }, [{ wave: 1 }]);
    await opScenario("outcome-replan-forever", disc, { layers: one, apply: outcome(() => ({ outcome: "replan" })) }, [{ wave: 1 }]);
    const spend: OpWavesSpec = { ...disc, approvals: { spend: true }, waves: [{ name: "layer", runs: [], discover: true, gate: "always" }] };
    const set = waveSetDigest([{ member: "a/vpc", planDigest: digest("1") }]);
    await opScenario("outcome-replan-approved", spend, { layers: one, apply: outcome((n) => (n === 1 ? { outcome: "replan" } : undefined)) }, [
      { wave: 1, gates: memoryGateLedgerPort({ resolutions: [resolution("tf-apply", "wave-1", set)] }) },
    ]);
    const priced: OpWavesSpec = { ...disc, waves: [{ name: "layer", runs: [], discover: true, gate: "always" }] };
    await opScenario("cost-member", priced, { layers: [{ "a/vpc": { planDigest: digest("1") }, "a/idle": { planDigest: digest("2"), empty: true } }], extra: () => ({ members: [{ member: "cost", planDigest: "usd:120.00" }] }) }, [{ wave: 1 }]);
    await opScenario("cost-member-clash", priced, { layers: [{ cost: { planDigest: digest("1") } }], extra: () => ({ members: [{ member: "cost", planDigest: "usd:1" }] }) }, [{ wave: 1 }]);
  });

  test("a gate that asks a decision point (exit 3, 8, approved) and a point refused at base", async () => {
    const spec: OpWavesSpec = {
      name: "tf-apply",
      op: "apply",
      plan: ["tool", "plan", "{target}", "--out", "{plan}"],
      apply: ["tool", "apply", "{target}", "--plan", "{plan}"],
      point: { name: "prod-apply", timeout: "48h" },
      waves: [{ name: "prod", runs: [{ target: "db" }, { target: "net" }], gate: "always" }],
    };
    const asker = (answer?: Partial<GatePointQuestion>): GatePointAsker & { asked: GatePointRequest[] } => {
      const asked: GatePointRequest[] = [];
      return {
        asked,
        async ask(request) {
          asked.push(request);
          const id = `${request.point}-${(request.facts.planDigest ?? "none").slice(7, 19)}`;
          return { id, point: request.point, path: `.chant/answers/${id}.md`, state: "escalated", answer: null, decider: "quorum", answeredBy: [], subject: request.subject, steward: null, ...(answer ?? {}) };
        },
      };
    };
    await opScenario("point", spec, {}, [
      { wave: 1, label: "open question", points: asker() },
      { wave: 1, label: "answered no", points: asker({ state: "answered", answer: false, answeredBy: ["bob"] }) },
      { wave: 1, label: "answered yes", points: asker({ state: "answered", answer: true, answeredBy: ["alice"] }) },
      { wave: 1, label: "point refused at base", points: asker(), atBase: { ...spec, point: { name: "" } } as OpWavesSpec },
    ]);
  });

  test("pr-review and sealed approvals", async () => {
    const spec: OpWavesSpec = { ...perRun, waves: perRun.waves.map((w) => (w.name === "staging" ? { ...w, approval: "pr-review" as const } : w)) };
    const head = "h".repeat(40);
    const reviews = (approvers: string[]) => ({
      kind: "github" as const,
      mergedReview: async () => ({ pr: 7, url: "https://example.test/pr/7", author: "github:dan", head, approvers, refused: [] }),
    });
    const headPlans = async (name: string) => ({ version: 1 as const, name, head, timestamp: BEFORE, waves: [{ wave: 2, name: "staging", digest: stagingSet }] });
    const plans = { staging: { planDigest: digest("a"), destructive: true } };
    await opScenario("pr-review", spec, { plans }, [
      { wave: 2, label: "approved by the review", head, reviews: reviews(["github:erin"]), headPlans },
      { wave: 2, label: "no approver", head, reviews: reviews([]), headPlans },
      { wave: 2, label: "spent review", spec: { ...spec, approvals: { spend: true } }, atBase: { ...spec, approvals: { spend: true } }, head, reviews: reviews(["github:erin"]), headPlans, gates: memoryGateLedgerPort({ applied: [{ version: 1, kind: "applied", op: "migrations", gate: "migrations-wave-2", planDigest: stagingSet, approvedAt: BEFORE, approvedBy: "github:erin", timestamp: BEFORE, review: { pr: 7, head } } as AppliedGateRecord] }) },
    ]);
    const sealed: OpWavesSpec = { ...perRun, waves: perRun.waves.map((w) => (w.name === "staging" ? { ...w, approval: "sealed" as const } : w)) };
    await opScenario("sealed", sealed, { plans }, [
      { wave: 2, label: "an unsealed approval does not count", trust: () => ({ base: "b".repeat(40), signersPath: ".chant/signers.json", active: true, signers: [], excluded: [], roles: {}, adopted: [], runners: [], excludedRunners: [], admitted: {}, problems: [] }), gates: memoryGateLedgerPort({ resolutions: [resolution("migrations", "migrations-wave-2", stagingSet)] }) },
    ]);
  });
});

/* ---------------------------------------------------------------- fan-out */

const fanRoot = (name: string, dependsOn?: string[], vars?: Record<string, unknown>): DriverComponent => ({
  name,
  deploy: [{ phase: "Apply", steps: [{ kind: "fake-root", root: name, ...(vars ? { vars } : {}) }] }],
  ...(dependsOn ? { dependsOn } : {}),
});

/** net, then a and b; app reads a's output. */
const ESTATE: DriverComponent[] = [fanRoot("net"), fanRoot("a", ["net"]), fanRoot("b", ["net"]), fanRoot("app", ["a"], { upstream: { stackOutput: { stack: "a", name: "id" } } })];

type FanWorld = { failing?: string[]; failPlan?: string[]; sameRoot?: Record<string, string>; noMembers?: string[] };

function fanWorld(opts: FanWorld = {}) {
  const registry = new CapabilityRegistry();
  const applied: string[] = [];
  registry.register({
    kind: "fake-root",
    async plan(_ctx: DeployContext, input: { root: string; vars?: Record<string, unknown> }) {
      if (opts.failPlan?.includes(input.root)) throw new Error(`${input.root} cannot plan`);
      const member = opts.sameRoot?.[input.root] ?? input.root;
      const planDigest = `sha256:${Buffer.from(JSON.stringify(input)).toString("hex").slice(0, 64).padEnd(64, "0")}`;
      return { member, planDigest, artifact: { planDigest } };
    },
    async run(_ctx: DeployContext, input: { root: string }) {
      if (opts.failing?.includes(input.root)) throw new Error(`${input.root} failed`);
      applied.push(input.root);
      return { outputs: { id: `${input.root}-id` } };
    },
  } as never);
  // A component that plans to no member at all (#3049: its wave's digest is empty).
  const planComponent = opts.noMembers
    ? async (component: DriverComponent, ctx: DeployContext, outputs: Record<string, Record<string, unknown>>) =>
        opts.noMembers!.includes(component.name) ? { component: component.name, members: [], plans: {}, parts: [] } : planWaveComponent(component, registry, ctx, outputs)
    : undefined;
  return { registry, applied, planComponent };
}

function fanRun(world: FanWorld, gates: Gates, options: Partial<FanOutRunOptions> = {}, waveGate: Partial<NonNullable<FanOutRunOptions["waveGate"]>> = {}, changed = ["net"]) {
  const w = fanWorld(world);
  const plan = planFanOut({ components: ESTATE, changed });
  const run = runFanOut(plan, ESTATE, w.registry, {
    env: "test",
    gates,
    now: NOW,
    ...options,
    waveGate: { op: "fan-out", gate: "release", ...(w.planComponent ? { planComponent: w.planComponent } : {}), ...waveGate },
  });
  return { w, plan, run };
}

const scrubDurations = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value ?? null, (key, v) => (key === "durationMs" || key === "startedAt" || key === "finishedAt" ? 0 : v)));

async function fanScenario(
  name: string,
  jobs: Array<{ label?: string; world?: FanWorld; changed?: string[]; gates?: Gates; options?: Partial<FanOutRunOptions>; waveGate?: Partial<NonNullable<FanOutRunOptions["waveGate"]>> }>,
): Promise<void> {
  const out: unknown[] = [];
  for (const job of jobs) {
    const gates = job.gates ?? memoryGateLedgerPort();
    const events: RunProgressEvent[] = [];
    const settled: WaveRecord[] = [];
    const components: Array<{ component: string; outputs: unknown }> = [];
    const { w, plan, run } = fanRun(
      job.world ?? {},
      gates,
      {
        onProgress: (e) => events.push(e),
        onWaveSettled: (r) => settled.push(r),
        onComponentSettled: (r, outputs) => components.push({ component: r.component, outputs }),
        ...job.options,
      },
      job.waveGate,
      job.changed,
    );
    let result: unknown;
    try {
      result = await run;
    } catch (err) {
      result = { threw: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
    out.push({ ...(job.label ? { label: job.label } : {}), plan, result, events, settled, components, applied: w.applied, ledger: ledgerOf(gates) });
  }
  await expect(JSON.stringify(scrubDurations(out), null, 2) + "\n").toMatchFileSnapshot(`${GOLDEN}/fan-out-${name}.json`);
}

describe("fan-out --wave-gate golden transcripts (#3766)", () => {
  const fanResolution = (gate: string, planDigest: string): GateResolutionRecord => ({ version: 1, op: "fan-out", gate, resolvedBy: "ana", timestamp: BEFORE, planDigest });

  test("waves gate in turn; an approval lets one through; another digest's approval does not", async () => {
    const first = (await fanRun({}, memoryGateLedgerPort()).run).waves![0]!.digest;
    await fanScenario("gated", [
      { label: "wave 1 waits" },
      { label: "wave 1 approved, wave 2 waits", gates: memoryGateLedgerPort({ resolutions: [fanResolution("release-wave-1", first)] }) },
      { label: "another digest approved", gates: memoryGateLedgerPort({ resolutions: [fanResolution("release-wave-1", digest("9"))] }) },
      { label: "with a description and timeout", waveGate: { description: "the release", timeout: "2h" } },
    ]);
  });

  test("every wave approved; a failure blocks its dependents; a plan failure; two components planning one root", async () => {
    const approveAll = async (world: FanWorld = {}) => {
      // Approve whatever each wave asks for, one wave at a time.
      const resolutions: GateResolutionRecord[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await fanRun(world, memoryGateLedgerPort({ resolutions })).run;
        if (!r.gate) break;
        resolutions.push(fanResolution(r.gate.gate, r.gate.planDigest!));
      }
      return memoryGateLedgerPort({ resolutions });
    };
    await fanScenario("applied", [{ label: "all approved", gates: await approveAll() }]);
    await fanScenario("apply-fails", [{ label: "a fails", world: { failing: ["a"] }, gates: await approveAll({ failing: ["a"] }) }]);
    await fanScenario("plan-fails", [{ label: "a cannot plan", world: { failPlan: ["a"] }, gates: await approveAll({ failPlan: ["a"] }) }]);
    await fanScenario("same-root", [{ label: "a and b plan one root", world: { sameRoot: { a: "shared", b: "shared" } }, gates: await approveAll({ sameRoot: { a: "shared", b: "shared" } }) }]);
    await fanScenario("no-members", [
      { label: "b plans nothing", world: { noMembers: ["b"] }, gates: await approveAll({ noMembers: ["b"] }) },
      { label: "a wave where nothing planned asks its gate with an empty digest", world: { noMembers: ["net"] } },
      { label: "approved at the empty digest", world: { noMembers: ["net"] }, gates: memoryGateLedgerPort({ resolutions: [fanResolution("release-wave-1", "")] }) },
    ]);
  });

  test("one job per wave (only) and a resumed attempt", async () => {
    await fanScenario("only", [
      { label: "only wave 2 with wave 1 left", waveGate: { only: 2 } },
      { label: "only wave 1", waveGate: { only: 1 } },
      { label: "only wave 2 after wave 1 completed", waveGate: { only: 2 }, options: { progress: { completed: ["net"] } } },
      { label: "resume past a failure", options: { progress: { completed: ["net"], failed: ["a"] } } },
    ]);
  });
});
