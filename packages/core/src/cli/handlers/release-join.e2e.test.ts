/**
 * A commit, a release, a release gate and a deploy record join through the
 * release digest (#4043). Everything runs in a temp repo with no remote, so
 * nothing is pushed: a green tag, a real cut, a real `components promote
 * --release` that stops at its gate, a real `chant approve`, and the promote
 * that follows. Only the capability registry is replaced, so no deploy step
 * reaches a cloud.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityRegistry, type DeployContext } from "../../components/capability";
import type { DriverComponent } from "../../components/driver";
import type { ParsedArgs } from "../registry";
import { appendReleaseRecord, readReleaseLedger } from "../../lifecycle/release-ledger";
import { readGateLedger } from "../../lifecycle/gate-ledger";
import { cutRelease } from "../../lifecycle/release-cut";
import { joinRelease, type ReleaseJoinStart } from "../../lifecycle/release-join";
import { resetGateOrigin } from "../../lifecycle/gate-origin";
import type { ReleaseArtifact } from "../../lifecycle/release-store";
import type { CompiledTarget, TargetCompiler } from "../../components/release-compile";

const DIGEST = `sha256:${"a".repeat(64)}`;

const api: DriverComponent = {
  name: "api",
  deploy: [
    { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:api.tar" }] },
    { phase: "Apply", steps: [{ kind: "gate", gate: "prod-release" }, { kind: "apply", template: "dist/api.template.json", imageRef: "@Publish.digest" }] },
  ],
};

vi.mock("../../config", async () => {
  const actual = await vi.importActual<typeof import("../../config")>("../../config");
  return { ...actual, loadChantConfig: async () => ({ config: {} }) };
});
vi.mock("../../components/cli-support", () => ({
  isComponentList: () => false,
  resolveComponentTargets: async () => ({ success: true, targets: [api] }),
}));
vi.mock("../../components/fan-out-support", () => ({
  fanOutRegistry: async () => {
    const registry = new CapabilityRegistry();
    registry.register({ kind: "publish-image", async run(_ctx: DeployContext) { return { digest: DIGEST, uri: `reg/api@${DIGEST}` }; } } as never);
    registry.register({ kind: "apply", async run() { return {}; } } as never);
    return registry;
  },
}));
vi.mock("../../op/discover", () => ({ discoverOps: async () => ({ errors: [], ops: new Map() }) }));
vi.mock("./run", () => ({ GATED_EXIT_CODE: 3 }));

const { runComponentsPromote, runComponentsRedeploy } = await import("./promote");
const { recordGateApproval } = await import("./approve");

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A compiler that compiles each environment to its own template and builds one image. */
const compiler: TargetCompiler = {
  async compile(env): Promise<CompiledTarget> {
    return {
      env,
      params: [],
      components: ["api"],
      buildSteps: { api: [{ kind: "docker-build", context: "api", into: "api.tar" }] },
      buildInputs: { api: ["api"] },
      componentFiles: { api: "api.component.ts" },
      templates: [{ component: "api", path: "dist/api.template.json", content: `{"env":"${env}"}\n` }],
    };
  },
  async buildArtifacts(_env, components): Promise<ReleaseArtifact[]> {
    return components.map((c) => ({ component: c, kind: "image" as const, path: `${c}.tar`, digest: DIGEST }));
  },
};

function args(overrides: Partial<ParsedArgs>): ParsedArgs {
  return {
    command: "components", path: "promote", format: "", fix: false, watch: false, verbose: false, help: false, live: false,
    migrateFrom: "staging", migrateTo: "prod", actor: "bob", runId: "run-9", ...overrides,
  } as ParsedArgs;
}
const ctx = (a: Partial<ParsedArgs>) => ({ args: args(a), plugins: [] }) as never;

