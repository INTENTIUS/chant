/**
 * `chant run --components` and `chant components fan-out` order an importer
 * after its exporter when the read is one a capability declares (chant#4516):
 * a template's `Fn::ImportValue` of another component's export, which
 * `declaredReads` (#4466a) finds and core writes into the reader's step as a
 * `stackOutput()` plus a `dependsOn`. Driven through the CLI handlers, as
 * run-groups-cli.test.ts drives group formation (chant#4505).
 *
 * Discovery, config, the capability registry and the gate ledger are fakes.
 * app is discovered first and declares no `dependsOn`, so only the declared
 * read can put network ahead of it. edge reads nothing.
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
  imports?: Record<string, unknown>;
}

const stack = (name: string): Component => ({
  name,
  dependsOn: [],
  deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy", stack: name, template: `${name}.template.json` }] }],
});
const COMPONENTS = [stack("app"), stack("network"), stack("edge")];
/** app's template imports `Net-VpcId`, which network's template exports from its `VpcId` output. */
const READ = { reader: "app", index: 0, upstream: "network", output: "VpcId", at: "/imports/Net-VpcId" };

let declares = true;
let applied: Array<{ stack: string; imports?: Record<string, unknown> }> = [];
let stderrLines: string[] = [];

function registry() {
  const r = new CapabilityRegistry();
  r.register({
    kind: "cfn-deploy",
    async plan(_ctx: unknown, input: StackInput) {
      const planDigest = computePlanDigest("cfn-deploy", { stack: input.stack, imports: input.imports ?? null });
      return {
        member: input.stack,
        planDigest,
        artifact: { planDigest },
        outputs: { known: {}, unknown: ["VpcId"] },
        changeSet: {
          member: { member: input.stack, lexicon: "aws", planner: "tofu" as const, status: "planned" as const, planDigest, holes: [] },
          entries: [{ member: input.stack, lexicon: "aws", planner: "tofu" as const, address: "res.x", type: "res", action: "create" as const, attributes: [] }],
        },
      };
    },
    async run(_ctx: unknown, input: StackInput) {
      applied.push({ stack: input.stack, ...(input.imports ? { imports: input.imports } : {}) });
      return { outputs: { VpcId: `${input.stack}-vpc` } };
    },
    ...(declares
      ? {
          declaredReads(_ctx: unknown, members: ReadonlyArray<{ component: string }>) {
            return members.some((m) => m.component === READ.reader) ? [READ] : [];
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
const order = () => applied.map((a) => a.stack);

beforeEach(() => {
  vi.clearAllMocks();
  declares = true;
  applied = [];
  stderrLines = [];
  discoverComponentsMock.mockResolvedValue({
    components: new Map(COMPONENTS.map((c) => [c.name, { component: c, exportName: c.name, filePath: `${c.name}.component.ts` }])),
    sourceFiles: [],
    errors: [],
  });
  buildCapabilityRegistryMock.mockImplementation(async () => registry());
  affectedStacksMock.mockResolvedValue({ changed: ["network"], dependents: [], indeterminate: [] });
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

describe("chant run --components orders an importer after its exporter (chant#4516)", () => {
  test("all: network applies before app, and app's step gets network's output under imports", async () => {
    expect(await runOpComponents(runCtx("all"))).toBe(0);
    expect(order().indexOf("network")).toBeLessThan(order().indexOf("app"));
    expect(applied.find((a) => a.stack === "app")).toEqual({ stack: "app", imports: { "Net-VpcId": "network-vpc" } });
    expect(order().sort()).toEqual(["app", "edge", "network"]);
  });

  test("a list naming the importer pulls in its exporter, says so, and runs it first", async () => {
    expect(await runOpComponents(runCtx("app,edge"))).toBe(0);
    expect(stderr()).toContain("added as dependencies: network");
    expect(stderr()).toMatch(/run order: .*network.*, then app/);
    expect(order().indexOf("network")).toBeLessThan(order().indexOf("app"));
    expect(applied.find((a) => a.stack === "app")?.imports).toEqual({ "Net-VpcId": "network-vpc" });
  });

  test("a single name runs that component alone; a read of a component outside the run is left out", async () => {
    expect(await runOpComponents(runCtx("app"))).toBe(0);
    expect(applied).toEqual([{ stack: "app" }]);
  });

  test("without declaredReads a list adds nothing and app gets no imports, as before", async () => {
    declares = false;
    expect(await runOpComponents(runCtx("app,edge"))).toBe(0);
    expect(stderr()).not.toContain("added as dependencies");
    expect(order().sort()).toEqual(["app", "edge"]);
    expect(applied.find((a) => a.stack === "app")?.imports).toBeUndefined();
  });
});

describe("chant components fan-out orders an importer after its exporter (chant#4516)", () => {
  test("a changed network pulls in app, which applies after it with network's output", async () => {
    expect(await runComponentsFanOut(fanOutCtx({ base: "main" }))).toBe(0);
    expect(order()).toEqual(["network", "app"]);
    expect(applied[1]).toEqual({ stack: "app", imports: { "Net-VpcId": "network-vpc" } });
  });
});
