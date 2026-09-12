/**
 * `chant components fan-out` (#2420) — the command that joins the change
 * signal to the derived run.
 *
 * The five behaviours #2420's proof list names are asserted here against a
 * fake capability registry and an in-memory gate ledger, so they need no cloud
 * and no git; the example estate then demonstrates the same five against
 * something that is not a fixture.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Component } from "../../components/component";
import type { ParsedArgs } from "../registry";

const affectedStacksMock = vi.fn();
const discoverComponentsMock = vi.fn();
const loadChantConfigMock = vi.fn();
const buildCapabilityRegistryMock = vi.fn();

vi.mock("../../lifecycle/affected", () => ({
  affectedStacks: (...args: unknown[]) => affectedStacksMock(...args),
}));

vi.mock("../../components/discover", () => ({
  discoverComponents: (...args: unknown[]) => discoverComponentsMock(...args),
}));

vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: (...args: unknown[]) => loadChantConfigMock(...args) };
});

vi.mock("../../components/capability-plugin-loader", () => ({
  buildCapabilityRegistry: (...args: unknown[]) => buildCapabilityRegistryMock(...args),
}));

/**
 * The gate ledger the runner reaches for. Mocked rather than spied because the
 * real one is the `chant/lifecycle` git branch: a test that forgot to replace
 * it would append this repository's own history from a unit test.
 */
vi.mock("../../op/gate", async () => {
  const actual = await vi.importActual<typeof import("../../op/gate")>("../../op/gate");
  return { ...actual, gitGateLedgerPort: () => gateLedger };
});

const { CapabilityRegistry } = await import("../../components/capability");
const { memoryGateLedgerPort } = await import("../../op/gate");
const { runComponentsFanOut } = await import("./fan-out");

let gateLedger = memoryGateLedgerPort();

/** A component whose one deploy step is `apply`, claiming the live unit `<name>-stack`. */
function component(name: string, dependsOn: string[] = []): Component {
  return {
    name,
    dependsOn,
    deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: `${name}-stack` }] }],
  };
}

/** net -> two clusters -> three apps, plus a branch nothing upstream touches. */
const ESTATE = [
  component("net"),
  component("cluster-a", ["net"]),
  component("cluster-b", ["net"]),
  component("app-one", ["cluster-a"]),
  component("app-two", ["cluster-a"]),
  component("app-three", ["cluster-b"]),
  component("billing"),
];

let ran: string[] = [];
let failing: string[] = [];

function makeArgs(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    command: "components",
    path: "fan-out",
    format: "",
    fix: false,
    watch: false,
    verbose: false,
    help: false,
    live: false,
    ...overrides,
  };
}

const ctx = (overrides: Partial<ParsedArgs>) => ({ args: makeArgs(overrides), plugins: [], serializers: [] });

let stderrLines: string[] = [];
let stdoutLines: string[] = [];
let errSpy: ReturnType<typeof vi.spyOn>;
let outSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  ran = [];
  failing = [];
  gateLedger = memoryGateLedgerPort();
  stderrLines = [];
  stdoutLines = [];
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  });
  outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdoutLines.push(String(chunk));
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrLines.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    stdoutLines.push(args.map(String).join(" "));
  });

  loadChantConfigMock.mockResolvedValue({ config: { lexicons: ["aws"] } });
  discoverComponentsMock.mockResolvedValue({
    components: new Map(ESTATE.map((c) => [c.name, { component: c, exportName: c.name, filePath: `${c.name}.component.ts` }])),
    sourceFiles: [],
    errors: [],
  });
  buildCapabilityRegistryMock.mockImplementation(() => {
    const registry = new CapabilityRegistry();
    registry.register({
      kind: "cfn-deploy",
      async run(runCtx: { component: string }) {
        ran.push(runCtx.component);
        if (failing.includes(runCtx.component)) throw new Error(`${runCtx.component} failed`);
        return { ok: true };
      },
    } as never);
    return Promise.resolve(registry);
  });
  affectedStacksMock.mockResolvedValue({ changed: ["net-stack"], dependents: [], indeterminate: [] });
});

afterEach(() => {
  errSpy.mockRestore();
  outSpy.mockRestore();
  vi.restoreAllMocks();
});

const stderr = () => stderrLines.join("");
const stdout = () => stdoutLines.join("");

