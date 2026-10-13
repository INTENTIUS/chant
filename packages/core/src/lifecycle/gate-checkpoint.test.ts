/**
 * #3947 on a real `chant/lifecycle` branch: the checkpoint lands at
 * `_gates/<op>/checkpoints/<runId>.json` beside the gate ledger, the ledger's
 * readers don't see it, and a run resumes from it at the checkout's own HEAD.
 */

import { describe, expect, test } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkpointOutputs,
  gateCheckpointDigest,
  isCheckpointRunId,
  parseGateCheckpoint,
  readGateCheckpointText,
  writeGateCheckpoint,
  type GateCheckpoint,
} from "./gate-checkpoint";
import { appendGateResolution, readGateLedger } from "./gate-ledger";
import { runOpLocally } from "../op/local-executor";
import { gitGateLedgerPort } from "../op/gate";
import { stepOutput } from "../op/step-output-ref";
import type { ActivityFn } from "../op/activity-registry";
import type { OpConfig } from "../op/types";

function git(args: string[], cwd: string): string {
  return spawnSync("git", args, { cwd, encoding: "utf-8" }).stdout ?? "";
}

function initRepo(dir: string): void {
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "test@chant.dev"], dir);
  git(["config", "user.name", "Test"], dir);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"], dir);
  git(["commit", "-q", "-m", "init"], dir);
}

const checkpoint = (over: Partial<GateCheckpoint> = {}): GateCheckpoint => ({
  version: 1, op: "upgrade", gate: "approve", runId: "run-1", commit: "c".repeat(40), outputs: { snap: { id: "s-1" } }, ...over,
});

describe("gate checkpoint files", () => {
  test("the digest is over the JCS form, so key order and the file's layout don't move it", () => {
    const a = checkpoint({ outputs: { snap: { id: "s-1", b: 1 } } });
    const b = checkpoint({ outputs: { snap: { b: 1, id: "s-1" } } });
    expect(gateCheckpointDigest(a)).toBe(gateCheckpointDigest(b));
    expect(gateCheckpointDigest(a)).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
    expect(gateCheckpointDigest(checkpoint({ outputs: { snap: { id: "s-2" } } }))).not.toBe(gateCheckpointDigest(checkpoint()));
  });

  test("outputs are stored as JSON carries them, and one JSON can't hold is named", () => {
    const outputs = new Map<string, unknown>([["a", { at: new Date(0), skip: undefined }], ["b", 1n]]);
    expect(checkpointOutputs(outputs, ["a"])).toEqual({ outputs: { a: { at: "1970-01-01T00:00:00.000Z" } } });
    expect(checkpointOutputs(outputs, ["a", "b"])).toEqual({ unstorable: "b" });
  });

  test("a run id that can't be a file name gets no checkpoint", () => {
    expect(isCheckpointRunId("local-1760000000000")).toBe(true);
    expect(isCheckpointRunId("../escape")).toBe(false);
    expect(isCheckpointRunId(".hidden")).toBe(false);
  });

  test("a file that isn't a checkpoint reads as null", () => {
    expect(parseGateCheckpoint("{")).toBeNull();
    expect(parseGateCheckpoint(JSON.stringify({ ...checkpoint(), outputs: [] }))).toBeNull();
  });

  test("writes beside the gate ledger, which its readers don't see", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      await writeGateCheckpoint(checkpoint(), { cwd: dir });
      const text = await readGateCheckpointText("upgrade", "run-1", { cwd: dir });
      expect(parseGateCheckpoint(text!)).toEqual(checkpoint());
      expect(git(["ls-tree", "-r", "--name-only", "chant/lifecycle"], dir).trim()).toBe("_gates/upgrade/checkpoints/run-1.json");
      expect(await readGateLedger("upgrade", { cwd: dir })).toEqual({ resolutions: [], pending: [], malformed: 0 });
      expect(await readGateCheckpointText("upgrade", "run-2", { cwd: dir })).toBeNull();
    });
  });
});

describe("a resumed run on a real ledger", () => {
  test("stops, is approved with the checkpoint's digest, and resumes at the gate at the same HEAD", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      let snapshots = 0;
      const applied: unknown[] = [];
      const activities = new Map<string, ActivityFn>([
        ["snapshot", async () => ({ id: `snap-${++snapshots}` })],
        ["plan", async () => ({ planDigest: `jcs1-sha256:${"a".repeat(64)}` })],
        ["apply", async (args) => {
          applied.push(args.snapshot);
          return {};
        }],
      ]);
      const config: OpConfig = {
        name: "upgrade",
        overview: "upgrade",
        phases: [
          { name: "Prepare", steps: [{ kind: "activity", id: "snapshot", fn: "snapshot" }, { kind: "activity", id: "plan", fn: "plan" }] },
          { name: "Gate", steps: [{ kind: "gate", gate: "approve", plan: stepOutput("plan", "planDigest"), resume: true }] },
          { name: "Apply", steps: [{ kind: "activity", fn: "apply", args: { snapshot: stepOutput("snapshot", "id") } }] },
        ],
      };
      const options = (runId: string, now: string) => ({ gates: gitGateLedgerPort({ cwd: dir }), cwd: dir, runId, now });

      const first = await runOpLocally(config, activities, {}, undefined, options("run-1", "2026-10-12T12:00:00.000Z"));
      expect(first.status).toBe("gated");
      const digest = first.gate!.checkpointDigest!;
      const stored = parseGateCheckpoint((await readGateCheckpointText("upgrade", "run-1", { cwd: dir }))!)!;
      expect(stored.commit).toBe(git(["rev-parse", "HEAD"], dir).trim());
      expect(gateCheckpointDigest(stored)).toBe(digest);

      await appendGateResolution({
        op: "upgrade", gate: "approve", resolvedBy: "alex", timestamp: "2026-10-12T12:05:00.000Z",
        planDigest: first.gate!.planDigest!, checkpointDigest: digest,
      }, { cwd: dir });

      const second = await runOpLocally(config, activities, {}, undefined, options("run-2", "2026-10-12T12:10:00.000Z"));
      expect(second.status).toBe("ok");
      expect(second.resumed).toEqual({ gate: "approve", run: "run-1", checkpoint: digest });
      expect(snapshots).toBe(1);
      expect(applied).toEqual(["snap-1"]);
    });
  });
});
