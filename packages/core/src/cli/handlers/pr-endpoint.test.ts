/**
 * `chant components pr-plan` for an environment that declares an endpoint
 * (#4281): every request a capability's plan sends goes to that endpoint and
 * no other host, the way a `--live` read does (`../../live-endpoint.ts`).
 *
 * The capability stands in for azure's `arm-deploy`, gcp's `gcp-apply` and
 * aws's `cfn-deploy`: its plan reads the endpoint from its lexicon's ambient
 * var, else the real cloud's host, and sends a request through `fetch`, which
 * is replaced here and only records. Nothing leaves the process. Git, the
 * change signal, the derivation and the gate ledger are fakes, and the
 * lifecycle branch can't be pushed.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DriverComponent } from "../../components/driver";
import type { DeployContext } from "../../components/capability";
import type { EmulatorCapability } from "../../op/emulator-lifecycle";
import type { ParsedArgs } from "../registry";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const EMULATOR = "http://localhost:4566";
const REAL_CLOUD = "https://management.fakecloud.example";
const ENDPOINT_VAR = "FAKECLOUD_ENDPOINT_URL";

vi.mock("../../components/changed-files", () => ({
  resolveCommit: async () => HEAD,
  resolveMergeBase: async () => BASE,
}));

vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return {
    ...actual,
    loadChantConfig: async () => ({
      config: { environments: [{ name: "floci", endpoint: EMULATOR }, { name: "prod" }] },
    }),
  };
});

vi.mock("./fan-out", () => ({
  resolveChangedUnits: async () => ({ units: { changed: ["net"], indeterminate: [] } }),
}));

vi.mock("../../lifecycle/gate-change-set", () => ({
  storeGateChangeSet: async () => ({ written: false }),
  readGraphIds: async () => ({ ids: [] }),
  setGraphIdReader: () => {},
  gateGraphReader: () => async () => ({ ids: [] }),
}));
vi.mock("../../lifecycle/git", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/git")>("../../lifecycle/git");
  return { ...actual, pushLifecycleReport: async () => { throw new Error("pr-endpoint.test must not push chant/lifecycle"); } };
});

vi.mock("./run", () => ({
  GATED_EXIT_CODE: 3,
  autoReleaseRun: (id: string) => ({ runId: id, runOrigin: { forge: "local" } }),
  recordAutoReleasesForRun: async () => [],
}));

vi.mock("../../op/gate", async () => {
  const actual = await vi.importActual<typeof import("../../op/gate")>("../../op/gate");
  return { ...actual, gitGateLedgerPort: () => actual.memoryGateLedgerPort(), gateIsSealed: async () => false };
});

vi.mock("../../components/fan-out-support", async () => {
  const { CapabilityRegistry } = await import("../../components/capability");
  const { planFanOut } = await import("../../components/fan-out");
  const { computePlanDigest } = await import("../../lifecycle/plan-digest");
  const registry = new CapabilityRegistry();
  registry.register({
    kind: "fakecloud-deploy",
    async plan(_ctx: DeployContext, input: { root: string }) {
      // What arm-deploy, gcp-apply and cfn-deploy do: the ambient var, else the real host.
      const base = process.env[ENDPOINT_VAR] ?? REAL_CLOUD;
      await fetch(`${base}/deployments/${input.root}`);
      const planDigest = computePlanDigest("fakecloud-deploy", { root: input.root });
      return {
        member: input.root,
        planDigest,
        artifact: { planDigest },
        changeSet: { member: { member: input.root, lexicon: "fakecloud", planner: "fakecloud", status: "planned", planDigest, holes: [] }, entries: [] },
      };
    },
    async outputs() {
      return {};
    },
    async run() {
      throw new Error("pr-plan must not apply");
    },
  } as never);
  const component = (name: string, dependsOn: string[] = []): DriverComponent => ({
    name,
    dependsOn,
    deploy: [{ phase: "Apply", steps: [{ kind: "fakecloud-deploy", root: name }] }],
  });
  const estate = [component("net"), component("app", ["net"])];
  return {
    fanOutRegistry: async () => registry,
    deriveFanOut: async () => ({
      success: true,
      components: estate,
      plan: planFanOut({ components: estate, changed: ["net"] }),
      signal: { changed: ["net"], indeterminate: [], unclaimed: [] },
    }),
  };
});

/** The lexicon plugin, declaring its endpoint var through its emulator as aws, azure and gcp do. */
const emulator: EmulatorCapability = {
  spec: { name: "chant-fakecloud", image: "fakecloud:0", containerPort: 4566, healthPath: "/health" },
  env: (endpoint) => ({ [ENDPOINT_VAR]: endpoint, FAKECLOUD_ACCESS_KEY: "test" }),
};
const plugins = [{ name: "fakecloud", emulator }];

const { runComponentsPrPlan } = await import("./pr");

let dir: string;
let hosts: string[];

const ctx = (env: string) =>
  ({
    args: { command: "components", path: "pr-plan", format: "", fix: false, watch: false, verbose: false, help: false, live: false, base: "main", env, output: dir, pr: 7 } as ParsedArgs,
    plugins,
  }) as never;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pr-endpoint-"));
  hosts = [];
  delete process.env[ENDPOINT_VAR];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    hosts.push(new URL(String(url)).host);
    return new Response("{}", { status: 200 });
  }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env[ENDPOINT_VAR];
  await rm(dir, { recursive: true, force: true });
});

describe("pr-plan against an environment that declares an endpoint (#4281)", () => {
  test("every plan request goes to the declared endpoint and no other host, and the var is restored after", async () => {
    expect(await runComponentsPrPlan(ctx("floci"))).toBe(0);
    expect(hosts.length).toBe(2);
    expect(new Set(hosts)).toEqual(new Set(["localhost:4566"]));
    expect(process.env[ENDPOINT_VAR]).toBeUndefined();
  });

  test("an environment with no endpoint is left to the capability's own default", async () => {
    expect(await runComponentsPrPlan(ctx("prod"))).toBe(0);
    expect(new Set(hosts)).toEqual(new Set([new URL(REAL_CLOUD).host]));
  });

  test("an ambient var already set wins over the declared endpoint", async () => {
    process.env[ENDPOINT_VAR] = "http://127.0.0.1:9999";
    expect(await runComponentsPrPlan(ctx("floci"))).toBe(0);
    expect(new Set(hosts)).toEqual(new Set(["127.0.0.1:9999"]));
    expect(process.env[ENDPOINT_VAR]).toBe("http://127.0.0.1:9999");
  });
});