describe("commit, release, gate and deploy record join through the release digest (#4043)", () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    resetGateOrigin();
    vi.restoreAllMocks();
  });

  test(
    "a cut, a gated promote, an approval and a redeploy join from the commit, the release, the gate and the deploy",
    async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      await withTestDir(async (dir) => {
        git(dir, "init", "-q", "-b", "main");
        git(dir, "config", "user.email", "t@chant.dev");
        git(dir, "config", "user.name", "T");
        writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev", "staging", "prod"] };\n`);
        writeFileSync(join(dir, "api.component.ts"), "export const api = {};\n");
        git(dir, "add", ".");
        git(dir, "commit", "-q", "-m", "init");
        const sha = git(dir, "rev-parse", "HEAD");
        git(dir, "tag", `ci/green/${sha}`, sha);
        process.chdir(dir);

        // The release is cut from the green commit.
        const cut = await cutRelease({ cwd: dir, compiler, label: "v1.0.0", actor: "alice", env: {}, now: () => new Date("2026-10-16T10:00:00.000Z") });
        const releaseDigest = cut.release.releaseDigest;

        // Staging is what prod promotes from. It is a plain deploy of the same commit.
        await appendReleaseRecord(
          { component: "api", env: "staging", digest: DIGEST, gitSha: sha, runId: "run-1", timestamp: "2026-10-16T10:30:00.000Z", actor: "ci" },
          { cwd: dir },
        );

        // The promote stops at the release gate and leaves a pending fact for the release.
        expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(3);
        const afterStop = await readGateLedger("release", { cwd: dir });
        expect(afterStop.pending).toEqual([expect.objectContaining({ gate: "prod-release", environment: "prod", releaseDigest })]);
        expect((await readReleaseLedger("prod", { cwd: dir })).records).toEqual([]);

        // A person approves it, and the promote then deploys.
        const approved = await recordGateApproval("release", "prod-release", { origin: "cli", actor: "alice", cwd: dir, environment: "prod" });
        expect(approved.ok).toBe(true);
        expect(await runComponentsPromote(ctx({ release: "v1.0.0" }))).toBe(0);
        const [deploy] = (await readReleaseLedger("prod", { cwd: dir })).records;
        expect(deploy).toMatchObject({ env: "prod", component: "api", releaseDigest, approver: "alice", admission: { op: "release", gate: "prod-release" } });

        // A redeploy puts the same deploy back; it stops at the component's own gate first.
        const redeployArgs = { path: "redeploy", component: "api", migrateTo: undefined, migrateFrom: undefined, extraPositional: "prod", runId: "run-10" };
        const stopped = await runComponentsRedeploy(ctx(redeployArgs));
        expect(stopped).toBe(3);
        const gateOp = (await readGateLedger("api", { cwd: dir })).pending.at(-1)!;
        expect((await recordGateApproval(gateOp.op, gateOp.gate, { origin: "cli", actor: "alice", cwd: dir, environment: "prod" })).ok).toBe(true);
        expect(await runComponentsRedeploy(ctx(redeployArgs))).toBe(0);
        const prodRecords = (await readReleaseLedger("prod", { cwd: dir })).records;
        expect(prodRecords).toHaveLength(2);
        expect(prodRecords[1]).toMatchObject({ releaseDigest, redeploys: { env: "prod", runId: deploy.runId } });

        // From each starting point the same release, gate and deploys come back.
        const resolution = (await readGateLedger("release", { cwd: dir })).resolutions[0];
        const pending = (await readGateLedger("release", { cwd: dir })).pending[0];
        const starts: Array<[string, ReleaseJoinStart]> = [
          ["commit", { commit: sha }],
          ["commit prefix", { commit: sha.slice(0, 10) }],
          ["release label", { release: "v1.0.0" }],
          ["release digest", { release: releaseDigest }],
          ["deploy record", { deploy: deploy }],
          ["gate resolution", { gate: resolution }],
          ["pending fact", { gate: pending }],
          ["deploy record without releaseDigest, by its admission", { deploy: { admission: deploy.admission } }],
        ];
        for (const [name, from] of starts) {
          const joined = await joinRelease(from, { cwd: dir });
          expect(joined.releases, name).toHaveLength(1);
          const [one] = joined.releases;
          expect(one.releaseDigest, name).toBe(releaseDigest);
          expect(one.commit, name).toBe(sha);
          expect(one.label, name).toBe("v1.0.0");
          expect(one.gates.resolutions.map((r) => [r.gate, r.resolvedBy, r.environment]), name).toEqual([["prod-release", "alice", "prod"]]);
          expect(one.gates.pending.map((p) => p.planDigest), name).toEqual([resolution.planDigest]);
          expect(one.deploys.map((d) => [d.env, d.runId]), name).toEqual([["prod", deploy.runId], ["prod", "run-10"]]);
          // The deploy names the gate's resolution by address, and the join finds that very resolution.
          expect(one.deploys[0].admission).toMatchObject({ op: "release", gate: one.gates.resolutions[0].gate, resolvedAt: one.gates.resolutions[0].timestamp });
        }

        // An unknown commit and a deploy that came from no release join to nothing, with a reason.
        expect(await joinRelease({ commit: "f".repeat(40) }, { cwd: dir })).toMatchObject({ releases: [], reason: expect.stringMatching(/no release was cut/) });
        expect(await joinRelease({ deploy: { releaseDigest: undefined } }, { cwd: dir })).toMatchObject({ releases: [], reason: expect.stringMatching(/not made from one/) });
        expect(await joinRelease({ commit: "abc" }, { cwd: dir })).toMatchObject({ releases: [], reason: expect.stringMatching(/at least 7/) });
      });
    },
    240_000,
  );
});
