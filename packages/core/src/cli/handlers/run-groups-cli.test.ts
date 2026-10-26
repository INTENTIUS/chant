/**
 * `chant components fan-out` and `chant run --components` form composed
 * groups (ws-107, #4465), driven through their CLI handlers (chant#4505).
 * `release-groups.test.ts` covers `runFanOut` and `runInterpretDriver` given
 * a grouped plan; this drives the commands that form the plan themselves, the
 * path that went red at round 1's epic-ready (`run --components` forming its
 * groups before the graph was resolved).
 *
 * Discovery, config, the capability registry and the gate ledger are fakes.
 * The fake `cfn-deploy` creates one stack whose `id` is known only after it
 * applies; with the group pair it declares `planGroup` and `runGroup`. b reads
 * a's id and c reads b's, so a, b and c form one group.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Component } from "../../components/component";
import type { ParsedArgs } from "../registry";

const affectedStacksMock = vi.fn();
const discoverComponentsMock = vi.fn();
const buildCapabilityRegistryMock = vi.fn();

vi.mock("../../lifecycle/affected", () => ({
  affectedStacks: (...args: unknown[]) => affectedStacksMock(...args),
}));

vi.mock("../../components/discover", () => ({
  discoverComponents: (...args: unknown[]) => discoverComponentsMock(...args),
}));

vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: async () => ({ config: { lexicons: ["aws"] } }) };
});

vi.mock("../../components/capability-plugin-loader", () => ({
  buildCapabilityRegistry: (...args: unknown[]) => buildCapabilityRegistryMock(...args),
}));

/** The real gate ledger is this repository's `chant/lifecycle` branch; a test never appends to it. */
vi.mock("../../op/gate", async () => {
  const actual = await vi.importActual<typeof import("../../op/gate")>("../../op/gate");
  return { ...actual, gitGateLedgerPort: () => actual.memoryGateLedgerPort(), gateIsSealed: async () => false };
});

/** The release ledger, for the same reason. */
vi.mock("../../components/auto-release", async () => {
  const actual = await vi.importActual<typeof import("../../components/auto-release")>("../../components/auto-release");
  return { ...actual, maybeRecordAutoRelease: async () => ({ recorded: false, reason: "opted-out" }) };
});

/** `run --components` on the local runtime: the real `runComponents`, with the test's registry. */
vi.mock("../../op/runtimes/local", async () => {
  const { runComponents } = await import("../../components/cli-support");
  const { memoryGateLedgerPort } = await import("../../op/gate");
  return {
    createLocalOpRuntime: () => ({
      name: "local",
      runComponents: async (path: string, selector: string, options: object) =>
        runComponents(path, selector, { ...options, registry: await buildCapabilityRegistryMock(), config: {}, revision: null, gates: memoryGateLedgerPort() }),
    }),
  };
});

const { CapabilityRegistry } = await import("../../components/capability");
const { computePlanDigest } = await import("../../lifecycle/plan-digest");
const { runComponentsFanOut } = await import("./fan-out");
const { runOpComponents } = await import("./run");

interface StackInput {
  stack: string;
  vars?: Record<string, unknown>;
}

const so = (stack: string, name: string) => ({ stackOutput: { stack, name } });
const stack = (name: string, dependsOn: string[] = [], vars?: Record<string, unknown>): Component => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: name, ...(vars ? { vars } : {}) }] }],
});
/** a; b reads a's new id; c reads b's. */
const ABC = [stack("a"), stack("b", ["a"], { upstream: so("a", "id") }), stack("c", ["b"], { upstream: so("b", "id") })];

let group = true;
let planned: string[] = [];
let applied: string[] = [];
let planGroupCalls: string[][] = [];
let runGroupCalls: string[][] = [];
let stderrLines: string[] = [];

function registry() {
  const r = new CapabilityRegistry();
  const planOf = (input: StackInput) => {
    const planDigest = computePlanDigest("cfn-deploy", { stack: input.stack, vars: input.vars ?? null });
    return {
      member: input.stack,
      planDigest,
      artifact: { planDigest },
      outputs: { known: {}, unknown: ["id"] },
      changeSet: {
        member: { member: input.stack, lexicon: "aws", planner: "tofu" as const, status: "planned" as const, planDigest, holes: [] },
        entries: [{ member: input.stack, lexicon: "aws", planner: "tofu" as const, address: "res.x", type: "res", action: "create" as const, attributes: [] }],
      },
    };
  };
  r.register({
    kind: "cfn-deploy",
    async plan(_ctx: unknown, input: StackInput) {
      planned.push(input.stack);
      return planOf(input);
    },
    async run(_ctx: unknown, input: StackInput) {
      applied.push(input.stack);
      return { outputs: { id: `${input.stack}-id` } };
    },
    ...(group
      ? {
          async planGroup(_ctx: unknown, members: ReadonlyArray<{ component: string; input?: StackInput }>) {
            planGroupCalls.push(members.map((m) => m.component));
            return {
              members: Object.fromEntries(members.map((m) => [m.component, planOf(m.input!)])),
              digest: computePlanDigest("fake-composition", members.map((m) => m.component)),
              artifact: { composed: members.map((m) => m.component) },
            };
          },
          async runGroup(_ctx: unknown, _run: unknown, members: ReadonlyArray<{ component: string }>) {
            runGroupCalls.push(members.map((m) => m.component));
            return { members: Object.fromEntries(members.map((m) => [m.component, { status: "applied" as const, outputs: { id: `${m.component}-id` } }])) };
          },
        }
      : {}),
  } as never);
  return r;
}

