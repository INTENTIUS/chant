/**
 * #5261: the cut's `check` hook, which runs `release.check`: after the stamp
 * and the build, before anything is recorded, in a dry run too.
 */

import { afterAll, describe, expect, test } from "vitest";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { cutRelease, planRelease, ReleaseCutError, type CutRequest } from "./release-cut";
import { ChantConfigSchema } from "../config";
import type { ReleasePublish } from "./release-store";
import type { TargetCompiler } from "../components/release-compile";
import { TestRepo } from "../workspace/trust/test-repo";

const repos: TestRepo[] = [];
afterAll(() => {
  for (const r of repos) rmSync(dirname(r.dir), { recursive: true, force: true });
});

const noCompile: TargetCompiler = {
  async compile(env) {
    throw new Error(`compiled ${env}`);
  },
  async buildArtifacts() {
    throw new Error("built");
  },
};

const NPM: ReleasePublish = { target: "npm:0123456789abcdef", kind: "npm", destination: "registry.npmjs.org" };

function project(): { r: TestRepo; head: string } {
  const r = new TestRepo("release-check");
  repos.push(r);
  r.write("package.json", JSON.stringify({ name: "acme-cli", version: "0.0.0", private: true }, null, 2));
  r.write("chant.config.ts", `export default { release: { publish: [{ type: "npm", packages: ["."] }] } };\n`);
  return { r, head: r.commit("init") };
}

function request(r: TestRepo, calls: string[], check: CutRequest["check"]): CutRequest {
  return {
    cwd: r.dir,
    compiler: noCompile,
    label: "1.0.0",
    actor: "alice",
    env: {},
    green: "none",
    publishes: [NPM],
    stamp: () => void calls.push("stamp"),
    build: () => void calls.push("build"),
    check,
  };
}

const noLedger = (r: TestRepo) => spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/chant/lifecycle"], { cwd: r.dir }).status !== 0;

describe("release.check (#5261)", () => {
  test("the config takes release.check as shell lines", () => {
    expect(ChantConfigSchema.safeParse({ release: { check: ["npm test"] } }).success).toBe(true);
    expect(ChantConfigSchema.safeParse({ release: { check: [""] } }).success).toBe(false);
  });

  test("runs after the stamp and the build, with the commit, in the dry run and the cut", async () => {
    const { r, head } = project();
    const calls: string[] = [];
    const check = (commit: string) => void calls.push(`check ${commit}`);
    await planRelease(request(r, calls, check));
    expect(calls).toEqual(["stamp", "build", `check ${head}`]);
    calls.length = 0;
    const result = await cutRelease(request(r, calls, check));
    expect(calls).toEqual(["stamp", "build", `check ${head}`]);
    expect(result.cut).not.toBeNull();
  });

  test("a refusal from the check stops the cut with nothing recorded", async () => {
    const { r } = project();
    const calls: string[] = [];
    const err = await cutRelease(
      request(r, calls, () => {
        throw new ReleaseCutError("release-check-failed", "no release was cut: release.check failed (exit 1): false");
      }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseCutError);
    expect((err as ReleaseCutError).code).toBe("release-check-failed");
    expect(noLedger(r)).toBe(true);
  });
});