describe("the change signal", () => {
  test("--base derives it here, and the join reports the components it means", async () => {
    const exit = await runComponentsFanOut(ctx({ base: "main", dryRun: true }));
    expect(exit).toBe(0);
    expect(affectedStacksMock).toHaveBeenCalledWith(expect.objectContaining({ baseRef: "main" }));
    expect(stderr()).toContain("wave 1: net");
    expect(stderr()).toContain("wave 3: app-one, app-three, app-two");
  });

  test("--from-affected reads what `lifecycle affected --json` wrote, and builds nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fan-out-"));
    try {
      const file = join(dir, "affected.json");
      await writeFile(file, JSON.stringify({ changed: ["cluster-b-stack"], dependents: [], indeterminate: [] }));
      const exit = await runComponentsFanOut(ctx({ fromAffected: file, dryRun: true }));
      expect(exit).toBe(0);
      expect(affectedStacksMock).not.toHaveBeenCalled();
      expect(stderr()).toContain("wave 1: cluster-b");
      expect(stderr()).toContain("wave 2: app-three");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("neither is a refusal that names both ways of supplying one", async () => {
    const exit = await runComponentsFanOut(ctx({ dryRun: true }));
    expect(exit).toBe(1);
    expect(stderr()).toContain("--base");
    expect(stderr()).toContain("--from-affected");
  });

  test("both at once is refused rather than one silently winning", async () => {
    const exit = await runComponentsFanOut(ctx({ base: "main", fromAffected: "x.json", dryRun: true }));
    expect(exit).toBe(1);
    expect(stderr()).toContain("both name a change signal");
  });

  test("a changed unit no component deploys is reported, not dropped", async () => {
    affectedStacksMock.mockResolvedValue({ changed: ["net-stack", "orphan-stack"], dependents: [], indeterminate: [] });
    await runComponentsFanOut(ctx({ base: "main", dryRun: true }));
    expect(stderr()).toContain("no component deploys these changed unit(s): orphan-stack");
  });
});

