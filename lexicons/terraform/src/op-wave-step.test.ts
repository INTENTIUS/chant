/**
 * The terraform side of op waves through capabilities (#4545): lock
 * timeouts, choudoufu cone plans, reads from another root's state and the
 * cost hold preset, moved here from terragucci's wave callbacks.
 */
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_LOCK_TIMEOUT, isLockTimeout, lockTimeoutArgs } from "./lock-timeout";
import { coneArgs, conePlanDigest, coneRecordPath, coneText, readPlanCone } from "./cone";
import { atmosStateReads, fillStateReads, readOutputValue, stateReadsProblems, waitingReadsReason } from "./state-reads";
import { INFRACOST_ARGV, terraformCostHold } from "./cost-hold";
import { terraformApplyCommand, terraformPlanCommand } from "./op/activities/terraform";

describe("lock timeout (#4545)", () => {
  test("adds -lock-timeout unless the job sets one", () => {
    expect(lockTimeoutArgs("plan", DEFAULT_LOCK_TIMEOUT, {})).toEqual(["-lock-timeout=5m"]);
    expect(lockTimeoutArgs("apply", "30s", { TF_CLI_ARGS: "-no-color" })).toEqual(["-lock-timeout=30s"]);
    expect(lockTimeoutArgs("plan", "5m", { TF_CLI_ARGS_plan: "-lock-timeout=1m" })).toEqual([]);
    expect(lockTimeoutArgs("apply", "5m", { TF_CLI_ARGS: "--lock-timeout 2m" })).toEqual([]);
    expect(lockTimeoutArgs("plan", false, {})).toEqual([]);
    expect(() => lockTimeoutArgs("plan", "five", {})).toThrow(/not a duration/);
    expect(isLockTimeout("1h30m")).toBe(true);
  });

  test("the plan and apply commands carry the extra flags", () => {
    expect(terraformPlanCommand({ binary: "tofu", planFile: "chant.tfplan", extra: ["-cone=origin/main", "-lock-timeout=5m"] })).toBe(
      "tofu plan -input=false -detailed-exitcode -cone=origin/main -lock-timeout=5m -out=chant.tfplan",
    );
    expect(terraformApplyCommand({ binary: "tofu", planFile: "chant.tfplan", extra: ["-lock-timeout=5m"] })).toBe("tofu apply -input=false -lock-timeout=5m chant.tfplan");
    expect(terraformApplyCommand({ binary: "tofu", planFile: "chant.tfplan" })).toBe("tofu apply -input=false chant.tfplan");
  });
});

describe("cone plans (#4545)", () => {
  test("only choudoufu on a live root, and never beside -target or -destroy", () => {
    expect(coneArgs("choudoufu", "origin/main", [], true)).toEqual(["-cone=origin/main"]);
    expect(coneArgs("/usr/local/bin/choudoufu", "origin/main", [], true)).toEqual(["-cone=origin/main"]);
    expect(coneArgs("tofu", "origin/main", [], true)).toEqual([]);
    expect(coneArgs("choudoufu", "origin/main", [], false)).toEqual([]);
    expect(coneArgs("choudoufu", "origin/main", ["-target"], true)).toEqual([]);
    expect(coneArgs("choudoufu", undefined, [], true)).toEqual([]);
  });

  test("reads the record beside the plan, or the guard's fallback", () => {
    const dir = mkdtempSync(join(tmpdir(), "cone-"));
    const plan = join(dir, "chant.tfplan");
    writeFileSync(coneRecordPath(plan), JSON.stringify({ base: "origin/main", base_sha: "abc", targets: ["b.x", "a.y"] }));
    const cone = readPlanCone("Warning: Cone plan\n\nThis plan covers the cone: 2 of the estate's 40 blocks\n\nPlan: 1 to add", plan, "origin/main");
    expect(cone).toEqual({ base: "origin/main", blocks: 2, of: 40, record: { base: "origin/main", base_sha: "abc", targets: ["a.y", "b.x"] } });
    expect(coneText(cone)).toBe("the cone of the change since origin/main, 2 of the estate's 40 blocks");
    const fell = readPlanCone("Warning: Cone plan fell back to a full plan\n\nThis plan covers the whole estate (guard lockfile): the lock file changed.\n", plan, "origin/main");
    expect(fell).toEqual({ base: "origin/main", fallback: { kind: "lockfile", reason: "the lock file changed" } });
    rmSync(dir, { recursive: true, force: true });
  });

  test("the cone's targets join the digest; a full plan keeps its own", () => {
    const d = `sha256:${"1".repeat(64)}`;
    expect(conePlanDigest(d, undefined)).toBe(d);
    expect(conePlanDigest(d, { base: "origin/main", fallback: { kind: "x", reason: "y" } })).toBe(d);
    const a = conePlanDigest(d, { base: "origin/main", record: { base: "origin/main", base_sha: "", targets: ["a"] } });
    const b = conePlanDigest(d, { base: "origin/main", record: { base: "origin/main", base_sha: "", targets: ["b"] } });
    expect(a).not.toBe(d);
    expect(a).not.toBe(b);
  });
});

describe("reads from another root's state (#4545)", () => {
  test("fills each read once per upstream, and waits on a missing output", async () => {
    let reads = 0;
    const filled = await fillStateReads(
      [
        { var: "vpc_id", root: "network", output: ["vpc", "id"] },
        { var: "subnets", root: "network", output: ["subnets"] },
        { var: "db", root: "data", output: ["endpoint"] },
      ],
      async (root) => {
        reads++;
        return root === "network" ? { vpc: { id: "vpc-1" }, subnets: ["a", "b"] } : {};
      },
    );
    expect(reads).toBe(2);
    expect(filled.vars).toEqual({ vpc_id: "vpc-1", subnets: ["a", "b"] });
    expect(filled.waiting.map((w) => w.why)).toEqual(["has no state yet"]);
    expect(waitingReadsReason(filled.waiting)).toBe("not planned: it reads db from data, which has no state yet; apply data first");
  });

  test("a state that cannot be read is an error, not a wait", async () => {
    const filled = await fillStateReads([{ var: "x", root: "up", output: ["x"] }], async () => {
      throw new Error("init failed");
    });
    expect(filled.errors).toEqual(["it reads x from up, whose state could not be read: init failed"]);
  });

  test("checks the reads, reads a nested output, and maps Atmos edges", () => {
    expect(stateReadsProblems([{ var: "a", root: "r", output: ["o"] }, { var: "a", root: "", output: [] }])).toHaveLength(3);
    expect(readOutputValue({ o: { k: 1 } }, ["o", "k"])).toEqual({ value: 1 });
    expect(readOutputValue({ o: { k: 1 } }, ["o", "j"])).toBeUndefined();
    expect(atmosStateReads({ reads: [{ var: "v", upstream: "dev/vpc", output: ["id"], function: "!terraform.state vpc id" }] }, (u) => u.replace("/", "-"))).toEqual([{ var: "v", root: "dev-vpc", output: ["id"] }]);
  });
});

describe("cost hold preset (#4545)", () => {
  test("prices each root's plan document with infracost", () => {
    expect(terraformCostHold({ approveAbove: 100 })).toEqual({ command: [...INFRACOST_ARGV], approveAbove: 100, format: "infracost" });
    expect(() => terraformCostHold({ approveAbove: 1, command: ["infracost"] })).toThrow(/\{planJson\}/);
  });
});
