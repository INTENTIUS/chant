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
});
