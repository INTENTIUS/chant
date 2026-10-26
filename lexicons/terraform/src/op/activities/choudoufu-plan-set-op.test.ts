/**
 * `choudoufuPlanSet` as an Op activity (#4483, H3 of #4477). One Op plans two
 * live choudoufu roots, one per cloud, and hands each root's `changeSet` to
 * `composeChangeSet`, the shape behold's three-cloud front door takes instead
 * of composing the change set in a script.
 *
 * The activity is the real one, resolved through `loadActivities`, so it runs
 * the configured binary. A fake `choudoufu` on `PATH` answers `version` and
 * prints a one-root set plan document for `live-plan-set`, exiting 2 as
 * choudoufu does for a plan with changes. Nothing reaches a cloud.
 */

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { composeChangeSet, loadActivities, runOpLocally, validateActivitySteps, validateStepOutputRefs, type ActivityProfile, type OpConfig } from "@intentius/chant/op";
import { choudoufuPlanSet } from "../builders";
import * as contracts from "../activity-contracts";
import { __resetChoudoufuVersionCheckForTests } from "./terraform";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => __resetChoudoufuVersionCheckForTests());
afterEach(() => vi.unstubAllEnvs());

const PROFILES: Record<string, ActivityProfile> = {
  longInfra: { timeout: "5m", retry: { maximumAttempts: 1 } },
  fastIdempotent: { timeout: "5m", retry: { maximumAttempts: 1 } },
};

/** A fake choudoufu: `version`, and `live-plan-set -json -out-dir=<d> <root>` printing a one-root document. */
const FAKE = `#!/bin/sh
if [ "$1" = "version" ]; then echo "choudoufu v0.31.0 (based on OpenTofu v1.13.0)"; exit 0; fi
if [ "$1" = "live-plan-set" ]; then
  for a in "$@"; do root="$a"; done
  name=$(basename "$root")
  cat <<EOF
{"format_version":"1","roots":[{"root":"$root","estate":"$name","status":"planned","error":"","changes":true,"plan":{"format_version":"1.2","resource_changes":[{"address":"null_resource.$name","mode":"managed","type":"null_resource","name":"$name","change":{"actions":["create"],"before":null,"after":{}}}]},"digest":"sha256:root-$name"}],"summary":{"roots":1,"planned":1,"changed":1,"failed":0},"digest":"sha256:set-$name","exit_code":2}
EOF
  exit 2
fi
echo "fake choudoufu: unexpected $*" >&2
exit 1
`;

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "chant-plan-set-op-")));
  scratch.push(dir);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "choudoufu"), FAKE);
  chmodSync(join(bin, "choudoufu"), 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  for (const root of ["aws", "azure"]) {
    mkdirSync(join(dir, "estates", root), { recursive: true });
    writeFileSync(join(dir, "estates", root, "main.tf"), "");
  }
  writeFileSync(
    join(dir, "chant.config.json"),
    JSON.stringify({ lexicons: ["terraform"], terraform: { binary: "choudoufu", roots: { aws: { dir: "estates/aws" }, azure: { dir: "estates/azure" } } } }),
  );
  return dir;
}

function frontDoor(cwd: string): OpConfig {
  const aws = choudoufuPlanSet("aws", { cwd, id: "aws" });
  const azure = choudoufuPlanSet("azure", { cwd, id: "azure" });
  return {
    name: "front-door-plan",
    overview: "",
    phases: [
      { name: "Plan", steps: [aws, azure] },
      { name: "Compose", steps: [composeChangeSet({ parts: [aws.out.changeSet, azure.out.changeSet], id: "doc" })] },
    ],
  };
}

describe("choudoufuPlanSet as an Op activity (#4483)", () => {
  test("is resolved from the terraform lexicon's activities", async () => {
    const activities = await loadActivities(["terraform"]);
    expect(typeof activities.get("choudoufuPlanSet")).toBe("function");
  });

  test("its contract validates the steps and the changeSet references", () => {
    const map = new Map(Object.values(contracts).map((c) => [c.name, c]));
    const config = frontDoor("/tmp/x");
    expect(validateActivitySteps(config, map)).toEqual([]);
    expect(validateStepOutputRefs(config, map)).toEqual([]);
  });

  test("an Op plans two clouds' roots and composes one change set from their parts", async () => {
    const dir = project();
    const activities = await loadActivities(["terraform"]);
    const compose = activities.get("composeChangeSet")!;
    const documents: Array<{ document: { members?: Array<{ member: string }> }; digest: string }> = [];
    activities.set("composeChangeSet", async (args, signal) => {
      const out = (await compose(args, signal)) as (typeof documents)[number];
      documents.push(out);
      return out;
    });
    const result = await runOpLocally(frontDoor(dir), activities, PROFILES);
    expect(result.status).toBe("ok");
    expect(result.records.filter((r) => r.fn === "choudoufuPlanSet").map((r) => r.status)).toEqual(["ok", "ok"]);
    expect(documents).toHaveLength(1);
    expect(documents[0]!.digest).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
    expect((documents[0]!.document.members ?? []).map((m) => m.member).sort()).toEqual(["aws", "azure"]);
  });
});
