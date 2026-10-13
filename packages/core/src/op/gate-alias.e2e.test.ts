/**
 * #3949 against a real `chant/lifecycle` branch: an approval recorded under
 * a per-tier Op's gate passes the merged Op's gate that lists it as an
 * alias. The run reads the old Op's ledger file, writes the carried line to
 * its own, and the next run passes on that line alone.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, git, repo } from "../workspace/__fixtures__/contract-repo";
import { appendGateResolution, appendPendingGate, readGateLedger } from "../lifecycle/gate-ledger";
import { runOpLocally } from "./local-executor";
import { gitGateLedgerPort } from "./gate";
import { stepOutput } from "./step-output-ref";
import type { ActivityFn } from "./activity-registry";
import type { OpConfig } from "./types";

const PLAN = `jcs1-sha256:${"a".repeat(64)}`;

let root: string;
beforeAll(() => {
  root = repo({ "chant.config.json": "{}\n" }, false);
  git(root, "config", "user.name", "Gate Test");
  git(root, "config", "user.email", "gate@example.com");
  commitAll(root, "c0");
});
afterAll(cleanScratch);

const applied: string[] = [];
const ACTIVITIES = new Map<string, ActivityFn>([
  ["plan", async () => ({ planDigest: PLAN })],
  ["apply", async (args) => (applied.push(String((args as { tier: string }).tier)), { ok: true })],
]);

const merged: OpConfig = {
  name: "upgrade",
  overview: "upgrade every tier, one wave each",
  phases: [
    { name: "Plan", steps: [{ kind: "activity", id: "plan", fn: "plan" }] },
    {
      name: "Wave 1",
      steps: [{ kind: "gate", gate: "approve-tier-1", plan: stepOutput("plan", "planDigest"), aliases: [{ op: "upgrade-tier-1", gate: "approve" }] }],
    },
    { name: "Apply 1", steps: [{ kind: "activity", fn: "apply", args: { tier: "1" } }] },
  ],
};

describe("a gate alias on a real ledger", () => {
  test("the merged Op passes on the old Op's approval, and keeps passing on the carried line", async () => {
    const now = Date.now();
    const iso = (s: number) => new Date(now + s * 1000).toISOString();
    await appendPendingGate(
      { op: "upgrade-tier-1", gate: "approve", timestamp: iso(-60), expiresAt: iso(3600), planDigest: PLAN, runId: "old-run" },
      { cwd: root },
    );
    await appendGateResolution({ op: "upgrade-tier-1", gate: "approve", resolvedBy: "alice", timestamp: iso(-30), planDigest: PLAN }, { cwd: root });

    const port = gitGateLedgerPort({ cwd: root });
    const first = await runOpLocally(merged, ACTIVITIES, {}, undefined, { cwd: root, gates: port, runId: "run-1" });
    expect(first.status).toBe("ok");
    expect(first.records.find((r) => r.fn === "gate:approve-tier-1")?.approval).toMatchObject({ resolvedBy: "alice", via: "alias" });

    const ledger = await readGateLedger("upgrade", { cwd: root });
    expect(ledger.resolutions).toHaveLength(1);
    expect(ledger.resolutions[0]).toMatchObject({
      op: "upgrade",
      gate: "approve-tier-1",
      resolvedBy: "alice",
      planDigest: PLAN,
      carriedFrom: { op: "upgrade-tier-1", gate: "approve", timestamp: iso(-30) },
    });

    const second = await runOpLocally(merged, ACTIVITIES, {}, undefined, { cwd: root, gates: port, runId: "run-2" });
    expect(second.status).toBe("ok");
    expect(second.records.find((r) => r.fn === "gate:approve-tier-1")?.approval?.via).toBeUndefined();
    expect((await readGateLedger("upgrade", { cwd: root })).resolutions).toHaveLength(1);
    expect(applied).toEqual(["1", "1"]);
  });
});
