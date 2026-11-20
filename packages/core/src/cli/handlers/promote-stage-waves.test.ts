/**
 * `chant components promote` into a stage of a member with no components
 * (#5427), run for real in a temp repo with no remote: the pipeline is read
 * at HEAD, and the gate ledger, the run ledger and the release ledger are
 * the repo's own `chant/lifecycle`. The stages apply through a `sql-migrate`
 * step, which a fake engine stands in for: it applies only the plan an op
 * wave decided with `spec`, as the sql lexicon's does, and says which spec
 * file it was handed.
 *
 * A skipped stage and a stage gate nobody approved apply nothing. Once the
 * stage's gate is approved for the release, its op wave plans, decides and
 * applies, with the stage's rendered spec file as the step's `spec`, and the
 * release record names the release under the pipeline's component. A wave
 * whose own gate waits applies nothing until its plan is approved.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityRegistry, type DeployContext } from "../../components/capability";
import type { ParsedArgs } from "../registry";
import { appendReleaseRecord, readReleaseLedger } from "../../lifecycle/release-ledger";
import { appendGateResolution, readGateLedger } from "../../lifecycle/gate-ledger";
import { resetGateOrigin } from "../../lifecycle/gate-origin";

const V1 = `sha256:${"1".repeat(64)}`;
const DEV_PLAN = `sha256:${"d".repeat(64)}`;
/** The commit the release was cut from, set once the repo has it. */
const cut = { commit: "" };
/** What the fake engine applied: the environment and the spec file it was handed. */
const applied: Array<{ environment: string; spec: unknown }> = [];

const planDigestOf = (env: string) => `sha256:${Buffer.from(env).toString("hex").padEnd(64, "0").slice(0, 64)}`;

vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: async () => ({ config: {} }) };
});
vi.mock("../../components/cli-support", () => ({
  isComponentList: () => false,
  resolveComponentTargets: async () => ({ success: true, targets: [] }),
}));
vi.mock("../../components/fan-out-support", () => ({
  fanOutRegistry: async () => {
    const registry = new CapabilityRegistry();
    registry.register({
      kind: "sql-migrate",
      rollbackPolicy: "needs-opt-out",
      async plan(_ctx: DeployContext, input: { environment: string; spec?: string }) {
        const planDigest = planDigestOf(input.environment);
        return { member: input.environment, planDigest, artifact: { kind: "sql-migrate", environment: input.environment, planDigest, wavePlan: `.chant/sql/${input.environment}.wave-plan.json`, spec: input.spec } };
      },
      async run(ctx: DeployContext, input: { environment: string; spec?: string }) {
        const decided = ctx.plans?.[input.environment] as { wavePlan?: string; spec?: string } | undefined;
        if (!decided?.wavePlan || !decided.spec) throw new Error(`sql-migrate: ${input.environment} applies only the plan an op wave decided, planned with spec`);
        applied.push({ environment: input.environment, spec: input.spec });
        return { environment: input.environment, summary: "Applied: 1" };
      },
    } as never);
    return registry;
  },
}));
vi.mock("../../lifecycle/release-store", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/release-store")>("../../lifecycle/release-store");
  const release = () => ({ version: 1, releaseDigest: V1, member: null, commit: cut.commit, artifactDigests: [], targets: [{ env: "dev", templates: [], params: [] }] });
  return {
    ...actual,
    resolveRelease: async (ref: string) => (ref === "v1" || ref === V1 ? { release: release(), label: "v1" } : null),
    readRelease: async (digest: string) => (digest === V1 ? release() : null),
    readCuts: async () => ({ cuts: [{ version: 1, releaseDigest: V1, label: "v1", actor: "ci", timestamp: "2026-11-20T10:00:00.000Z", runId: null, runOrigin: null }], malformed: 0 }),
  };
});
vi.mock("../../lifecycle/release-revocation", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/release-revocation")>("../../lifecycle/release-revocation");
  return { ...actual, readRevokedCommits: async () => new Map() };
});
vi.mock("../../op/discover", () => ({ discoverOps: async () => ({ errors: [], ops: new Map() }) }));
vi.mock("./run", () => ({ GATED_EXIT_CODE: 3 }));

const { runComponentsPromote } = await import("./promote");

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const PIPELINE = `import { pipeline } from "@intentius/chant/pipeline";

export default pipeline({
  name: "yodel-apply",
  defaults: { op: "yodel-apply", step: { kind: "sql-migrate", environment: "{target}", spec: "yodel-waves.json" } },
  stages: [
    { name: "dev", waves: [{ name: "dev", runs: [{ target: "dev" }] }], gate: { policy: "never" } },
    { name: "staging", waves: [{ name: "staging", runs: [{ target: "staging" }], gate: "never" }] },
    { name: "prod", waves: [{ name: "prod", runs: [{ target: "prod" }], gate: "always" }], gate: { policy: "never" } },
  ],
});
`;

