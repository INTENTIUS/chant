import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendPendingGate, readGateLedger } from "../../lifecycle/gate-ledger";
import { resetGateOrigin } from "../../lifecycle/gate-origin";

const started = vi.fn();
const resolveGate = vi.fn();

vi.mock("../../op/discover", () => ({
  discoverOps: async () => ({
    errors: [],
    ops: new Map([
      ["tf-apply", { config: { name: "tf-apply", overview: "apply", phases: [], neverOverMcp: true } }],
      ["plain-op", { config: { name: "plain-op", overview: "plain", phases: [] } }],
    ]),
  }),
}));

vi.mock("../../op/runtimes/local", () => ({
  createLocalOpRuntime: () => ({
    name: "local",
    start: async (config: { name: string }) => {
      started(config.name);
      return { result: async () => ({ op: config.name, runId: "r1", state: "succeeded", startedAt: "t" }) };
    },
    status: async () => undefined,
    list: async () => new Map(),
    resolveGate,
  }),
}));

import { recordGateApproval } from "../handlers/operator";
import { createOpApproveTool, createOpRunTool, createOpStatusTool, createOpReportTool } from "./op-tools";

function git(args: string[], cwd: string): void {
  spawnSync("git", args, { cwd, encoding: "utf-8" });
}

describe("neverOverMcp (chant#3447)", () => {
  const cwd = process.cwd();
  beforeEach(() => {
    started.mockClear();
    resolveGate.mockClear();
  });
  afterEach(() => {
    process.chdir(cwd);
    resetGateOrigin();
  });

  test("op-approve refuses a CI-reached gate of a declared Op and the ledger is unchanged", async () => {
    await withTestDir(async (dir) => {
      git(["init", "-q", "-b", "main"], dir);
      git(["config", "user.email", "t@chant.dev"], dir);
      git(["config", "user.name", "T"], dir);
      writeFileSync(join(dir, "README.md"), "x\n");
      git(["add", "."], dir);
      git(["commit", "-q", "-m", "init"], dir);

      // A gate reached on forge CI, not over MCP: the same-origin rule would let it through.
      await appendPendingGate(
        {
          op: "tf-apply",
          gate: "wave-2",
          timestamp: "2026-01-01T00:00:00.000Z",
          origin: "cli",
          expiresAt: "2999-01-01T00:00:00.000Z",
          planDigest: `sha256:${"a".repeat(64)}`,
        },
        { cwd: dir },
      );
      const before = await readGateLedger("tf-apply", { cwd: dir });
      expect(before.pending).toHaveLength(1);

      process.chdir(dir);
      await expect(createOpApproveTool().handler({ name: "tf-apply", gate: "wave-2" })).rejects.toThrow(
        /neverOverMcp.*whichever channel/s,
      );

      expect(await readGateLedger("tf-apply", { cwd: dir })).toEqual(before);
      expect(resolveGate).not.toHaveBeenCalled();
    });
  });

  test("op-run refuses a declared Op and starts nothing", async () => {
    await expect(createOpRunTool().handler({ name: "tf-apply" })).rejects.toThrow(/neverOverMcp.*chant run tf-apply/s);
    expect(started).not.toHaveBeenCalled();
  });

  test("an Op that does not declare it still runs", async () => {
    const result = (await createOpRunTool().handler({ name: "plain-op" })) as { state: string };
    expect(result.state).toBe("succeeded");
    expect(started).toHaveBeenCalledWith("plain-op");
  });

  test("op-status and op-report still answer for a declared Op", async () => {
    await expect(createOpStatusTool().handler({ name: "tf-apply" })).resolves.toMatchObject({ op: "tf-apply" });
    await expect(createOpReportTool().handler({ name: "tf-apply" })).resolves.toContain("# tf-apply");
  });

  // chant#3555: op-approve hands the runtime the env it was given, as `chant
  // run approve --env` does, and nothing when it was given none.
  async function repoWithPlainGate(dir: string): Promise<void> {
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "t@chant.dev"], dir);
    git(["config", "user.name", "T"], dir);
    writeFileSync(join(dir, "README.md"), "x\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "init"], dir);
    await appendPendingGate(
      {
        op: "plain-op",
        gate: "release",
        timestamp: "2026-01-01T00:00:00.000Z",
        origin: "cli",
        expiresAt: "2999-01-01T00:00:00.000Z",
        planDigest: `sha256:${"d".repeat(64)}`,
      },
      { cwd: dir },
    );
  }

  test("op-approve passes env to the runtime's resolveGate (chant#3555)", async () => {
    await withTestDir(async (dir) => {
      await repoWithPlainGate(dir);
      process.chdir(dir);
      const result = (await createOpApproveTool().handler({ name: "plain-op", gate: "release", env: "prod" })) as {
        runtimeNotified: boolean;
      };
      expect(result.runtimeNotified).toBe(true);
      expect(resolveGate).toHaveBeenCalledWith("plain-op", "release", expect.objectContaining({ gate: "release" }), {
        env: "prod",
      });
    });
  });

  test("op-approve with no env leaves the runtime to keep the gated run's (chant#3555)", async () => {
    await withTestDir(async (dir) => {
      await repoWithPlainGate(dir);
      process.chdir(dir);
      await createOpApproveTool().handler({ name: "plain-op", gate: "release" });
      expect(resolveGate).toHaveBeenCalledTimes(1);
      expect(resolveGate.mock.calls[0]).toHaveLength(3);
    });
  });

  async function repoWithFanOutGate(dir: string): Promise<void> {
    git(["init", "-q", "-b", "main"], dir);
    git(["config", "user.email", "t@chant.dev"], dir);
    git(["config", "user.name", "T"], dir);
    writeFileSync(join(dir, "README.md"), "x\n");
    git(["add", "."], dir);
    git(["commit", "-q", "-m", "init"], dir);
    // fan-out is not discovered, and its gate was reached at a shell.
    await appendPendingGate(
      {
        op: "fan-out",
        gate: "wave-2",
        timestamp: "2026-01-01T00:00:00.000Z",
        origin: "cli",
        expiresAt: "2999-01-01T00:00:00.000Z",
        planDigest: `sha256:${"b".repeat(64)}`,
      },
      { cwd: dir },
    );
  }

  test("an undiscovered Op's gate carries the declaration (chant#3485)", async () => {
    await withTestDir(async (dir) => {
      await repoWithFanOutGate(dir);
      const { pending } = await readGateLedger("fan-out", { cwd: dir });
      expect(pending[0].neverOverMcp).toBe(true);
    });
  });

  test("op-approve refuses an undiscovered Op's gate and the ledger is unchanged (chant#3485)", async () => {
    await withTestDir(async (dir) => {
      await repoWithFanOutGate(dir);
      const before = await readGateLedger("fan-out", { cwd: dir });
      process.chdir(dir);
      await expect(createOpApproveTool().handler({ name: "fan-out", gate: "wave-2" })).rejects.toThrow(
        /neverOverMcp.*whichever channel/s,
      );
      expect(await readGateLedger("fan-out", { cwd: dir })).toEqual(before);
      expect(resolveGate).not.toHaveBeenCalled();
    });
  });

  test("ACP refuses the same gate, even with the same-origin override (chant#3485)", async () => {
    await withTestDir(async (dir) => {
      await repoWithFanOutGate(dir);
      const before = await readGateLedger("fan-out", { cwd: dir });
      process.chdir(dir);
      const outcome = await recordGateApproval("fan-out", "wave-2", {
        origin: "acp",
        actor: "agent",
        allowSameOrigin: true,
        cwd: dir,
      });
      expect(outcome.ok).toBe(false);
      expect(await readGateLedger("fan-out", { cwd: dir })).toEqual(before);
    });
  });

  test("a person at a shell can still approve the gate (chant#3485)", async () => {
    await withTestDir(async (dir) => {
      await repoWithFanOutGate(dir);
      process.chdir(dir);
      const outcome = await recordGateApproval("fan-out", "wave-2", { origin: "cli", actor: "alex", cwd: dir });
      expect(outcome.ok).toBe(true);
    });
  });

  // chant#3513: workspace-upgrade and the pull-request gate are undiscovered too.
  const gateOnlyOps: Array<{ op: string; gate: string }> = [
    { op: "workspace-upgrade", gate: "." },
    { op: "pr-12", gate: "pr-apply" },
  ];

  for (const { op, gate } of gateOnlyOps) {
    async function repoWithGate(dir: string): Promise<void> {
      git(["init", "-q", "-b", "main"], dir);
      git(["config", "user.email", "t@chant.dev"], dir);
      git(["config", "user.name", "T"], dir);
      writeFileSync(join(dir, "README.md"), "x\n");
      git(["add", "."], dir);
      git(["commit", "-q", "-m", "init"], dir);
      await appendPendingGate(
        {
          op,
          gate,
          timestamp: "2026-01-01T00:00:00.000Z",
          origin: "cli",
          expiresAt: "2999-01-01T00:00:00.000Z",
          planDigest: `sha256:${"c".repeat(64)}`,
        },
        { cwd: dir },
      );
    }

    test(`${op}: the gate record carries neverOverMcp (chant#3513)`, async () => {
      await withTestDir(async (dir) => {
        await repoWithGate(dir);
        const { pending } = await readGateLedger(op, { cwd: dir });
        expect(pending[0].neverOverMcp).toBe(true);
      });
    });

    test(`${op}: op-approve over MCP is refused and the ledger is unchanged (chant#3513)`, async () => {
      await withTestDir(async (dir) => {
        await repoWithGate(dir);
        const before = await readGateLedger(op, { cwd: dir });
        process.chdir(dir);
        await expect(createOpApproveTool().handler({ name: op, gate })).rejects.toThrow(
          /neverOverMcp.*whichever channel/s,
        );
        expect(await readGateLedger(op, { cwd: dir })).toEqual(before);
        expect(resolveGate).not.toHaveBeenCalled();
      });
    });

    test(`${op}: ACP is refused even with the same-origin override (chant#3513)`, async () => {
      await withTestDir(async (dir) => {
        await repoWithGate(dir);
        const before = await readGateLedger(op, { cwd: dir });
        process.chdir(dir);
        const outcome = await recordGateApproval(op, gate, {
          origin: "acp",
          actor: "agent",
          allowSameOrigin: true,
          cwd: dir,
        });
        expect(outcome.ok).toBe(false);
        expect(await readGateLedger(op, { cwd: dir })).toEqual(before);
      });
    });

    test(`${op}: a person at a shell can still approve (chant#3513)`, async () => {
      await withTestDir(async (dir) => {
        await repoWithGate(dir);
        process.chdir(dir);
        const outcome = await recordGateApproval(op, gate, { origin: "cli", actor: "alex", cwd: dir });
        expect(outcome.ok).toBe(true);
      });
    });
  }
});
