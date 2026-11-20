/**
 * `chant components promote` into a stage with `onVerifyFail: "rollback"`
 * (#5328), run for real in a temp repo with no remote: the pipeline is read
 * at HEAD, and the stage ledger, the gate ledger and the release ledger are
 * the repo's own `chant/lifecycle`. Only the capability registry and the
 * release store's reads are replaced, so no step reaches a cloud.
 *
 * A failed verify step writes the request, records the pending fact of gate
 * `prod-rollback` and exits 3. A failed apply is no failed verify: the stage
 * holds as it always did, and nothing is requested.
 */

import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityRegistry, type DeployContext } from "../../components/capability";
import type { DriverComponent } from "../../components/driver";
import type { ParsedArgs } from "../registry";
import { appendReleaseRecord } from "../../lifecycle/release-ledger";
import { readGateLedger } from "../../lifecycle/gate-ledger";
import { resetGateOrigin } from "../../lifecycle/gate-origin";
import { gitStageLedgerPort } from "../../pipeline/stage-ledger";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OLD = `sha256:${"b".repeat(64)}`;
const V1 = `sha256:${"1".repeat(64)}`;
/** Which step fails on the next promote. */
const failing = { kind: "http-check" };

const api: DriverComponent = {
  name: "api",
  deploy: [
    { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:api.tar" }] },
    { phase: "Apply", steps: [{ kind: "apply", template: "dist/api.template.json", imageRef: "@Publish.digest" }] },
    { phase: "Verify", steps: [{ kind: "http-check", url: "https://example.test/healthz" }] },
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
    const step = (kind: string, out: unknown) => ({
      kind,
      rollbackPolicy: kind === "http-check" ? "none-by-design" : "needs-opt-out",
      async run(_ctx: DeployContext) {
        if (failing.kind === kind) throw new Error(`${kind} failed: 503`);
        return out;
      },
    });
    registry.register(step("publish-image", { digest: DIGEST, uri: `reg/api@${DIGEST}` }) as never);
    registry.register(step("apply", {}) as never);
    registry.register(step("http-check", {}) as never);
    return registry;
  },
}));
vi.mock("../../lifecycle/release-store", async () => {
  const actual = await vi.importActual<typeof import("../../lifecycle/release-store")>("../../lifecycle/release-store");
  return { ...actual, readRelease: async (digest: string) => (digest === V1 ? { releaseDigest: V1, commit: "c".repeat(40), artifactDigests: [], targets: [] } : null), readCuts: async () => ({ cuts: [{ releaseDigest: V1, label: "v1" }], malformed: 0 }) };
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
  name: "shop",
  stages: [
    { name: "staging", waves: [{ name: "staging", runs: [{ target: "api" }] }] },
    { name: "prod", waves: [{ name: "prod", runs: [{ target: "api" }] }], gate: { policy: "never" }, onVerifyFail: "rollback" },
  ],
});
`;

const ctx = (runId: string) =>
  ({
    args: { command: "components", path: "promote", format: "", fix: false, watch: false, verbose: false, help: false, live: false, migrateTo: "prod", actor: "bob", runId } as ParsedArgs,
    plugins: [],
  }) as never;

describe("a promote into a stage that rolls back on a failed verify", () => {
  const cwd = process.cwd();
  let dir: string;

  beforeAll(async () => {
    dir = await createTestDir("chant-verify-rollback");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.email", "t@chant.dev");
    git(dir, "config", "user.name", "T");
    writeFileSync(join(dir, "chant.config.ts"), "export default {};\n");
    mkdirSync(join(dir, ".chant"), { recursive: true });
    writeFileSync(join(dir, ".chant", "pipeline.ts"), PIPELINE);
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    const sha = git(dir, "rev-parse", "HEAD");
    process.chdir(dir);
    // prod ran release v1; staging holds the artifact the promote takes.
    await appendReleaseRecord({ component: "api", env: "prod", digest: OLD, gitSha: sha, runId: "run-1", timestamp: "2026-11-19T10:00:00.000Z", actor: "ci", releaseDigest: V1 }, { cwd: dir });
    await appendReleaseRecord({ component: "api", env: "staging", digest: DIGEST, gitSha: sha, runId: "run-2", timestamp: "2026-11-20T10:00:00.000Z", actor: "ci" }, { cwd: dir });
  }, 60_000);

  afterAll(() => {
    process.chdir(cwd);
    resetGateOrigin();
  });

  test("a failed apply holds as before and requests nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    failing.kind = "apply";
    expect(await runComponentsPromote(ctx("run-3"))).toBe(1);
    expect(await gitStageLedgerPort({ cwd: dir }).read("shop", "prod")).toEqual([]);
    expect((await readGateLedger("shop", { cwd: dir })).pending).toEqual([]);
  });

  test("a failed verify step writes the request, records the gate's pending fact and exits 3", async () => {
    const said: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void said.push(a.map(String).join(" ")));
    failing.kind = "http-check";
    expect(await runComponentsPromote(ctx("run-4"))).toBe(3);
    const lines = await gitStageLedgerPort({ cwd: dir }).read("shop", "prod");
    expect(lines.map((l) => l.kind)).toEqual(["failed", "rollback-requested"]);
    // The apply ran and its capability does not undo it, so the member is left applied.
    expect(lines[0]).toMatchObject({ failure: "verify", members: [{ member: "api", state: "left-applied" }], detail: [expect.stringContaining("Verify/http-check")] });
    expect(lines[1]).toMatchObject({ failureId: lines[0]!.id, release: { digest: V1, label: "v1" }, gate: "prod-rollback", members: [{ member: "api", state: "left-applied", rollback: "requested" }] });
    const pending = (await readGateLedger("shop", { cwd: dir })).pending;
    expect(pending).toEqual([expect.objectContaining({ op: "shop", gate: "prod-rollback", environment: "prod", planDigest: V1, releaseDigest: V1 })]);
    expect(said.join("\n")).toContain("chant components rollback prod --requested");
  });
});
