/**
 * `chant components pr-plan` and `pr-apply` with `--events-json` (#4041,
 * #4007): the planning as a `plan` phase, the gate's decision as a `gate`
 * phase, and on pr-apply the waves and components of the apply, all on one
 * schema-valid stream. Git, the change signal, the derivation and the gate
 * ledger are fakes; the planning and the apply are the real ones.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DriverComponent } from "../../components/driver";
import type { DeployContext } from "../../components/capability";
import type { ParsedArgs } from "../registry";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

vi.mock("../../components/changed-files", () => ({
  resolveCommit: async () => HEAD,
  resolveMergeBase: async () => BASE,
}));

vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: async () => ({ config: {} }) };
});

vi.mock("./fan-out", () => ({
  resolveChangedUnits: async () => ({ units: { changed: ["net"], indeterminate: [] } }),
}));

vi.mock("./run", () => ({
  GATED_EXIT_CODE: 3,
  autoReleaseRun: (id: string) => ({ runId: id, runOrigin: { forge: "local" } }),
  recordAutoReleasesForRun: async () => [],
}));

let gateLedger: ReturnType<typeof import("../../op/gate").memoryGateLedgerPort>;
vi.mock("../../op/gate", async () => {
  const actual = await vi.importActual<typeof import("../../op/gate")>("../../op/gate");
  return { ...actual, gitGateLedgerPort: () => gateLedger, gateIsSealed: async () => false };
});

const failing = new Set<string>();
vi.mock("../../components/fan-out-support", async () => {
  const { CapabilityRegistry } = await import("../../components/capability");
  const { planFanOut } = await import("../../components/fan-out");
  const { computePlanDigest } = await import("../../lifecycle/plan-digest");
  const registry = new CapabilityRegistry();
  registry.register({
    kind: "fake-root",
    async plan(_ctx: DeployContext, input: { root: string }) {
      const planDigest = computePlanDigest("fake-root", { root: input.root });
      return {
        member: input.root,
        planDigest,
        artifact: { planDigest },
        changeSet: { member: { member: input.root, lexicon: "terraform", planner: "tofu", status: "planned", planDigest, holes: [] }, entries: [] },
      };
    },
    async outputs() {
      return {};
    },
    async run(_ctx: DeployContext, input: { root: string }) {
      if (failing.has(input.root)) throw new Error(`${input.root} failed`);
      return { outputs: {} };
    },
  } as never);
  return {
    fanOutRegistry: async () => registry,
    deriveFanOut: async () => ({
      success: true,
      components: ESTATE,
      plan: planFanOut({ components: ESTATE, changed: ["net"] }),
      signal: { changed: ["net"], indeterminate: [], unclaimed: [] },
    }),
  };
});

const root = (name: string, dependsOn: string[] = []): DriverComponent => ({
  name,
  dependsOn,
  deploy: [{ phase: "Apply", steps: [{ kind: "fake-root", root: name }] }],
});
const ESTATE: DriverComponent[] = [root("net"), root("app", ["net"])];

const { memoryGateLedgerPort } = await import("../../op/gate");
const { runComponentsPrApply, runComponentsPrPlan } = await import("./pr");
const { checkRunEventLines, stepTrail } = await import("../../workspace/__fixtures__/run-event-check");

let dir: string;
let out: string[];

const ctx = (a: Partial<ParsedArgs>) =>
  ({ args: { command: "components", path: "pr-apply", format: "", fix: false, watch: false, verbose: false, help: false, live: false, base: "main", env: "prod", output: dir, eventsJson: true, ...a } as ParsedArgs, plugins: [] }) as never;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pr-events-"));
  out = [];
  failing.clear();
  gateLedger = memoryGateLedgerPort();
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

/** The digest pr-plan printed, read back from its report. */
async function plannedDigest(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  return JSON.parse(await readFile(join(dir, "pr-plan.json"), "utf8")).digest as string;
}

describe("pr-plan --events-json", () => {
  test("plans each component in a plan phase, then says where the approval stands; the run settles ok", async () => {
    expect(await runComponentsPrPlan(ctx({ pr: 12 }))).toBe(0);
    const events = checkRunEventLines(out);
    expect(events[0]).toMatchObject({ type: "run-start", kind: "component", name: "pr-plan pr-12", waves: [["net"], ["app"]] });
    expect(stepTrail(events)).toEqual([
      ["step-start", "plan"], ["step-settle", "plan", "ok"],
      ["step-start", "plan"], ["step-settle", "plan", "ok"],
      ["step-start", "gate:pr-apply"], ["gate-waiting", "gate:pr-apply"], ["step-settle", "gate:pr-apply", "gated"],
    ]);
    expect(events.filter((e) => e.type === "step-start" && e.phase === "plan").map((e) => (e as { component: string }).component)).toEqual(["net", "app"]);
    // The plan stage reads the ledger and writes nothing to it.
    expect(gateLedger.appended).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "ok" });
  });
});

describe("pr-apply --events-json", () => {
  test("refused: the gate phase settles gated with the reason, nothing applies, and the run is gated", async () => {
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(3);
    const events = checkRunEventLines(out);
    expect(events[0]).toMatchObject({ name: "pr-apply pr-12" });
    expect(events.find((e) => e.type === "gate-waiting")).toMatchObject({ op: "pr-12", gate: "pr-apply", message: expect.stringMatching(/No approval stands for this plan/) });
    expect(events.some((e) => e.type === "wave-start")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "gated" });
  });

  test("approved: the gate resolves, then each wave and component applies; a failure settles the run failed", async () => {
    await runComponentsPrPlan(ctx({ pr: 12 }));
    const digest = await plannedDigest();
    gateLedger = memoryGateLedgerPort({
      resolutions: [{ version: 1, kind: "resolution", op: "pr-12", gate: "pr-apply", resolvedBy: "github:alice", timestamp: new Date().toISOString(), planDigest: digest }],
    });
    out = [];
    failing.add("app");
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(1);
    const events = checkRunEventLines(out);
    expect(events.map((e) => e.type).filter((t) => t !== "step-start" && t !== "step-settle")).toEqual([
      "run-start",
      "phase-start", "phase-settle",
      "phase-start", "gate-resolved", "phase-settle",
      "wave-start", "component-start", "phase-start", "phase-settle", "component-settle", "wave-settle",
      "wave-start", "component-start", "phase-start", "phase-settle", "component-settle", "wave-settle",
      "run-settle",
    ]);
    expect(events.find((e) => e.type === "gate-resolved")).toMatchObject({ resolvedBy: "github:alice" });
    expect(events.find((e) => e.type === "component-settle" && e.component === "app")).toMatchObject({ status: "failed" });
    expect(events.at(-1)).toMatchObject({ type: "run-settle", status: "failed" });
  });
});

describe("--events-json beside --json", () => {
  test("is refused on pr-plan and pr-apply before anything plans, since both print to stdout", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...m: unknown[]) => { errors.push(m.join(" ")); });
    expect(await runComponentsPrPlan(ctx({ pr: 12, json: true }))).toBe(1);
    expect(await runComponentsPrApply(ctx({ pr: 12, json: true }))).toBe(1);
    expect(errors.filter((e) => /--events-json and --json both stream to stdout/.test(e))).toHaveLength(2);
    expect(out).toEqual([]);
  });
});
