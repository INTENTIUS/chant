/**
 * `chant approve --env <env> [--plan <digest>]` (#5480): the approval goes to
 * the one gate waiting in the environment, and records nothing when none or
 * several wait. Against a temp repo; nothing is pushed.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendPendingGate, readGateLedger } from "../../lifecycle/gate-ledger";
import { resetGateOrigin } from "../../lifecycle/gate-origin";
import type { ParsedArgs } from "../registry";

vi.mock("../../op/discover", () => ({ discoverOps: async () => ({ errors: [], ops: new Map() }) }));

const { runApprove } = await import("./approve");

const WAVE = `jcs1-sha256:${"a".repeat(64)}`;
const STAGE = `jcs1-sha256:${"b".repeat(64)}`;
const NONE = `jcs1-sha256:${"0".repeat(64)}`;
const FAR = "2999-01-01T00:00:00.000Z";

function git(args: string[], cwd: string): void {
  spawnSync("git", args, { cwd, encoding: "utf-8" });
}

/** A repo whose ledger has a prod wave waiting on WAVE and a prod component gate waiting on STAGE, and a staging wave. */
async function repo(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@chant.dev"], dir);
  git(["config", "user.name", "T"], dir);
  writeFileSync(join(dir, "README.md"), "x\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
  await appendPendingGate({ op: "waves", gate: "waves-wave-2", timestamp: "2026-11-22T10:00:00.000Z", expiresAt: FAR, planDigest: WAVE, wave: { number: 2, name: "prod", op: "waves", environment: "prod" } }, { cwd: dir });
  await appendPendingGate({ op: "api", gate: "deploy-ok", timestamp: "2026-11-22T11:00:00.000Z", expiresAt: FAR, planDigest: STAGE, environment: "prod" }, { cwd: dir });
}

const args = (extra: Partial<ParsedArgs>) =>
  ({ command: "approve", path: ".", format: "", fix: false, watch: false, verbose: false, help: false, live: false, yes: true, actor: "github:erin", allowSameOrigin: true, ...extra }) as ParsedArgs;

describe("chant approve --env (#5480)", () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    resetGateOrigin();
    vi.restoreAllMocks();
  });

  test("a --plan approves the gate in the environment that waits on it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await withTestDir(async (dir) => {
      await repo(dir);
      process.chdir(dir);
      expect(await runApprove({ args: args({ env: "prod", plan: WAVE }), plugins: [], serializers: [] } as never)).toBe(0);
      const waves = await readGateLedger("waves");
      expect(waves.resolutions).toEqual([expect.objectContaining({ gate: "waves-wave-2", planDigest: WAVE })]);
      expect((await readGateLedger("api")).resolutions).toEqual([]);
    });
  });

  test("two waiting and no --plan, or a digest nothing waits on, record nothing", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((t: string) => void errors.push(String(t)));
    await withTestDir(async (dir) => {
      await repo(dir);
      process.chdir(dir);
      expect(await runApprove({ args: args({ env: "prod" }), plugins: [], serializers: [] } as never)).toBe(1);
      expect(errors.join("\n")).toContain("2 approvals wait in prod");
      expect(await runApprove({ args: args({ env: "prod", plan: NONE }), plugins: [], serializers: [] } as never)).toBe(1);
      expect(errors.join("\n")).toContain(`chant approve api deploy-ok --plan ${STAGE} --env prod`);
      expect((await readGateLedger("waves")).resolutions).toEqual([]);
      expect((await readGateLedger("api")).resolutions).toEqual([]);
    });
  });
});
