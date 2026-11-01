/**
 * #4693: a release cut of a commit that is not green, under a person's
 * override on the override gate's ledger. The cut records the request, a
 * person the overriders file at base lists answers it with a reason, and the
 * next cut spends it and records who and why on the cut line.
 */

import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cutRelease, greenOverrideSubject, planRelease, ReleaseCutError } from "./release-cut";
import { readCuts, type ReleaseArtifact } from "./release-store";
import { appendGateResolution } from "./gate-ledger";
import { readOverrideLedger } from "./override-ledger";
import { overrideDigest, OVERRIDE_OP } from "../override-gate";
import type { CompiledTarget, TargetCompiler } from "../components/release-compile";
import { releasesDocument } from "../workspace/releases";
import { contract } from "../workspace/__fixtures__/contract-repo";
import releasesSchema from "../workspace/releases.schema.json";

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A project on main with two environments, and `.chant/overriders` listing `overriders` when given. */
function project(dir: string, overriders: string[] | null = ["github:alice"]): string {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@chant.dev");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "chant.config.ts"), `export default { environments: ["dev", "prod"] };\n`);
  mkdirSync(join(dir, "api"), { recursive: true });
  writeFileSync(join(dir, "api", "Dockerfile"), "FROM scratch\n");
  writeFileSync(join(dir, "api.component.ts"), "export const api = {};\n");
  if (overriders) {
    mkdirSync(join(dir, ".chant"), { recursive: true });
    writeFileSync(join(dir, ".chant", "overriders"), `# who may override\n${overriders.join("\n")}\n`);
  }
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

const T0 = "2026-11-01T10:00:00.000Z";
const T1 = "2026-11-01T10:05:00.000Z";
const T2 = "2026-11-01T10:10:00.000Z";
const request = (dir: string, at: string, opts: { label?: string | null; overrideGreen?: boolean } = {}) => ({
  cwd: dir,
  compiler: compiler(),
  label: opts.label === undefined ? "v1.0.1" : opts.label,
  actor: "ci-bot",
  env: {},
  now: () => new Date(at),
  ...(opts.overrideGreen === false ? {} : { overrideGreen: true }),
});
const refusal = async (p: Promise<unknown>): Promise<ReleaseCutError> => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ReleaseCutError);
  return err as ReleaseCutError;
};

/** Write an override of the cut of `sha`, as `chant approve policy-override` would. */
async function override(dir: string, sha: string, by: string, opts: { reason?: string; agent?: boolean; rule?: string } = {}): Promise<void> {
  const subject = greenOverrideSubject(sha);
  await appendGateResolution(
    {
      op: OVERRIDE_OP,
      gate: subject,
      resolvedBy: by,
      timestamp: T1,
      planDigest: overrideDigest(subject, sha, [opts.rule ?? "ci-green"]),
      ...(opts.reason !== "" ? { note: opts.reason ?? "windows runners are down; server phases passed" } : {}),
      approver: { kind: opts.agent ? "agent" : "human" },
    },
    { cwd: dir },
  );
}

