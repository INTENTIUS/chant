/**
 * The approve hint carries the pending fact's digest (#5407): the printed line
 * approves the fact it was printed for, under chant's words and a product's.
 * Against a temp repo; nothing is pushed.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendPendingGate, latestPendingGate, readGateLedger } from "../../lifecycle/gate-ledger";
import { resetGateOrigin } from "../../lifecycle/gate-origin";
import { approveCommand } from "../../op/gate";
import { resolveProductWords, setActiveProductWords } from "../../ci-product-words";

vi.mock("../../op/discover", () => ({ discoverOps: async () => ({ errors: [], ops: new Map() }) }));

const { recordGateApproval } = await import("./approve");

const DOC = `jcs1-sha256:${"d".repeat(64)}`;

function git(args: string[], cwd: string): void {
  spawnSync("git", args, { cwd, encoding: "utf-8" });
}

async function repoWithPendingGate(dir: string): Promise<void> {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@chant.dev"], dir);
  git(["config", "user.name", "T"], dir);
  writeFileSync(join(dir, "README.md"), "x\n");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "init"], dir);
  await appendPendingGate(
    { op: "api", gate: "prod-gate", timestamp: "2026-10-16T00:00:00.000Z", expiresAt: "2999-01-01T00:00:00.000Z", planDigest: DOC, environment: "prod" },
    { cwd: dir },
  );
}

/** The value after a flag in a printed line, as a person copying it would read it. */
const flagValue = (line: string, flag: string): string | undefined => {
  const words = line.split(" ");
  const at = words.indexOf(flag);
  return at < 0 ? undefined : words[at + 1];
};

describe("the approve hint names the pending fact's digest (#5407)", () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    resetGateOrigin();
    vi.restoreAllMocks();
  });

  test("chant's line approves the pending fact as printed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await withTestDir(async (dir) => {
      await repoWithPendingGate(dir);
      process.chdir(dir);
      const pending = latestPendingGate((await readGateLedger("api")).pending, "prod-gate")!;
      const printed = approveCommand(pending.op, pending.gate, pending.environment, pending.planDigest);
      expect(printed).toBe(`chant approve api prod-gate --env prod --plan ${DOC}`);
      const outcome = await recordGateApproval("api", "prod-gate", { origin: "cli", actor: "alice", cwd: dir, environment: flagValue(printed, "--env"), plan: flagValue(printed, "--plan") });
      expect(outcome.ok).toBe(true);
      const { resolutions } = await readGateLedger("api", { cwd: dir });
      expect(resolutions).toEqual([expect.objectContaining({ resolvedBy: "alice", planDigest: DOC, environment: "prod" })]);
    });
  });

  test("a product's words put the digest after --plan", async () => {
    setActiveProductWords(resolveProductWords({ product: "plywood" }));
    let printed: string;
    try {
      printed = approveCommand("api", "prod-gate", "prod", DOC);
    } finally {
      setActiveProductWords(undefined);
    }
    expect(printed).toBe(`plywood approve api prod-gate --plan ${DOC}`);
    expect(printed).toContain(`--plan ${DOC}`);
    expect(printed).not.toMatch(/--plan\s*$/);
  });
});
