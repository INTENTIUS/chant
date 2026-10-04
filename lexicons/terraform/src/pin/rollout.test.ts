/**
 * The pin-bump rollout end to end over git, with the forge mocked (#3189).
 *
 * The repository is choudoufu#1750's pinned-OCI variant at N=5, generated at
 * choudoufu 52bef26 with
 * `go run ./tools/largeset-gen -estates 5 -source oci -registry localhost:4890`:
 * five estate roots, each calling `oci://localhost:4890/largeset/shared?tag=1.0.0`,
 * where e02 reads e01 and e03 reads e02. It is pushed to a bare remote, so
 * the rollout fetches, builds wave branches in its own worktree and pushes
 * them for real. Only the forge is a mock: it records each PR, and the test
 * merges one by moving the remote's `main` to the PR's head, the way a
 * fast-forward merge would.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadHcl2json } from "@intentius/chant/terraform/parse";
import { runPinRollout, type PinRolloutOptions } from "./rollout";
import type { PinCommitCheck, PinForge, PinPullRequest } from "./forge";
import { editPinsInTs } from "./edit-ts";

const parser = await loadHcl2json();
const FIXTURE = new URL("../__fixtures__/pin/largeset-oci-n5", import.meta.url).pathname;
const MODULE = "oci://localhost:4890/largeset/shared";
const DEPS = [
  { root: "estates/e01" },
  { root: "estates/e02", dependsOn: ["estates/e01"] },
  { root: "estates/e03", dependsOn: ["estates/e02"] },
  { root: "estates/e04" },
  { root: "estates/e05" },
];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
}

/** An in-memory forge over the bare remote. */
class MockForge implements PinForge {
  prs = new Map<string, PinPullRequest & { head: string; title: string; base: string }>();
  checks = new Map<string, PinCommitCheck[]>();
  constructor(private remote: string) {}
  async findPullRequest(branch: string) {
    return this.prs.get(branch) ?? null;
  }
  async createPullRequest(input: { base: string; head: string; title: string; body: string }) {
    const url = `https://forge.test/pr/${this.prs.size + 1}`;
    this.prs.set(input.head, { ...input, url, state: "open" });
    return url;
  }
  async commitChecks(sha: string) {
    return this.checks.get(sha) ?? [];
  }
  /** Merge the PR from `branch` by moving the remote's main to its head. */
  merge(branch: string): string {
    const sha = git(this.remote, "rev-parse", `refs/heads/${branch}`).trim();
    git(this.remote, "update-ref", "refs/heads/main", sha);
    const pr = this.prs.get(branch)!;
    pr.state = "merged";
    pr.mergeCommit = sha;
    return sha;
  }
  report(sha: string, roots: string[], state: PinCommitCheck["state"]) {
    this.checks.set(sha, [...(this.checks.get(sha) ?? []), ...roots.map((r) => ({ name: `apply/${r}`, state }))]);
  }
}

let dir: string;
let remote: string;
let work: string;
let forge: MockForge;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pin-rollout-"));
  remote = join(dir, "remote.git");
  work = join(dir, "work");
  git(dir, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  cpSync(FIXTURE, work, { recursive: true });
  git(work, "init", "--quiet", "--initial-branch=main");
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "fixture");
  git(work, "remote", "add", "origin", remote);
  git(work, "push", "--quiet", "origin", "main");
  git(work, "remote", "set-head", "origin", "main");
  forge = new MockForge(remote);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function options(extra: Partial<PinRolloutOptions> = {}): PinRolloutOptions {
  return { cwd: work, module: MODULE, from: "1.0.0", to: "1.1.0", parser, forge, roots: DEPS, canaries: ["estates/e04"], mode: "pull-request", ...extra };
}

/** The roots a path-diff selection picks for a branch: the root directories of the files it changes against main. */
function pathDiffRoots(branch: string): string[] {
  const files = git(remote, "diff", "--name-only", `main...${branch}`).split("\n").filter(Boolean);
  return [...new Set(files.map((f) => f.split("/").slice(0, 2).join("/")))].sort();
}

