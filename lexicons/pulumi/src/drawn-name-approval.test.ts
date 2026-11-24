/**
 * A pull request that creates a resource with a name the engine draws (#5563).
 *
 * `testdata/pulumi-preview/preview-create.json` is a recorded first preview:
 * its queues carry autonames (`events-3f45941`, `worker-0-84f29f5`) the
 * provider filled in, listed in each step's `__defaults`. Every preview draws
 * them again, so a preview of the same change taken later has other suffixes.
 *
 * The document digest is the one a reviewer approves and the one
 * `pr-apply` decides its gate on. These tests take it over two draws of the
 * same create, and then run `pr-plan` and `pr-apply --before-merge` with a
 * member whose plan draws new names each time it is asked. Git, the forge,
 * the change signal and the gate ledger are fakes, as in core's
 * pr-before-merge.test.ts; no pulumi binary runs.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { composeChangeSet } from "@intentius/chant/change-set";
import type { DriverComponent } from "@intentius/chant/components/driver";
import type { DeployContext } from "@intentius/chant/components/capability";
import type { ParsedArgs } from "@intentius/chant/cli/registry";
import { planCoveredBy } from "@intentius/chant/components/pr-run";
import { pulumiPreviewPart, type PulumiStep } from "./change-set";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

const created = JSON.parse(readFileSync(join(import.meta.dirname, "testdata", "pulumi-preview", "preview-create.json"), "utf-8")) as { steps: PulumiStep[] };

/** The recorded preview with every autoname drawn again, its suffix `draw` (seven hex characters). */
function drawn(draw: string): typeof created {
  const doc = JSON.parse(JSON.stringify(created)) as typeof created;
  for (const s of doc.steps) {
    const inputs = s.newState?.inputs as Record<string, unknown> | undefined;
    if (!inputs || !Array.isArray(inputs.__defaults)) continue;
    for (const key of inputs.__defaults as string[]) {
      const v = inputs[key];
      if (typeof v === "string" && /-[0-9a-f]{7}$/.test(v)) inputs[key] = v.replace(/[0-9a-f]{7}$/, draw);
    }
  }
  return doc;
}
const setOf = (preview: unknown) => composeChangeSet([pulumiPreviewPart({ member: "site", preview, stack: "floci" })]);
const EVENTS = "urn:pulumi:floci::corpus-aws-ts::aws:sqs/queue:Queue::events";

describe("the document digest of a create with a drawn name (#5563)", () => {
  test("two previews of one create give one document digest", () => {
    const first = setOf(created);
    const again = setOf(drawn("0123abc"));
    expect(JSON.stringify(drawn("0123abc"))).toContain("events-0123abc");
    expect(again.members[0]!.planDigest).toBe(first.members[0]!.planDigest);
    expect(again.digest).toBe(first.digest);
  });

  test("the drawn name is known only after apply, and the inputs the program set keep their values", () => {
    const events = setOf(created).entries.find((e) => e.address === EVENTS)!;
    expect(events.attributes.find((a) => a.path === "name")).toEqual({ path: "name", unknown: true });
    expect(events.attributes.find((a) => a.path === "messageRetentionSeconds")).toEqual({ path: "messageRetentionSeconds", after: 3600 });
    expect(JSON.stringify(setOf(created))).not.toContain("3f45941");
  });

  test("a create that differs in an input the reviewer saw still has another digest", () => {
    const other = drawn("0123abc");
    (other.steps.find((s) => s.urn === EVENTS)!.newState!.inputs as Record<string, unknown>).messageRetentionSeconds = 7200;
    expect(setOf(other).digest).not.toBe(setOf(created).digest);
    expect(planCoveredBy(setOf(created), setOf(other), "site")).toMatch(/different value/);
  });

  test("a replacement's drawn name is known only after apply too", () => {
    const replace = (suffix: string) => ({
      steps: [
        {
          op: "replace",
          urn: EVENTS,
          oldState: { type: "aws:sqs/queue:Queue", inputs: { name: "events-1111111", fifoQueue: false } },
          newState: { type: "aws:sqs/queue:Queue", inputs: { __defaults: ["name"], name: `events-${suffix}`, fifoQueue: true } },
          replaceReasons: ["fifoQueue"],
          diffReasons: ["fifoQueue", "name"],
        },
      ],
    });
    const first = setOf(replace("2222222"));
    expect(setOf(replace("3333333")).digest).toBe(first.digest);
    expect(first.entries[0]!.attributes.find((a) => a.path === "name")).toEqual({ path: "name", before: "events-1111111", unknown: true });
  });
});

