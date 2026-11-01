/**
 * #4692: a release cut from a lane's green tag. A cut given a lane that
 * `ci.green.lanes` declares checks `ci/green-<lane>/<sha>` and
 * `ci/revoked-<lane>/<sha>` in place of the full green tags, and the cut
 * line names the lane. `release candidates --lane` reads the same tags.
 */

import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cutRelease, planRelease, ReleaseCutError } from "./release-cut";
import { readCuts, type ReleaseArtifact } from "./release-store";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { releasesDocument } from "../workspace/releases";
import { releaseCandidatesDocument } from "../workspace/release-candidates";
import { contract, declaration } from "../workspace/__fixtures__/contract-repo";
import releasesSchema from "../workspace/releases.schema.json";
import candidatesSchema from "../workspace/release-candidates.schema.json";

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const GREEN = {
  branch: "main",
  phases: { lint: ["lint"], test: ["test"], windows: ["windows"] },
  require: ["lint", "test", "windows"],
  lanes: { server: { require: ["lint", "test"] } },
};

/** A workspace whose root member is a chant project with two environments, on main, with `ci.green` as given. */
function workspace(dir: string, green: unknown = GREEN): string {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@chant.dev");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "chant.workspace.json"), declaration([{ name: "root", dir: ".", kind: "other", because: "the release fixture" }], green ? { ci: { green } } : {}));
  writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev", "prod"] };\n`);
  mkdirSync(join(dir, "api"), { recursive: true });
  writeFileSync(join(dir, "api", "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(dir, "api.component.ts"), "export const api = {};\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  return git(dir, "rev-parse", "HEAD");
}

function compiler(): TargetCompiler {
  return {
    async compile(env): Promise<CompiledTarget> {
      return {
        env,
        params: [],
        components: ["api"],
        buildSteps: { api: [{ kind: "docker-build", context: "api", into: "api.tar" }] },
        buildInputs: { api: ["api"] },
        componentFiles: { api: "api.component.ts" },
        templates: [{ component: "api", path: "dist/api.json", content: `{"env":"${env}"}\n` }],
      };
    },
    async buildArtifacts(_env, components): Promise<ReleaseArtifact[]> {
      return components.map((c) => ({ component: c, kind: "image" as const, path: `${c}.tar`, digest: `sha256:${"b".repeat(64)}` }));
    },
  };
}

const NOW = () => new Date("2026-11-01T10:00:00.000Z");
const cut = (dir: string, lane?: string, label: string | null = "v1.0.0") =>
  cutRelease({ cwd: dir, compiler: compiler(), label, actor: "alice", env: {}, now: NOW, ...(lane !== undefined ? { lane } : {}) });
const refusal = async (p: Promise<unknown>): Promise<ReleaseCutError> => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReleaseCutError);
  return err as ReleaseCutError;
};

describe("a cut from a lane (#4692)", () => {
  test("a commit green only in its lane is cut with --lane, and the cut line and releases document name the lane", async () => {
    await withTestDir(async (dir) => {
      const sha = workspace(dir);
      git(dir, "tag", `ci/green-server/${sha}`, sha);

      const without = await refusal(cut(dir));
      expect(without.code).toBe("release-commit-not-green");
      expect(without.message).toContain("has no ci/green tag");

      const plan = await planRelease({ cwd: dir, compiler: compiler(), label: "v1.0.0", actor: "alice", env: {}, lane: "server" });
      expect(plan.lane).toBe("server");

      const result = await cut(dir, "server");
      expect(result.cut?.lane).toBe("server");
      const { cuts } = await readCuts({ cwd: dir });
      expect(cuts.map((c) => c.lane)).toEqual(["server"]);

      const doc = await releasesDocument({ cwd: dir });
      if ("error" in doc) throw new Error(doc.error.message);
      expect(doc.releases[0].cuts[0].lane).toBe("server");
      contract(releasesSchema).expectValid(doc);
    });
  });

  test("a cut without a lane writes no lane, and a full green commit is cut as before", async () => {
    await withTestDir(async (dir) => {
      const sha = workspace(dir);
      git(dir, "tag", `ci/green/${sha}`, sha);
      const result = await cut(dir);
      expect(result.cut).not.toBeNull();
      expect(result.cut).not.toHaveProperty("lane");
      // The full green tag does not stand in for the lane's.
      const err = await refusal(cut(dir, "server", "v1.0.1"));
      expect(err.code).toBe("release-commit-not-green");
      expect(err.message).toContain("has no ci/green-server tag");
      expect(err.fix).toContain("chant ci last-green --lane server");
    });
  });

  test("a lane's revoked tag refuses the cut in that lane", async () => {
    await withTestDir(async (dir) => {
      const sha = workspace(dir);
      git(dir, "tag", `ci/green-server/${sha}`, sha);
      git(dir, "tag", `ci/revoked-server/${sha}`, sha);
      const err = await refusal(cut(dir, "server"));
      expect(err.code).toBe("release-commit-revoked");
      expect(err.message).toContain("has a ci/revoked-server tag");
    });
  });

  test("a lane the declaration does not declare, or no ci.green, is declaration-invalid and writes nothing", async () => {
    await withTestDir(async (dir) => {
      const sha = workspace(dir);
      git(dir, "tag", `ci/green-app/${sha}`, sha);
      const err = await refusal(cut(dir, "app"));
      expect(err.code).toBe("declaration-invalid");
      expect(err.message).toContain(`no lane "app"; it declares server`);
      expect((await readCuts({ cwd: dir })).cuts).toEqual([]);
    });
    await withTestDir(async (dir) => {
      const sha = workspace(dir, null);
      git(dir, "tag", `ci/green-server/${sha}`, sha);
      const err = await refusal(cut(dir, "server"));
      expect(err.code).toBe("declaration-invalid");
      expect(err.message).toContain("declares no ci.green");
    });
  });
});

describe("release candidates in a lane (#4692)", () => {
  test("reads the lane's tags, names the lane, and skips a commit the lane revoked", async () => {
    await withTestDir(async (dir) => {
      const a = workspace(dir);
      git(dir, "commit", "-q", "--allow-empty", "-m", "b");
      const b = git(dir, "rev-parse", "HEAD");
      git(dir, "commit", "-q", "--allow-empty", "-m", "c");
      const c = git(dir, "rev-parse", "HEAD");
      git(dir, "tag", `ci/green/${a}`, a);
      git(dir, "tag", `ci/green-server/${b}`, b);
      git(dir, "tag", `ci/green-server/${c}`, c);
      git(dir, "tag", `ci/revoked-server/${c}`, c);

      const full = await releaseCandidatesDocument({ cwd: dir });
      if ("error" in full) throw new Error(full.error.message);
      expect(full.lane).toBeNull();
      expect(full.candidates.map((x) => x.commit)).toEqual([a]);

      const lane = await releaseCandidatesDocument({ cwd: dir, lane: "server" });
      if ("error" in lane) throw new Error(lane.error.message);
      expect(lane.lane).toBe("server");
      expect(lane.candidates.map((x) => x.commit)).toEqual([b]);
      expect(lane.skipped.map((x) => x.commit)).toEqual([c]);
      contract(candidatesSchema).expectValid(lane);

      const unknown = await releaseCandidatesDocument({ cwd: dir, lane: "app" });
      expect("error" in unknown && unknown.error.message).toContain(`no lane "app"`);
    });
  });
});