describe("runPinRollout (#3189)", () => {
  test("one PR per wave, each opening only after the last merged and applied", async () => {
    const head = git(work, "rev-parse", "HEAD").trim();

    // Run 1 opens wave 1, the canary, and nothing else.
    const r1 = await runPinRollout(options());
    expect(r1.status).toBe("opened");
    expect(r1.waves.map((w) => [w.wave, w.roots, w.state])).toEqual([
      [1, ["estates/e04"], "opened"],
      [2, ["estates/e01", "estates/e05"], "not-reached"],
      [3, ["estates/e02"], "not-reached"],
      [4, ["estates/e03"], "not-reached"],
    ]);
    expect([...forge.prs.keys()]).toEqual(["chant/pin/localhost-4890-largeset-shared/1.1.0/wave-1"]);
    const pr1 = forge.prs.get(r1.waves[0]!.branch)!;
    expect(pr1.base).toBe("main");
    expect(pr1.body).toContain("`oci://localhost:4890/largeset/shared` pin 1.0.0 -> 1.1.0");
    expect(pr1.body).toContain("wave 1 of 4 (canaries)");
    expect(pr1.body).toContain("- `estates/e04`: estates/e04/main.tf module.shared");
    expect(pathDiffRoots(r1.waves[0]!.branch)).toEqual(["estates/e04"]);

    // Never the default branch, never the caller's checkout.
    expect(git(remote, "rev-parse", "refs/heads/main").trim()).toBe(head);
    expect(git(work, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(work, "status", "--porcelain")).toBe("");

    // Run 2, before the merge: reports where it stands and opens nothing.
    const r2 = await runPinRollout(options());
    expect(r2.status).toBe("waiting");
    expect(r2.waves[0]!.state).toBe("open");
    expect(forge.prs.size).toBe(1);

    // Merged, apply not reported yet: still nothing opens.
    const merge1 = forge.merge(r1.waves[0]!.branch);
    const r3 = await runPinRollout(options());
    expect(r3.status).toBe("waiting");
    expect(r3.waves[0]).toMatchObject({ state: "waiting-apply", pending: ["estates/e04"] });
    expect(forge.prs.size).toBe(1);

    // Applied: wave 2 opens, built on the merged main.
    forge.report(merge1, ["estates/e04"], "success");
    const r4 = await runPinRollout(options());
    expect(r4.status).toBe("opened");
    expect(r4.waves.map((w) => w.state)).toEqual(["applied", "opened", "not-reached", "not-reached"]);
    expect(pathDiffRoots(r4.waves[1]!.branch)).toEqual(["estates/e01", "estates/e05"]);

    // Waves 2 to 4, each merged and applied in turn.
    let last = r4;
    for (const n of [1, 2, 3]) {
      const branch = last.waves[n]!.branch;
      forge.report(forge.merge(branch), last.waves[n]!.roots, "success");
      last = await runPinRollout(options());
      if (n < 3) {
        expect(last.waves[n + 1]!.state).toBe("opened");
        expect(pathDiffRoots(last.waves[n + 1]!.branch)).toEqual(last.waves[n + 1]!.roots);
      }
    }
    expect(last.status).toBe("complete");
    expect(forge.prs.size).toBe(4);
    // Every root is at the new pin on main.
    for (const e of ["e01", "e02", "e03", "e04", "e05"]) {
      expect(git(remote, "show", `main:estates/${e}/main.tf`)).toContain(`${MODULE}?tag=1.1.0`);
    }
  });

  test("a failed root stops the waves after it, and is named", async () => {
    const r1 = await runPinRollout(options({ canaries: [] }));
    const wave1 = r1.waves[0]!;
    expect(wave1.roots).toEqual(["estates/e01", "estates/e04", "estates/e05"]);
    const sha = forge.merge(wave1.branch);
    forge.report(sha, ["estates/e01", "estates/e04"], "success");
    forge.report(sha, ["estates/e05"], "failure");
    const r2 = await runPinRollout(options({ canaries: [] }));
    expect(r2.status).toBe("stopped");
    expect(r2.stop).toBe("wave 1: estates/e05 failed its apply check apply/estates/e05");
    expect(r2.waves.map((w) => w.state)).toEqual(["failed", "not-reached", "not-reached"]);
    expect(forge.prs.size).toBe(1);
  });

  test("a PR closed without merging stops the rollout", async () => {
    const r1 = await runPinRollout(options());
    forge.prs.get(r1.waves[0]!.branch)!.state = "closed";
    const r2 = await runPinRollout(options());
    expect(r2.status).toBe("stopped");
    expect(r2.stop).toMatch(/wave 1's PR https:\/\/forge.test\/pr\/1 was closed without merging/);
  });

  test("report mode opens nothing and pushes nothing", async () => {
    const r = await runPinRollout(options({ mode: "report" }));
    expect(r.status).toBe("would-open");
    expect(r.waves[0]).toMatchObject({ state: "would-open", files: ["estates/e04/main.tf"] });
    expect(forge.prs.size).toBe(0);
    expect(git(remote, "branch", "--list", "chant/*")).toBe("");
  });

  test("a floating constraint is refused by name and left out of every wave", async () => {
    const tf = join(work, "estates/e05/main.tf");
    writeFileSync(tf, readFileSync(tf, "utf-8").replace(`source = "${MODULE}?tag=1.0.0"`, `source  = "app.terraform.io/acme/shared/aws"\n  version = "~> 1.0"`));
    git(work, "commit", "--quiet", "-am", "e05 floats");
    git(work, "push", "--quiet", "origin", "main");
    const r = await runPinRollout(options({ module: "app.terraform.io/acme/shared/aws", from: "1.0.0", to: "1.1.0", mode: "report", roots: undefined, canaries: [] }));
    expect(r.roots).toEqual([
      expect.objectContaining({ root: "estates/e05", state: "refused", reason: expect.stringContaining(`version "~> 1.0" is a constraint, not a pin`) }),
    ]);
    expect(r.waves).toEqual([]);
    expect(r.status).toBe("complete");
  });

  test("roots are found when none are named, and choudoufu's waves can order them", async () => {
    const doc = JSON.parse(readFileSync(new URL("../__fixtures__/pin/choudoufu-live-waves-n5.json", import.meta.url), "utf-8"));
    const { wavesFromChoudoufu } = await import("./waves");
    const r = await runPinRollout(options({ roots: undefined, canaries: undefined, waves: wavesFromChoudoufu(doc), mode: "report" }));
    expect(r.roots.map((x) => x.root)).toEqual(["estates/e01", "estates/e02", "estates/e03", "estates/e04", "estates/e05"]);
    expect(r.waves.map((w) => w.roots)).toEqual([["estates/e04"], ["estates/e01", "estates/e05"], ["estates/e02"], ["estates/e03"]]);
  });

  test("a generated root's pin moves in its TypeScript source", async () => {
    writeFileSync(join(work, "estates/e04/shared.ts"), `export const shared = { source: "${MODULE}?tag=1.0.0", name: "e04" };\n`);
    git(work, "add", ".");
    git(work, "commit", "--quiet", "-m", "e04 is generated");
    git(work, "push", "--quiet", "origin", "main");
    const roots = DEPS.map((r) => (r.root === "estates/e04" ? { ...r, tsSource: "estates/e04/shared.ts" } : r));

    const without = await runPinRollout(options({ roots, mode: "report" }));
    expect(without.roots.find((r) => r.root === "estates/e04")).toMatchObject({ state: "refused", reason: expect.stringContaining("no TypeScript editor") });

    const r = await runPinRollout(options({ roots, editTs: editPinsInTs }));
    expect(r.waves[0]).toMatchObject({ roots: ["estates/e04"], state: "opened", files: ["estates/e04/shared.ts"] });
    expect(git(remote, "show", `${r.waves[0]!.branch}:estates/e04/shared.ts`)).toContain(`${MODULE}?tag=1.1.0`);
  });
});
