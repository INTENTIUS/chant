/**
 * #4169 — `ci serve --build-command` serves each `ci/build/<sha>` tag once,
 * within `maxJobs`, and records how each build ended.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { buildRequestAnnotation, requestedBuild } from "./ci-builds";
import { ciServeBuilds, ciServePass, formatCiServeEvent, newCiServeRuntime, type CiServeEvent, type CiServeOptions } from "./ci-serve";
import type { CiGreen } from "./declaration";

afterAll(cleanScratch);

const GREEN = { branch: "main", phases: [], require: ["suites"] } as unknown as CiGreen;

function clone(): { root: string; shas: string[] } {
  const origin = scratchDir("chant-serve-builds-origin-");
  git(origin, "init", "-q", "--bare");
  const root = scratchDir("chant-serve-builds-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  git(root, "config", "user.name", "t");
  git(root, "config", "user.email", "t@example.com");
  git(root, "remote", "add", "origin", origin);
  const shas: string[] = [];
  for (const n of ["a", "b"]) {
    writeFiles(root, { [`${n}.txt`]: `${n}\n` });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", n);
    shas.push(git(root, "rev-parse", "HEAD"));
    const r = requestedBuild(GREEN, shas.at(-1)!, ["suites"], new Date(`2026-10-20T1${shas.length}:00:00Z`));
    git(root, "tag", "-a", "-m", buildRequestAnnotation(r), r.tag, r.commit);
  }
  git(root, "push", "-q", "origin", "main", "--tags");
  // The serve's clone learns the tags from the forge.
  for (const s of shas) git(root, "tag", "-d", `ci/build/${s}`);
  return { root, shas };
}

const options = (root: string, built: string[], log: CiServeEvent[], extra: Partial<CiServeOptions> = {}): CiServeOptions => ({
  cwd: root,
  forge: "github",
  repo: "acme/app",
  env: "prod",
  client: { openPullRequests: async () => [], branchHead: async () => undefined },
  stateDir: join(root, ".serve"),
  buildCommand: "true",
  build: async ({ request }) => (built.push(request.commit), request.commit === built[0] ? 0 : 2),
  log: (e) => log.push(e),
  ...extra,
});

describe("ci serve --build-command (#4169)", () => {
  test("serves each request once, oldest first, within maxJobs, and records how it ended", async () => {
    const { root, shas } = clone();
    const built: string[] = [];
    const log: CiServeEvent[] = [];
    const rt = newCiServeRuntime();
    const first = ciServeBuilds(options(root, built, log), rt);
    expect(first.events.map((e) => e.type === "build" && e.status)).toEqual(["started", "held"]);
    await Promise.all(first.started);
    const second = ciServeBuilds(options(root, built, log), rt);
    await Promise.all(second.started);
    expect(built).toEqual(shas);
    const state = JSON.parse(readFileSync(join(root, ".serve", "chant-apply-prod.json"), "utf-8"));
    expect(Object.fromEntries(Object.entries(state.builds).map(([k, v]) => [k, (v as { status: string }).status]))).toEqual({ [`build:${shas[0]}`]: "ok", [`build:${shas[1]}`]: "fail" });
    // Served once: another pass starts nothing.
    expect(ciServeBuilds(options(root, built, log), rt).started).toEqual([]);
    expect(log.map((e) => formatCiServeEvent(e))).toContain(`the build of suites at ${shas[1].slice(0, 12)} failed with exit code 2`);
  });

  test("without --build-command a pass leaves the tags alone; the default build runs the command in a worktree of the commit", async () => {
    const { root, shas } = clone();
    const log: CiServeEvent[] = [];
    await ciServePass({ ...options(root, [], log), buildCommand: undefined });
    expect(log.filter((e) => e.type === "build")).toEqual([]);
    const out = join(root, ".serve-out");
    await ciServePass({ ...options(root, [], log), build: undefined, buildCommand: `git rev-parse HEAD >> ${out}; echo "$CHANT_BUILD_PHASES $CHANT_BUILD_REASON" >> ${out}`, maxJobs: 2 });
    expect(existsSync(out)).toBe(true);
    const lines = readFileSync(out, "utf-8").trim().split("\n");
    expect(lines.filter((l) => /^[0-9a-f]{40}$/.test(l)).sort()).toEqual([...shas].sort());
    expect(lines.filter((l) => l === "suites requested")).toHaveLength(2);
  });
});
