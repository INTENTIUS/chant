/**
 * #4027: what a cut reads from the checkout and the environment before it
 * compiles, against temp repos with temp bare remotes. Nothing is pushed
 * anywhere but those remotes, and no tag is pushed at all.
 */

import { describe, test, expect } from "vitest";
import { withTestDir } from "@intentius/chant-test-utils";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkCleanTree,
  checkOnTrunk,
  checkReleaseTag,
  createReleaseTag,
  publicKeyOf,
  releaseTagName,
  resolveCutActor,
  resolveTrunk,
  WorkstationCheckError,
} from "./release-workstation";
import { nextCommands, sameWithYes } from "../cli/handlers/release";
import { hasSshKeygen } from "../workspace/trust/test-repo";

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo at `<root>/work` with one commit on main, pushed to the bare `<root>/origin.git`. */
function pushedRepo(root: string): { dir: string; sha: string } {
  const dir = join(root, "work");
  mkdirSync(dir);
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "dev@chant.dev");
  git(dir, "config", "user.name", "Dev");
  writeFileSync(join(dir, "README.md"), "fixture\n");
  writeFileSync(join(dir, ".gitignore"), "dist/\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "remote", "add", "origin", join(root, "origin.git"));
  git(dir, "push", "-q", "origin", "main");
  git(dir, "fetch", "-q", "origin");
  return { dir, sha: git(dir, "rev-parse", "HEAD") };
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (err) {
    if (err instanceof WorkstationCheckError) return err.code;
    throw err;
  }
};

describe("trunk and pushed", () => {
  test("trunk is ci.green.branch when declared, else what origin/HEAD names, else main", () =>
    withTestDir(async (root) => {
      const { dir } = pushedRepo(root);
      expect(resolveTrunk(dir, "release")).toEqual({ remote: "origin", branch: "release", from: "ci.green.branch" });
      // A fetch may set origin/HEAD, depending on the git version.
      git(dir, "remote", "set-head", "origin", "-d");
      expect(resolveTrunk(dir, null)).toEqual({ remote: "origin", branch: "main", from: "default" });
      git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
      expect(resolveTrunk(dir, null)).toEqual({ remote: "origin", branch: "trunk", from: "origin/HEAD" });
    }));

  test("a commit reachable from origin/<trunk> passes; one only on the local branch is not pushed; one off trunk is refused", () =>
    withTestDir(async (root) => {
      const { dir, sha } = pushedRepo(root);
      const trunk = resolveTrunk(dir, null);
      expect(codeOf(() => checkOnTrunk(dir, sha, trunk))).toBeUndefined();

      writeFileSync(join(dir, "a.txt"), "a\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "local only");
      const local = git(dir, "rev-parse", "HEAD");
      expect(codeOf(() => checkOnTrunk(dir, local, trunk))).toBe("release-commit-not-pushed");
      // An older commit stays pushed whatever the local branch holds.
      expect(codeOf(() => checkOnTrunk(dir, sha, trunk))).toBeUndefined();

      git(dir, "checkout", "-q", "-b", "feature", sha);
      writeFileSync(join(dir, "b.txt"), "b\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "feature");
      const feature = git(dir, "rev-parse", "HEAD");
      expect(codeOf(() => checkOnTrunk(dir, feature, trunk))).toBe("release-commit-not-on-trunk");
      // The branch ci.green names is trunk even when the commit is pushed elsewhere.
      git(dir, "push", "-q", "origin", "feature");
      git(dir, "fetch", "-q", "origin");
      expect(codeOf(() => checkOnTrunk(dir, feature, trunk))).toBe("release-commit-not-on-trunk");
      expect(codeOf(() => checkOnTrunk(dir, feature, resolveTrunk(dir, "feature")))).toBeUndefined();
    }));

  test("a clone with no origin/<trunk> can't show the commit pushed", () =>
    withTestDir(async (root) => {
      git(root, "init", "-q", "-b", "main", "solo");
      const dir = join(root, "solo");
      git(dir, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "init");
      const err = (() => {
        try {
          checkOnTrunk(dir, git(dir, "rev-parse", "HEAD"), resolveTrunk(dir, null));
        } catch (e) {
          return e as WorkstationCheckError;
        }
      })();
      expect(err?.code).toBe("release-commit-not-pushed");
      expect(err?.message).toMatch(/this clone knows no origin\/main/);
    }));
});

describe("a clean tree", () => {
  test("refuses a tracked change and an untracked file, and ignores what .gitignore covers", () =>
    withTestDir(async (root) => {
      const { dir, sha } = pushedRepo(root);
      expect(codeOf(() => checkCleanTree(dir, sha))).toBeUndefined();
      mkdirSync(join(dir, "dist"));
      writeFileSync(join(dir, "dist", "out.json"), "{}\n");
      expect(codeOf(() => checkCleanTree(dir, sha))).toBeUndefined();
      writeFileSync(join(dir, "extra.component.ts"), "export const x = {};\n");
      expect(() => checkCleanTree(dir, sha)).toThrow(/1 untracked file\(s\) such as extra\.component\.ts/);
      git(dir, "add", "extra.component.ts");
      writeFileSync(join(dir, "README.md"), "changed\n");
      expect(() => checkCleanTree(dir, sha)).toThrow(/2 tracked file\(s\) with uncommitted changes/);
    }));
});

describe("the actor", () => {
  test("is --actor, else the CI's actor, else git's user.email", () =>
    withTestDir(async (root) => {
      const { dir } = pushedRepo(root);
      expect(resolveCutActor({ cwd: dir, explicit: "carol", env: { GITHUB_ACTOR: "ci" } })).toEqual({ actor: "carol", source: "flag" });
      expect(resolveCutActor({ cwd: dir, env: { GITHUB_ACTOR: "octo", USER: "u" } })).toEqual({ actor: "octo", source: "ci" });
      expect(resolveCutActor({ cwd: dir, env: { GITLAB_USER_LOGIN: "gl", USER: "u" } })).toEqual({ actor: "gl", source: "ci" });
      expect(resolveCutActor({ cwd: dir, env: { USER: "u" } })).toEqual({ actor: "dev@chant.dev", source: "git" });
    }));

  test.skipIf(!hasSshKeygen)("is the principal the signers file lists for the signing key, ahead of the CI and git", () =>
    withTestDir(async (root) => {
      const { dir } = pushedRepo(root);
      const key = join(root, "key-alice");
      execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "alice", "-f", key]);
      const pub = publicKeyOf(key);
      expect(pub).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+$/);
      expect(publicKeyOf(`${key}.pub`)).toBe(pub);
      const signers = [
        { principal: "github:alice", key: pub!, line: 1 },
        { principal: "bob", key: "ssh-ed25519 AAAAother", line: 2 },
      ];
      expect(resolveCutActor({ cwd: dir, publicKey: pub, signers, env: { GITHUB_ACTOR: "octo" } })).toEqual({ actor: "github:alice", source: "signer" });
      // A key listed for two principals names no one, so the next source answers.
      const twice = [...signers, { principal: "alice2", key: pub!, line: 3 }];
      expect(resolveCutActor({ cwd: dir, publicKey: pub, signers: twice, env: { GITHUB_ACTOR: "octo" } })).toEqual({ actor: "octo", source: "ci" });
      expect(resolveCutActor({ cwd: dir, explicit: "carol", publicKey: pub, signers })).toEqual({ actor: "carol", source: "flag" });
    }));
});