// ── pr-plan, then pr-apply --before-merge, on a member that draws names ─────────

vi.mock("@intentius/chant/workspace/security", async (original) => ({
  ...(await original<typeof import("@intentius/chant/workspace/security")>()),
  securityGroupsAt: () => new Set<string>(),
}));
vi.mock("@intentius/chant/components/pr-hooks", async (original) => ({
  ...(await original<typeof import("@intentius/chant/components/pr-hooks")>()),
  prLoopHooksAt: (_cwd: string, base: string) => ({ hooks: {}, base }),
}));
vi.mock("@intentius/chant/workspace/ci-locks", () => ({ ciLocksAt: () => null }));
vi.mock("@intentius/chant/workspace/ci-workflow-at", () => ({ ciWorkflowAt: () => "apply-before-merge" }));
vi.mock("@intentius/chant/ref-gate-rules", async (original) => ({
  ...(await original<typeof import("@intentius/chant/ref-gate-rules")>()),
  refGateRulesAt: (_repo: string, opts: { ref: string }) => ({ ref: opts.ref, base: BASE, matched: false, status: null, checks: [], problems: [] }),
}));
vi.mock("@intentius/chant/components/pr-policy", async (original) => ({
  ...(await original<typeof import("@intentius/chant/components/pr-policy")>()),
  prLoopPolicyAt: (_cwd: string, base: string) => ({ base }),
  runPrPolicy: () => undefined,
}));
vi.mock("@intentius/chant/components/changed-files", () => ({
  resolveCommit: async () => HEAD,
  resolveMergeBase: async () => BASE,
}));
vi.mock("@intentius/chant/config", async () => {
  const actual = await vi.importActual<typeof import("@intentius/chant/config")>("@intentius/chant/config");
  return { ...actual, loadChantConfig: async () => ({ config: {} }) };
});
vi.mock("@intentius/chant/cli/handlers/fan-out", () => ({
  resolveChangedUnits: async () => ({ units: { changed: ["site"], indeterminate: [] } }),
}));
// pr-apply stores the change set its gate binds on chant/lifecycle and pushes it; never in this checkout.
vi.mock("@intentius/chant/lifecycle/gate-change-set", () => ({
  storeGateChangeSet: async () => ({ written: false }),
  readGraphIds: async () => ({ ids: [] }),
  setGraphIdReader: () => {},
  gateGraphReader: () => async () => ({ ids: [] }),
}));
vi.mock("@intentius/chant/lifecycle/git", async () => {
  const actual = await vi.importActual<typeof import("@intentius/chant/lifecycle/git")>("@intentius/chant/lifecycle/git");
  const refuse = async () => {
    throw new Error("this test must not push chant/lifecycle");
  };
  return { ...actual, pushLifecycleReport: refuse, pushLifecycleRebasing: refuse };
});
vi.mock("@intentius/chant/cli/handlers/run", () => ({
  GATED_EXIT_CODE: 3,
  autoReleaseRun: (id: string) => ({ runId: id, runOrigin: { forge: "local" } }),
  recordAutoReleasesForRun: async () => [],
}));
let gateLedger: ReturnType<typeof import("@intentius/chant/op/gate").memoryGateLedgerPort>;
vi.mock("@intentius/chant/op/gate", async () => {
  const actual = await vi.importActual<typeof import("@intentius/chant/op/gate")>("@intentius/chant/op/gate");
  return { ...actual, gitGateLedgerPort: () => gateLedger, gateIsSealed: async () => false };
});

