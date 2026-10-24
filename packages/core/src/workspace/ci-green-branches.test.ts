/**
 * #4325: `ci.green` names several branches when `ci.branches` routes members
 * to branches of their own. Each is judged as the single branch always was, a
 * one-branch declaration reads as before, and `release cut` takes a commit of
 * any of them.
 */

import { afterAll, describe, expect, test } from "vitest";
import { greenBranches, parseDeclaration } from "./declaration";
import { cleanScratch, declaration, git, scratchDir, writeFiles } from "./__fixtures__/contract-repo";
import { ciList, ciTick, formatTick, greenOn, lastGreen } from "./ci-green";
import type { CheckRun, CiForge } from "./ci-green-forge";
import { buildTriggerEdits, renderCiGreenWorkflow } from "./ci-green-workflow";
import { checkOnGreenBranches, checkOnTrunk, resolveTrunk, WorkstationCheckError } from "../lifecycle/release-workstation";

afterAll(cleanScratch);

const PHASES = { test: ["test"] };
const decl = (green: unknown) => JSON.stringify({ name: "w", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "x" }], ci: { green } });
const parse = (branch: unknown) => parseDeclaration(decl({ branch, phases: PHASES, require: ["test"] }), "chant.workspace.json").ci!.green!;

describe("ci.green.branch as one branch or several (#4325)", () => {
  test("a string reads exactly as it did: no branches field", () => {
    const g = parse("main");
    expect(g.branch).toBe("main");
    expect("branches" in g).toBe(false);
    expect(greenBranches(g)).toEqual(["main"]);
    // A list of one is the same declaration.
    expect(parse(["main"])).toEqual(g);
  });

  test("a list judges each branch, and the first is the trunk readers use", () => {
    const g = parse(["main", "release"]);
    expect(g.branch).toBe("main");
    expect(g.branches).toEqual(["main", "release"]);
    expect(greenBranches(g)).toEqual(["main", "release"]);
  });

  test("an empty list, a repeated branch and a malformed name are refused", () => {
    for (const bad of [[], ["main", "main"], ["main", "has space"], [3]]) {
      expect(() => parse(bad), JSON.stringify(bad)).toThrow();
    }
  });

  test("greenOn picks a branch ci.green names and refuses one it doesn't", () => {
    const g = parse(["main", "release"]);
    expect(greenOn(g, undefined).branch).toBe("main");
    expect(greenOn(g, "release").branch).toBe("release");
    expect("branches" in greenOn(g, "release")).toBe(false);
    expect(() => greenOn(g, "staging")).toThrow(/judges main, release, not staging/);
  });
});

// ── The tick, against a real remote ──────────────────────────────────────────

const NOW = new Date();
const run = (id: number, name: string, conclusion: string): CheckRun => ({ id, name, status: "completed", conclusion, completedAt: null, url: `https://example.com/runs/${id}` });

function commit(root: string, file: string): string {
  writeFiles(root, { [file]: `${file}\n` });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", file);
  return git(root, "rev-parse", "HEAD");
}

/** A checkout with `main` and `release` pushed to a bare origin, one commit each past a shared base. */
function twoBranches(green: unknown): { root: string; origin: string; main: string; release: string } {
  const origin = scratchDir("chant-ci-branches-origin-");
  git(origin, "init", "-q", "--bare");
  const root = scratchDir("chant-ci-branches-work-");
  git(root, "init", "-q");
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFiles(root, { "chant.workspace.json": declaration([{ name: "app", dir: "app", kind: "other", because: "the app" }], { ci: { green } }) });
  git(root, "remote", "add", "origin", origin);
  commit(root, "app/base.txt");
  git(root, "checkout", "-q", "-b", "release");
  const release = commit(root, "app/release.txt");
  git(root, "checkout", "-q", "main");
  const main = commit(root, "app/main.txt");
  git(root, "push", "-q", "origin", "main", "release");
  return { root, origin, main, release };
}

const remoteTags = (origin: string) => git(origin, "for-each-ref", "--format=%(refname:lstrip=2)", "refs/tags/").split("\n").filter(Boolean).sort();
const forge = (shas: string[]): CiForge => ({ kind: "github", checkRuns: async (sha) => (shas.includes(sha) ? [run(1, "test", "success")] : []) });

