/**
 * #4155: a pull request's approval binds the files a step without a `plan`
 * deploys from. A chart changed after approval, or a function's sources
 * beside a planning step, moves the digest and pr-apply exits 3. A build
 * whose output differs every time does not.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  resolveChangedUnits: async () => ({ units: { changed: [ESTATE[0]!.name], indeterminate: [] } }),
}));

vi.mock("../../lifecycle/gate-change-set", () => ({
  storeGateChangeSet: async () => ({ written: false }),
  readGraphIds: async () => ({ ids: [] }),
  setGraphIdReader: () => {},
  gateGraphReader: () => async () => ({ ids: [] }),
}));
vi.mock("../../lifecycle/git", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/git")>("../../lifecycle/git");
  return { ...actual, pushLifecycleReport: async () => { throw new Error("pr-deploy-inputs.test must not push chant/lifecycle"); } };
});

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

/** The components under test; each case sets its own. */
let ESTATE: DriverComponent[] = [];

vi.mock("../../components/fan-out-support", async () => {
  const { CapabilityRegistry } = await import("../../components/capability");
  const { planFanOut } = await import("../../components/fan-out");
  const { computePlanDigest } = await import("../../lifecycle/plan-digest");
  const registry = new CapabilityRegistry();
  // A planning step, as cfn-deploy is.
  registry.register({
    kind: "fake-root",
    async plan(_ctx: DeployContext, input: { root: string }) {
      const planDigest = computePlanDigest("fake-root", { root: input.root });
      return {
        member: input.root,
        planDigest,
        artifact: { planDigest },
        changeSet: { member: { member: input.root, lexicon: "aws", planner: "cfn", status: "planned", planDigest, holes: [] }, entries: [] },
      };
    },
    async run() {
      return { outputs: {} };
    },
  } as never);
  // Steps with no plan, under the kinds whose fields name what they deploy.
  for (const kind of ["helm-upgrade", "lambda-deploy", "shell"]) {
    registry.register({ kind, async run() { return { outputs: {} }; } } as never);
  }
  // A build that is not reproducible: a new uri every run.
  registry.register({ kind: "zip-package", async run() { return { outputs: { uri: `s3://bundles/${Math.random()}` } }; } } as never);
  return {
    fanOutRegistry: async () => registry,
    deriveFanOut: async () => ({
      success: true,
      components: ESTATE,
      plan: planFanOut({ components: ESTATE, changed: [ESTATE[0]!.name] }),
      signal: { changed: [ESTATE[0]!.name], indeterminate: [], unclaimed: [] },
    }),
  };
});

const { memoryGateLedgerPort } = await import("../../op/gate");
const { runComponentsPrApply, runComponentsPrPlan } = await import("./pr");

let dir: string;
let project: string;

const ctx = (a: Partial<ParsedArgs>) =>
  ({ args: { command: "components", path: "pr-apply", format: "", fix: false, watch: false, verbose: false, help: false, live: false, base: "main", env: "prod", output: dir, ...a } as ParsedArgs, plugins: [] }) as never;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pr-inputs-out-"));
  project = await mkdtemp(join(tmpdir(), "pr-inputs-project-"));
  gateLedger = memoryGateLedgerPort();
  // The steps read their paths from the member's directory, which is the working directory.
  vi.spyOn(process, "cwd").mockReturnValue(project);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

/** Plan pull request 12 and approve the digest it printed, as a reviewer would. */
async function planAndApprove(): Promise<string> {
  expect(await runComponentsPrPlan(ctx({ pr: 12 }))).toBe(0);
  const digest = JSON.parse(await readFile(join(dir, "pr-plan.json"), "utf8")).digest as string;
  gateLedger = memoryGateLedgerPort({
    resolutions: [{ version: 1, kind: "resolution", op: "pr-12", gate: "pr-apply", resolvedBy: "github:alice", timestamp: new Date().toISOString(), planDigest: digest }],
  });
  return digest;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(project, path, ".."), { recursive: true });
  await writeFile(join(project, path), content);
}

describe("a Helm chart changed after approval (#4155)", () => {
  beforeEach(async () => {
    ESTATE = [{ name: "web", dependsOn: [], deploy: [{ phase: "Deploy", steps: [{ kind: "helm-upgrade", release: "web", chart: "chart", values: ["values-prod.yaml"] }] }] }];
    await write("chart/Chart.yaml", "name: web\nversion: 1.0.0\n");
    await write("chart/templates/deployment.yaml", "replicas: 2\n");
    await write("values-prod.yaml", "image: web\n");
  });

  test("applies under the approval when nothing changed", async () => {
    await planAndApprove();
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(0);
  });

  test("a file in the chart changed: pr-apply exits 3 and applies nothing", async () => {
    await planAndApprove();
    await write("chart/templates/deployment.yaml", "replicas: 20\n");
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(3);
    const report = JSON.parse(await readFile(join(dir, "pr-apply.json"), "utf8"));
    expect(report.status).not.toBe("applied");
  });

  test("a file added to the chart, or a changed values file, does the same", async () => {
    await planAndApprove();
    await write("chart/templates/service.yaml", "port: 80\n");
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(3);
    await planAndApprove();
    await write("values-prod.yaml", "image: other\n");
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(3);
  });
});

describe("a function's sources beside a planning step (#4155)", () => {
  beforeEach(async () => {
    ESTATE = [{
      name: "api",
      dependsOn: [],
      deploy: [
        { phase: "Build", steps: [{ kind: "zip-package", source: "fn" }] },
        { phase: "Deploy", steps: [{ kind: "fake-root", root: "api-stack" }, { kind: "lambda-deploy", functionName: "api", codeRef: "@Build.uri", version: "1" }] },
      ],
    }];
    await write("fn/index.js", "export const handler = () => 1;\n");
    await write("fn/package-lock.json", "{}\n");
  });

  test("the plan has a member for the component's other steps", async () => {
    await planAndApprove();
    const plan = JSON.parse(await readFile(join(dir, "pr-plan.json"), "utf8"));
    expect(JSON.stringify(plan)).toContain("api#inputs");
  });

  test("a changed source moves the digest: pr-apply exits 3", async () => {
    await planAndApprove();
    await write("fn/index.js", "export const handler = () => 2;\n");
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(3);
  });

  test("an unchanged rebuild whose output differs every run still applies under the approval", async () => {
    await planAndApprove();
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(0);
  });
});

describe("a step chant can't bind (#4155)", () => {
  test("is a hole on the plan, named unbound, and the plan still applies once approved", async () => {
    ESTATE = [{ name: "ops", dependsOn: [], deploy: [{ phase: "Deploy", steps: [{ kind: "shell", cmd: "./deploy.sh", reason: "t" }] }] }];
    await planAndApprove();
    const plan = JSON.parse(await readFile(join(dir, "pr-plan.json"), "utf8"));
    expect(JSON.stringify(plan)).toMatch(/unbound: a shell step runs content chant can't name/);
    expect(await runComponentsPrApply(ctx({ pr: 12 }))).toBe(0);
  });
});