const baseArgs = { format: "", fix: false, watch: false, verbose: false, help: false, live: false };
const fanOutCtx = (overrides: Partial<ParsedArgs> = {}) => ({ args: { command: "components", path: "fan-out", ...baseArgs, ...overrides } as ParsedArgs, plugins: [], serializers: [] }) as never;
const runCtx = (selector: string) => ({ args: { command: "run", path: selector, components: true, on: "local", ...baseArgs } as ParsedArgs, plugins: [] }) as never;
const stderr = () => stderrLines.join("\n");

beforeEach(() => {
  vi.clearAllMocks();
  group = true;
  planned = [];
  applied = [];
  planGroupCalls = [];
  runGroupCalls = [];
  stderrLines = [];
  discoverComponentsMock.mockResolvedValue({
    components: new Map(ABC.map((c) => [c.name, { component: c, exportName: c.name, filePath: `${c.name}.component.ts` }])),
    sourceFiles: [],
    errors: [],
  });
  buildCapabilityRegistryMock.mockImplementation(async () => registry());
  affectedStacksMock.mockResolvedValue({ changed: ["a"], dependents: [], indeterminate: [] });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderrLines.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderrLines.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chant components fan-out forms groups (#4465, chant#4505)", () => {
  test("a changed a pulls in b and c; the three plan with one planGroup and apply with one runGroup, and the report names the group", async () => {
    const exit = await runComponentsFanOut(fanOutCtx({ base: "main" }));
    expect(exit).toBe(0);
    expect(planGroupCalls).toEqual([["a", "b", "c"]]);
    expect(runGroupCalls).toEqual([["a", "b", "c"]]);
    // No member ran its own deploy.
    expect(applied).toEqual([]);
    expect(stderr()).toContain("a, b and c plan and apply as one (cfn-deploy, wave 1");
    expect(stderr()).toContain("a applied; b applied; c applied");
  });

  test("without the group pair each component applies by itself, as before", async () => {
    group = false;
    const exit = await runComponentsFanOut(fanOutCtx({ base: "main" }));
    expect(exit).toBe(0);
    expect(planGroupCalls).toEqual([]);
    expect(runGroupCalls).toEqual([]);
    expect(applied).toEqual(["a", "b", "c"]);
    expect(stderr()).not.toContain("plan and apply as one");
  });
});

describe("chant run --components forms groups (#4465, chant#4505)", () => {
  test("all: one planGroup and one runGroup over a, b and c, and no member's own deploy", async () => {
    expect(await runOpComponents(runCtx("all"))).toBe(0);
    expect(planGroupCalls).toEqual([["a", "b", "c"]]);
    expect(runGroupCalls).toEqual([["a", "b", "c"]]);
    expect(applied).toEqual([]);
  });

  test("a list that pulls in its dependency groups the whole set the run resolved", async () => {
    expect(await runOpComponents(runCtx("b,c"))).toBe(0);
    expect(planGroupCalls).toEqual([["a", "b", "c"]]);
    expect(runGroupCalls).toEqual([["a", "b", "c"]]);
    expect(applied).toEqual([]);
  });

  test("a dependency outside the discovered set fails as it does without groups, before any group plans (round 1's red)", async () => {
    const withUnknown = [...ABC, stack("d", ["missing"])];
    discoverComponentsMock.mockResolvedValue({
      components: new Map(withUnknown.map((c) => [c.name, { component: c, exportName: c.name, filePath: `${c.name}.component.ts` }])),
      sourceFiles: [],
      errors: [],
    });
    const exit = await runOpComponents(runCtx("all")).catch(() => 1);
    expect(exit).not.toBe(0);
    expect(stderr()).toContain("missing");
    expect(planGroupCalls).toEqual([]);
    expect(runGroupCalls).toEqual([]);
    expect(applied).toEqual([]);
  });

  test("without the group pair each component applies by itself, in order", async () => {
    group = false;
    expect(await runOpComponents(runCtx("all"))).toBe(0);
    expect(planGroupCalls).toEqual([]);
    expect(applied).toEqual(["a", "b", "c"]);
  });
});