const ctx = (to: string, runId: string, more: Partial<ParsedArgs> = {}) =>
  ({
    args: { command: "components", path: "promote", format: "", fix: false, watch: false, verbose: false, help: false, live: false, migrateTo: to, release: "v1", actor: "bob", runId, ...more } as ParsedArgs,
    plugins: [],
  }) as never;

describe("a promote by a stage's op waves, for a member with no components", () => {
  const cwd = process.cwd();
  let dir: string;
  let said: string[];

  beforeAll(async () => {
    dir = await createTestDir("chant-promote-stage-waves");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@chant.dev");
    git(dir, "config", "user.name", "T");
    writeFileSync(join(dir, "chant.config.ts"), "export default {};\n");
    mkdirSync(join(dir, ".chant"), { recursive: true });
    writeFileSync(join(dir, ".chant", "pipeline.ts"), PIPELINE);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    cut.commit = git(dir, "rev-parse", "HEAD");
    process.chdir(dir);
    // The merge applied dev at the commit v1 was cut from, before the cut: its record names the commit and no release.
    await appendReleaseRecord({ component: "yodel-apply", env: "dev", digest: DEV_PLAN, digestKind: "plan", gitSha: cut.commit, runId: "run-1", timestamp: "2026-11-20T09:00:00.000Z", actor: "ci" }, { cwd: dir });
  }, 60_000);

  afterAll(() => {
    process.chdir(cwd);
    resetGateOrigin();
  });

  const listen = () => {
    said = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void said.push(a.map(String).join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {});
  };

  test("skipping a stage is refused and applies nothing", async () => {
    listen();
    expect(await runComponentsPromote(ctx("prod", "run-2", { migrateFrom: "dev" }))).not.toBe(0);
    expect(said.join("\n")).toMatch(/skip/);
    expect(applied).toEqual([]);
  });

  test("without --release the promote is refused and applies nothing", async () => {
    listen();
    expect(await runComponentsPromote(ctx("staging", "run-3", { release: undefined }))).toBe(1);
    expect(said.join("\n")).toContain("needs --release");
    expect(applied).toEqual([]);
  });

  test("the stage's gate waits for an approval of the release, and nothing applies", async () => {
    listen();
    expect(await runComponentsPromote(ctx("staging", "run-4"))).toBe(3);
    expect(applied).toEqual([]);
    const pending = (await readGateLedger("yodel-apply", { cwd: dir })).pending;
    expect(pending).toEqual([expect.objectContaining({ gate: "staging", planDigest: V1, environment: "staging" })]);
    expect((await readReleaseLedger("staging", { cwd: dir })).records).toEqual([]);
  });

  test("once the stage's gate is approved, its op wave applies the decided plan with the stage's spec file", async () => {
    listen();
    await appendGateResolution({ op: "yodel-apply", gate: "staging", resolvedBy: "github:alice", timestamp: new Date().toISOString(), planDigest: V1, environment: "staging" }, { cwd: dir });
    expect(await runComponentsPromote(ctx("staging", "run-5"))).toBe(0);
    expect(applied).toEqual([{ environment: "staging", spec: ".chant/op-waves/yodel-apply-staging.spec.json" }]);
    const records = (await readReleaseLedger("staging", { cwd: dir })).records;
    expect(records).toEqual([expect.objectContaining({ component: "yodel-apply", env: "staging", releaseDigest: V1, digest: planDigestOf("staging"), digestKind: "plan" })]);
  });

  test("a wave whose own gate waits applies nothing until its plan is approved", async () => {
    listen();
    applied.length = 0;
    expect(await runComponentsPromote(ctx("prod", "run-6"))).toBe(3);
    expect(applied).toEqual([]);
    const pending = (await readGateLedger("yodel-apply-prod", { cwd: dir })).pending;
    expect(pending).toHaveLength(1);
    const wave = pending[0]!;
    expect(said.join("\n")).toContain("chant approve yodel-apply-prod");

    await appendGateResolution({ op: "yodel-apply-prod", gate: wave.gate, resolvedBy: "github:alice", timestamp: new Date().toISOString(), planDigest: wave.planDigest!, ...(wave.environment ? { environment: wave.environment } : {}) }, { cwd: dir });
    expect(await runComponentsPromote(ctx("prod", "run-7"))).toBe(0);
    expect(applied).toEqual([{ environment: "prod", spec: ".chant/op-waves/yodel-apply-prod.spec.json" }]);
    expect((await readReleaseLedger("prod", { cwd: dir })).records).toEqual([expect.objectContaining({ component: "yodel-apply", releaseDigest: V1 })]);
  });
});