describe("the release tag", () => {
  test("is release/<label>, or release/<member>/<label> in a member, made locally as an annotated tag naming the digest", () =>
    withTestDir(async (root) => {
      const { dir, sha } = pushedRepo(root);
      expect(releaseTagName(null, "v1.2.0")).toBe("release/v1.2.0");
      expect(releaseTagName("services/api", "v1.2.0")).toBe("release/services/api/v1.2.0");
      expect(checkReleaseTag(dir, "release/v1", sha)).toBe("absent");
      createReleaseTag(dir, "release/v1", sha, { releaseDigest: "jcs1-sha256:abc", label: "v1", member: null });
      expect(git(dir, "cat-file", "-t", "release/v1")).toBe("tag");
      expect(git(dir, "tag", "-l", "--format=%(contents)", "release/v1")).toBe("release v1\n\nRelease-Digest: jcs1-sha256:abc");
      expect(checkReleaseTag(dir, "release/v1", sha)).toBe("present");
      expect(git(root, "ls-remote", "--tags", join(root, "origin.git"))).toBe("");

      writeFileSync(join(dir, "c.txt"), "c\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "next");
      expect(codeOf(() => checkReleaseTag(dir, "release/v1", git(dir, "rev-parse", "HEAD")))).toBe("release-tag-taken");
      expect(codeOf(() => checkReleaseTag(dir, "release/v1..2", sha))).toBe("release-tag-invalid");
    }));
});

describe("the next command", () => {
  test("in CI is the publish; on a workstation it pushes the tag first, then publish or deploy", () => {
    expect(nextCommands({ ref: "v1", tag: "release/v1", inCi: true, firstEnv: "dev", noComponents: false })).toEqual([
      "chant release publish v1",
      "chant components promote --release v1 --to dev",
    ]);
    expect(nextCommands({ ref: "v1", tag: "release/v1", inCi: false, firstEnv: "dev", noComponents: false })).toEqual([
      "git push origin release/v1",
      "chant release publish v1",
      "chant components promote --release v1 --to dev",
    ]);
    expect(nextCommands({ ref: "jcs1-sha256:ab", tag: null, inCi: false, firstEnv: "dev", noComponents: true })).toEqual([
      "chant release publish jcs1-sha256:ab",
      "chant release export jcs1-sha256:ab --env dev",
    ]);
  });

  test("after a dry run is the same command line with --yes, without --json", () => {
    expect(sameWithYes(["release", "cut", "v1", "--build", "npm run build", "--json"])).toBe("chant release cut v1 --build 'npm run build' --yes");
    expect(sameWithYes(["release", "cut", "v1", "--build", "echo 'x'"])).toBe(`chant release cut v1 --build 'echo '\\''x'\\''' --yes`);
  });
});