describe("the tick judges each branch ci.green names (#4325)", () => {
  test("a commit of a routed branch gets a green tag, and last-green reads each branch", async () => {
    const { root, origin, main, release } = twoBranches({ branch: ["main", "release"], phases: PHASES, require: ["test"] });
    const result = await ciTick({ cwd: root, forge: forge([main, release]), now: NOW });
    expect(result.branch).toBe("main");
    expect(result.routed?.map((r) => r.branch)).toEqual(["release"]);
    expect(result.made.sort()).toEqual([`ci/green/${main}`, `ci/green/${release}`].sort());
    expect(remoteTags(origin)).toEqual([`ci/green/${main}`, `ci/green/${release}`].sort());
    // The tag says which branch it judged.
    const note = git(origin, "tag", "-l", "--format=%(contents)", `ci/green/${release}`);
    expect(JSON.parse(note.slice(note.indexOf("{")))).toMatchObject({ tag: "green", commit: release, branch: "release" });

    expect((lastGreen({ cwd: root }) as { commit: { sha: string } }).commit.sha).toBe(main);
    const onRelease = lastGreen({ cwd: root, branch: "release" }) as { branch: string; commit: { sha: string } };
    expect([onRelease.branch, onRelease.commit.sha]).toEqual(["release", release]);
    expect(lastGreen({ cwd: root, branch: "staging" })).toMatchObject({ error: { code: "ci-branch-unknown" } });

    const listed = await ciList({ cwd: root, branch: "release", now: NOW });
    expect("commits" in listed && listed.commits.filter((c) => c.state === "green").map((c) => c.sha)).toEqual([release]);

    const text = formatTick(result);
    expect(text).toContain("main, commits within 24h");
    expect(text).toContain("release, commits within 24h");
  });

  test("a one-branch declaration ticks one branch, with no routed results", async () => {
    const { root, main, release } = twoBranches({ branch: "main", phases: PHASES, require: ["test"] });
    const result = await ciTick({ cwd: root, forge: forge([main, release]), now: NOW });
    expect(result.routed).toBeUndefined();
    expect(result.made).toEqual([`ci/green/${main}`]);
    expect(lastGreen({ cwd: root, branch: "release" })).toMatchObject({ error: { code: "ci-branch-unknown" } });
  });
});

describe("the generated tick workflow follows the branches (#4325)", () => {
  const green = (branch: string | string[]) => parse(branch);

  test("workflow_run lists every branch, and one branch renders as before", () => {
    const render = (g: ReturnType<typeof green>) => renderCiGreenWorkflow({ green: g, workflows: ["ci"], chantVersion: "0.0.0", workspaceRoot: ".", install: undefined, chant: undefined, npmLock: undefined, push: undefined });
    const many = render(green(["main", "release"]));
    expect(many).toMatch(/branches:\n\s+- "?main"?\n\s+- "?release"?\n/);
    // The checkout stays on the first branch, which holds the declaration the tick reads.
    expect(many).toMatch(/ref: "?main"?/);
    expect(render(green("main"))).not.toContain("release");
  });

  test("a push-triggered build lists every branch", () => {
    const sources = [{ path: ".github/workflows/ci.yml", text: "name: ci\non:\n  push:\n    branches: [main]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: []\n" }];
    const g = parseDeclaration(decl({ branch: ["main", "release"], phases: { test: { runs: ["test"], build: "newest" } }, require: ["test"] }), "chant.workspace.json").ci!.green!;
    const [edit] = buildTriggerEdits(g, sources as never, { compose: false });
    expect(edit!.text).toMatch(/branches:\n\s+- main\n\s+- release/);
  });
});

describe("release cut takes a commit of any branch ci.green names (#4325)", () => {
  test("a routed branch's commit is on trunk for the cut, and an unrelated one is not", () => {
    const { root, main, release } = twoBranches({ branch: ["main", "release"], phases: PHASES, require: ["test"] });
    git(root, "fetch", "-q", "origin");
    const trunk = resolveTrunk(root, "main");
    expect(() => checkOnTrunk(root, main, trunk)).not.toThrow();
    expect(() => checkOnTrunk(root, release, trunk)).toThrow(WorkstationCheckError);
    expect(checkOnGreenBranches(root, main, trunk, ["release"]).branch).toBe("main");
    expect(checkOnGreenBranches(root, release, trunk, ["release"]).branch).toBe("release");
    // Without the routed branch listed, the first branch's refusal stands.
    expect(() => checkOnGreenBranches(root, release, trunk, [])).toThrow(WorkstationCheckError);
  });
});