describe("a cut of a commit that is not green, under an override (#4693)", () => {
  test("the cut records the request, a listed person overrides it, and the next cut spends it and records who and why", async () => {
    await withTestDir(async (dir) => {
      const sha = project(dir);
      const subject = greenOverrideSubject(sha);

      // A dry run decides and writes nothing.
      const dry = await refusal(planRelease(request(dir, T0)));
      expect(dry.code).toBe("release-commit-not-green");
      expect(dry.recorded).toBe(false);
      expect(dry.message).toContain(`a cut with --yes records the request for an override of ${subject}`);
      expect((await readOverrideLedger({ cwd: dir })).pending).toEqual([]);

      // The cut records the request and names the command that answers it.
      const first = await refusal(cutRelease(request(dir, T0)));
      expect(first.code).toBe("release-commit-not-green");
      expect(first.recorded).toBe(true);
      expect(first.message).toContain(`has no ci/green tag, so no release is cut from it; the request for an override of ${subject} is recorded`);
      expect(first.fix).toContain(`github:alice may override it with: chant approve policy-override ${subject} --rule ci-green --reason "<why>"`);
      const { pending } = await readOverrideLedger({ cwd: dir });
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ op: OVERRIDE_OP, gate: subject, plan: sha, rules: ["ci-green"] });
      // A second refused cut finds the request standing and records no other.
      const again = await refusal(cutRelease(request(dir, T0)));
      expect(again.recorded).toBe(false);
      expect(again.message).toContain(`the request for an override of ${subject} has stood since ${T0}`);

      await override(dir, sha, "github:alice");
      const plan = await planRelease(request(dir, T2));
      expect(plan.override).toMatchObject({ green: false, tag: `ci/green/${sha}`, by: "github:alice", reason: "windows runners are down; server phases passed", sealed: false });

      const result = await cutRelease(request(dir, T2));
      expect(result.cut?.override).toEqual({
        green: false,
        tag: `ci/green/${sha}`,
        by: "github:alice",
        at: T1,
        reason: "windows runners are down; server phases passed",
        digest: overrideDigest(subject, sha, ["ci-green"]),
        sealed: false,
      });
      expect(result.cut?.actor).toBe("ci-bot");
      const { applied } = await readOverrideLedger({ cwd: dir });
      expect(applied).toMatchObject([{ gate: subject, approvedBy: "github:alice", approvedAt: T1, timestamp: T2, commit: sha }]);

      const doc = await releasesDocument({ cwd: dir });
      if ("error" in doc) throw new Error(doc.error.message);
      expect(doc.releases[0].cuts[0].override?.by).toBe("github:alice");
      contract(releasesSchema).expectValid(doc);

      // The override is spent: another label needs its own.
      const spent = await refusal(cutRelease(request(dir, T2, { label: "v1.0.2" })));
      expect(spent.code).toBe("release-commit-not-green");
      expect(spent.message).toContain("is spent");
    });
  });

  test("an override counts only from a listed person, with a reason, and not from an agent", async () => {
    await withTestDir(async (dir) => {
      const sha = project(dir);
      await refusal(cutRelease(request(dir, T0)));
      await override(dir, sha, "github:mallory");
      expect((await refusal(cutRelease(request(dir, T2)))).message).toContain("github:mallory is not listed in .chant/overriders at base (github:alice)");
    });
    await withTestDir(async (dir) => {
      const sha = project(dir);
      await refusal(cutRelease(request(dir, T0)));
      await override(dir, sha, "github:alice", { agent: true });
      expect((await refusal(cutRelease(request(dir, T2)))).message).toContain("was recorded by an agent, and an override is a person's");
    });
    await withTestDir(async (dir) => {
      const sha = project(dir);
      await refusal(cutRelease(request(dir, T0)));
      await override(dir, sha, "github:alice", { reason: "" });
      expect((await refusal(cutRelease(request(dir, T2)))).message).toContain("gives no reason");
    });
  });

  test("with no overriders file nobody may override, and the refusal says so", async () => {
    await withTestDir(async (dir) => {
      project(dir, null);
      const err = await refusal(cutRelease(request(dir, T0)));
      expect(err.fix).toContain(".chant/overriders at base does not exist, so nobody may override it yet");
    });
  });

  test("without --override-green a standing override is not used, and a revoked commit is never cut", async () => {
    await withTestDir(async (dir) => {
      const sha = project(dir);
      await refusal(cutRelease(request(dir, T0)));
      await override(dir, sha, "github:alice");
      const plain = await refusal(cutRelease(request(dir, T2, { overrideGreen: false })));
      expect(plain.code).toBe("release-commit-not-green");
      expect(plain.message).not.toContain("override");

      git(dir, "tag", `ci/revoked/${sha}`, sha);
      const revoked = await refusal(cutRelease(request(dir, T2)));
      expect(revoked.code).toBe("release-commit-revoked");
      expect(revoked.message).toContain("an override does not cut a revoked commit");
      expect((await readCuts({ cwd: dir })).cuts).toEqual([]);
    });
  });

  test("a green commit cuts as before and writes no override", async () => {
    await withTestDir(async (dir) => {
      const sha = project(dir);
      git(dir, "tag", `ci/green/${sha}`, sha);
      const result = await cutRelease(request(dir, T0));
      expect(result.cut).not.toHaveProperty("override");
      expect((await readOverrideLedger({ cwd: dir })).pending).toEqual([]);
    });
  });
});