/** Each plan draws the names again, as a preview does. */
const draws = ["0123abc", "4567def", "89abcde"];
let previews = 0;
let applied: string[] = [];
vi.mock("@intentius/chant/components/fan-out-support", async () => {
  const { CapabilityRegistry } = await import("@intentius/chant/components/capability");
  const { planFanOut } = await import("@intentius/chant/components/fan-out");
  const registry = new CapabilityRegistry();
  registry.register({
    kind: "drawing-preview",
    async plan(_ctx: DeployContext, input: { member: string }) {
      const part = pulumiPreviewPart({ member: input.member, preview: drawn(draws[previews++ % draws.length]!), stack: "floci" });
      return { member: input.member, planDigest: part.member.planDigest!, artifact: { planDigest: part.member.planDigest }, changeSet: part };
    },
    async outputs() {
      return {};
    },
    async run(_ctx: DeployContext, input: { member: string }) {
      applied.push(input.member);
      return { outputs: {} };
    },
  } as never);
  return {
    fanOutRegistry: async () => registry,
    deriveFanOut: async () => ({
      success: true,
      components: ESTATE,
      plan: planFanOut({ components: ESTATE, changed: ["site"] }),
      signal: { changed: ["site"], indeterminate: [], unclaimed: [] },
    }),
  };
});

const ESTATE: DriverComponent[] = [{ name: "site", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "drawing-preview", member: "site" }] }] }];

const { memoryGateLedgerPort } = await import("@intentius/chant/op/gate");
const { runComponentsPrApply, runComponentsPrPlan } = await import("@intentius/chant/cli/handlers/pr");

let dir: string;
const ctx = (a: Partial<ParsedArgs>) =>
  ({ args: { command: "components", path: "pr-apply", format: "", fix: false, watch: false, verbose: false, help: false, live: false, base: "main", env: "prod", output: dir, pr: 12, forge: "github", beforeMerge: true, ...a } as ParsedArgs, plugins: [] }) as never;

/** Pull request 12 on a fake GitHub: open, approved on the forge, mergeable, up to date, its checks passed. */
function serveGithub(): void {
  const ok = (value: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
  vi.stubEnv("GITHUB_REPOSITORY", "acme/infra");
  vi.stubEnv("GITHUB_TOKEN", "t0k");
  vi.stubEnv("GITHUB_API_URL", "https://api.github.test");
  vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");
  vi.stubEnv("GITHUB_BASE_REF", "main");
  vi.stubGlobal("fetch", async (url: string, init: { method: string }) => {
    const { pathname } = new URL(url);
    if (init.method !== "GET") return ok({ id: 1 });
    const pull = "/repos/acme/infra/pulls/12";
    if (pathname === pull) return ok({ number: 12, state: "open", user: { login: "carol" }, head: { ref: "f", sha: HEAD }, base: { ref: "main" }, mergeable: true, mergeable_state: "clean" });
    if (pathname === `${pull}/reviews`) return ok([{ user: { login: "bob" }, state: "APPROVED", commit_id: HEAD }]);
    if (pathname === `${pull}/commits`) return ok([{ author: { login: "carol" }, committer: { login: "carol" } }]);
    if (pathname === `/repos/acme/infra/compare/main...${HEAD}`) return ok({ behind_by: 0 });
    if (pathname === `/repos/acme/infra/commits/${HEAD}/status`) return ok({ statuses: [{ context: "chant/plan", state: "success" }] });
    if (pathname === `/repos/acme/infra/commits/${HEAD}/check-runs`) return ok({ check_runs: [] });
    return ok([]);
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pulumi-drawn-name-"));
  previews = 0;
  applied = [];
  gateLedger = memoryGateLedgerPort();
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

describe("pr-apply --before-merge of a pull request that creates an auto-named resource (#5563)", () => {
  test("applies under the approval of its first preview, though the update drew other names", async () => {
    serveGithub();
    expect(await runComponentsPrPlan(ctx({ beforeMerge: false, forge: undefined, noStatus: true }))).toBe(0);
    const digest = JSON.parse(await readFile(join(dir, "pr-plan.json"), "utf8")).digest as string;
    gateLedger = memoryGateLedgerPort({
      resolutions: [{ version: 1, kind: "resolution", op: "pr-12", gate: "pr-apply", resolvedBy: "github:bob", timestamp: new Date().toISOString(), planDigest: digest }],
    });
    expect(await runComponentsPrApply(ctx({}))).toBe(0);
    expect(previews).toBe(2);
    expect(applied).toEqual(["site"]);
    const report = JSON.parse(await readFile(join(dir, "pr-apply.json"), "utf8")) as Record<string, unknown>;
    expect(report).toMatchObject({ status: "applied", digest, approval: { status: "approved", approvedBy: ["github:bob"] } });
  });
});