describe("proof: a plan-only invocation prints the derivation and dispatches nothing", () => {
  test("--dry-run prints waves, reasons, seeds and the digest, and runs nothing", async () => {
    affectedStacksMock.mockResolvedValue({ changed: ["cluster-a-stack"], dependents: [], indeterminate: [] });
    const exit = await runComponentsFanOut(ctx({ base: "main", dryRun: true, gate: "release" }));

    expect(exit).toBe(0);
    expect(ran).toEqual([]);
    const out = stderr();
    expect(out).toContain("wave 1: cluster-a");
    expect(out).toContain("seeded from an earlier run: net");
    expect(out).toMatch(/billing +unaffected/);
    expect(out).toMatch(/plan: sha256:[0-9a-f]{64}/);
    expect(out).toMatch(/approve: chant approve fan-out release --plan sha256:[0-9a-f]{64}/);
  });

  test("--dry-run with --resume shows what is left, at the digest that approves it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fan-out-"));
    try {
      const resume = join(dir, "attempt.json");
      failing = ["cluster-a"];
      await runComponentsFanOut(ctx({ base: "main", env: "test", resume }));
      const digest = /plan: (sha256:[0-9a-f]{64})/.exec(stderr())?.[1];

      ran = [];
      stderrLines = [];
      expect(await runComponentsFanOut(ctx({ base: "main", resume, dryRun: true }))).toBe(0);

      expect(ran).toEqual([]);
      const out = stderr();
      expect(out).toContain("wave 1: cluster-a");
      expect(out).toMatch(/net +already-applied/);
      // Carried, not recomputed: this is still the digest an approval binds to.
      expect(out).toContain(`plan: ${digest}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("--dry-run --json puts the plan on stdout and nothing else", async () => {
    const exit = await runComponentsFanOut(ctx({ base: "main", dryRun: true, json: true }));
    expect(exit).toBe(0);
    const parsed = JSON.parse(stdout());
    expect(parsed.order).toEqual(["net", "cluster-a", "cluster-b", "app-one", "app-three", "app-two"]);
    expect(parsed.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("proof: the run applies exactly the components the plan named, in the printed order", () => {
  test("downstream runs, unrelated does not, and no apply precedes its dependency", async () => {
    const exit = await runComponentsFanOut(ctx({ base: "main", env: "test" }));

    expect(exit).toBe(0);
    expect(ran).toContain("net");
    expect(ran).not.toContain("billing");
    expect(ran.indexOf("net")).toBeLessThan(ran.indexOf("cluster-a"));
    expect(ran.indexOf("cluster-a")).toBeLessThan(ran.indexOf("app-one"));
    expect(stderr()).toContain("fan-out completed: 6 applied, 0 failed, 0 blocked");
  });

  test("a change to a leaf propagates to nothing", async () => {
    affectedStacksMock.mockResolvedValue({ changed: ["app-three-stack"], dependents: [], indeterminate: [] });
    await runComponentsFanOut(ctx({ base: "main", env: "test" }));
    expect(ran).toEqual(["app-three"]);
  });
});

describe("proof: a mid-run failure blocks its subtree and leaves the independent branch alone", () => {
  test("the blocked components name the failure, and cluster-b's branch still applies", async () => {
    failing = ["cluster-a"];
    const exit = await runComponentsFanOut(ctx({ base: "main", env: "test" }));

    expect(exit).toBe(1);
    expect(ran).not.toContain("app-one");
    expect(ran).not.toContain("app-two");
    expect(ran).toContain("app-three");
    const out = stderr();
    expect(out).toContain('app-one: blocked by "cluster-a", so it never ran');
    expect(out).toContain("failed: cluster-a");
    expect(out).toContain("fan-out failed: 3 applied, 1 failed, 2 blocked");
  });
});

describe("proof: the re-run prints already-applied for what it skips, and finishes", () => {
  test("repeating the identical command finishes the fan-out, and the approval is not re-asked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fan-out-"));
    try {
      const resume = join(dir, "attempt.json");

      failing = ["cluster-a"];
      expect(await runComponentsFanOut(ctx({ base: "main", env: "test", resume }))).toBe(1);
      const afterFailure = JSON.parse(await readFile(resume, "utf8"));
      expect(afterFailure.completed).toEqual(["app-three", "cluster-b", "net"]);
      expect(afterFailure.failed).toEqual(["cluster-a"]);

      // Whatever broke is fixed; the same command again.
      ran = [];
      failing = [];
      stderrLines = [];
      expect(await runComponentsFanOut(ctx({ base: "main", env: "test", resume }))).toBe(0);

      expect(ran).toEqual(["cluster-a", "app-one", "app-two"]);
      const out = stderr();
      expect(out).toMatch(/net +already-applied/);
      expect(out).toMatch(/cluster-b +already-applied/);
      expect(out).toContain("fan-out completed: 3 applied, 0 failed, 0 blocked");

      // Once more: everything is applied, so it finishes having run nothing.
      ran = [];
      stderrLines = [];
      expect(await runComponentsFanOut(ctx({ base: "main", env: "test", resume }))).toBe(0);
      expect(ran).toEqual([]);
      expect(stderr()).toContain("nothing to run");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("an attempt record for a different fan-out is refused rather than misapplied", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fan-out-"));
    try {
      const resume = join(dir, "attempt.json");
      await writeFile(resume, JSON.stringify({ digest: "sha256:" + "0".repeat(64), completed: ["net"], failed: [] }));
      const exit = await runComponentsFanOut(ctx({ base: "main", env: "test", resume }));
      expect(exit).toBe(0);
      expect(stderr()).toContain("records a different fan-out");
      // Its progress was not applied: `net` ran.
      expect(ran).toContain("net");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("proof: one approval covers the set, and the printed digest is what approves it", () => {
  test("an unapproved gate stops the whole fan-out before anything runs", async () => {
    const exit = await runComponentsFanOut(ctx({ base: "main", env: "test", gate: "release" }));

    expect(exit).toBe(3);
    expect(ran).toEqual([]);
    const out = stderr();
    expect(out).toContain("gated: nothing ran.");
    expect(out).toMatch(/approve : chant approve fan-out release --plan sha256:[0-9a-f]{64}/);
    // One pending fact for the whole set, not one per component.
    expect(gateLedger.appended).toHaveLength(1);
    expect(gateLedger.appended[0].planDigest).toBe(/plan: (sha256:[0-9a-f]{64})/.exec(out)?.[1]);
  });

  test("the resolution for that digest lets the whole set through", async () => {
    await runComponentsFanOut(ctx({ base: "main", env: "test", gate: "release" }));
    const pending = gateLedger.appended[0];

    gateLedger = memoryGateLedgerPort({
      pending: [pending],
      resolutions: [
        {
          version: 1,
          kind: "resolution",
          op: "fan-out",
          gate: "release",
          resolvedBy: "operator",
          timestamp: new Date(Date.parse(pending.timestamp) + 1000).toISOString(),
          planDigest: pending.planDigest,
        },
      ],
    });

    stderrLines = [];
    const exit = await runComponentsFanOut(ctx({ base: "main", env: "test", gate: "release" }));
    expect(exit).toBe(0);
    expect(ran).toContain("net");
    expect(ran).toContain("app-one");
    expect(stderr()).toContain("fan-out completed: 6 applied, 0 failed, 0 blocked");
  });

  test("an approval for a different fan-out does not ride along", async () => {
    await runComponentsFanOut(ctx({ base: "main", env: "test", gate: "release" }));
    const pending = gateLedger.appended[0];

    gateLedger = memoryGateLedgerPort({
      pending: [pending],
      resolutions: [
        {
          version: 1,
          kind: "resolution",
          op: "fan-out",
          gate: "release",
          resolvedBy: "operator",
          timestamp: new Date(Date.parse(pending.timestamp) + 1000).toISOString(),
          planDigest: "sha256:" + "0".repeat(64),
        },
      ],
    });

    ran = [];
    stderrLines = [];
    expect(await runComponentsFanOut(ctx({ base: "main", env: "test", gate: "release" }))).toBe(3);
    expect(ran).toEqual([]);
  });
});
