/**
 * #3760: the override gate's lines on chant/lifecycle. A denial is an
 * ordinary pending fact on `_gates/policy-override.jsonl`, and applied
 * records sit beside it where no gate reader lists them.
 */
import { describe, expect, test } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendGateResolution, readGateLedger } from "./gate-ledger";
import { readOverrideLedger, recordOverrideDenial, recordOverridesApplied } from "./override-ledger";
import { appliedOverride, decideOverride, overrideDigest, OVERRIDE_OP } from "../override-gate";
import { readBlobFromPath } from "./git";

function initRepo(dir: string): void {
  const git = (args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "test@chant.dev"]);
  git(["config", "user.name", "Test"]);
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(["add", "README.md"]);
  git(["commit", "-q", "-m", "init"]);
}

const PLAN = `sha256:${"a".repeat(64)}`;

describe("lifecycle/override-ledger", () => {
  test("a denial, its override and the applied record round-trip, and the override is spent", async () => {
    await withTestDir(async (dir) => {
      initRepo(dir);
      const opts = { cwd: dir };
      const { record: denial } = await recordOverrideDenial(
        { subject: "prod", planDigest: PLAN, rules: ["no-drop"], timestamp: "2026-10-11T10:00:00.000Z", expiresAt: "2026-10-13T00:00:00.000Z" },
        opts,
      );
      expect(denial).toMatchObject({ op: OVERRIDE_OP, gate: "prod", plan: PLAN, rules: ["no-drop"], planDigest: overrideDigest("prod", PLAN, ["no-drop"]), neverOverMcp: true });
      await appendGateResolution(
        { op: OVERRIDE_OP, gate: "prod", resolvedBy: "github:alice", timestamp: "2026-10-11T11:00:00.000Z", planDigest: denial.planDigest, note: "the column is unused since 0.6" },
        opts,
      );

      const ledger = await readOverrideLedger(opts);
      const input = { ledger, applied: ledger.applied, subject: "prod", planDigest: PLAN, rules: ["no-drop"], overriders: ["github:alice"], now: "2026-10-11T12:00:00.000Z" };
      const decided = decideOverride(input);
      expect(decided.status).toBe("overridden");
      if (decided.status !== "overridden") return;

      await recordOverridesApplied([appliedOverride(decided.override, { timestamp: "2026-10-11T12:00:00.000Z" })], opts);
      await recordOverridesApplied([], opts);
      const after = await readOverrideLedger(opts);
      expect(after.applied).toHaveLength(1);
      expect(decideOverride({ ...input, ledger: after, applied: after.applied }).status).toBe("none");

      // The gate ledger reads the denial and the override, and nothing in the applied file.
      const gates = await readGateLedger(OVERRIDE_OP, opts);
      expect(gates).toMatchObject({ malformed: 0 });
      expect(gates.pending).toHaveLength(1);
      expect(gates.resolutions).toHaveLength(1);
      expect(await readBlobFromPath(`_gates/${OVERRIDE_OP}`, "applied.jsonl", opts)).toContain('"kind":"applied"');
    });
  });
});
