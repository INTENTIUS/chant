/**
 * WSP152 (#4325): a member's generated pipeline targets the branch
 * `ci.branches` routes the member to.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "../checks";
import { pipelineTargets, routeDifferences } from "./ci-branch";
import { REASONS } from "../reason-codes";
import { servedBranches } from "../ci-branches";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-ci-branch-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A generated pull-request pipeline, as chant writes it for a target `branch` (`--branch` is on the record and apply commands only). */
const pipeline = (branch: string | null, triggers: string[] = branch === null ? [] : [branch]): string =>
  [
    "on:",
    "  pull_request:",
    ...(triggers.length > 0 ? [`    branches: [${triggers.join(", ")}]`] : []),
    "  push:",
    ...(triggers.length > 0 ? [`    branches: [${triggers.join(", ")}]`] : []),
    "jobs:",
    "  plan:",
    "    steps:",
    "      - run: chant ci run plan --in-place --no-push --env prod --gate pr-apply --forge github",
    "  record:",
    "    steps:",
    `      - run: chant ci run record --in-place --env prod --gate pr-apply --forge github${branch === null ? "" : ` --branch "${branch}"`}`,
    "",
  ].join("\n");

const PIPELINE_PATH = ".github/workflows/chant-pr.app.prod.yml";
const record = JSON.stringify({ schema: 1, files: [{ path: PIPELINE_PATH, command: "chant build" }] });
const workspace = (branches: Record<string, string[]> | undefined, text: string, members = ["app"]): Record<string, string> => ({
  "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, members: members.map((name) => ({ name, dir: name, kind: "other", because: name })), ...(branches ? { ci: { branches } } : {}) }),
  ...Object.fromEntries(members.map((m) => [`${m}/.chant/generated.json`, record])),
  [PIPELINE_PATH]: text,
});

const found = async (root: string) =>
  (await runDeclarationChecks(root, (f) => f, { gather: false })).diagnostics.filter((d) => d.ruleId === "WSP152").map((d) => [d.code, d.entity ?? null, d.severity]);

describe("what a pipeline targets", () => {
  test("reads the --branch of each record and apply command, and the trigger branch lists", () => {
    expect(pipelineTargets(pipeline("release"))).toEqual({
      jobs: [{ line: 12, branch: "release" }],
      triggers: [
        { trigger: "push", branches: ["release"] },
        { trigger: "pull_request", branches: ["release"] },
      ],
    });
    expect(pipelineTargets(pipeline(null)).jobs).toEqual([{ line: 10, branch: null }]);
    expect(pipelineTargets("not: [valid").triggers).toEqual([]);
  });

  test("a routed member's pipeline names its route in both places; an unrouted one does not name a reserved branch", () => {
    const listed = ["release"];
    expect(routeDifferences(pipelineTargets(pipeline("release")), "release", listed, "app")).toEqual([]);
    expect(routeDifferences(pipelineTargets(pipeline("main")), "release", listed, "app")).toHaveLength(3);
    expect(routeDifferences(pipelineTargets(pipeline(null)), "release", listed, "app")).toEqual([expect.stringContaining("the default branch")]);
    expect(routeDifferences(pipelineTargets(pipeline("release", ["release", "main"])), "release", listed, "app")).toHaveLength(2);
    expect(routeDifferences(pipelineTargets(pipeline("main")), null, listed, "app")).toEqual([]);
    expect(routeDifferences(pipelineTargets(pipeline("release")), null, listed, "app")).toHaveLength(3);
  });
});

describe("WSP152 over a workspace", () => {
  test("a pipeline on the route passes, and a workspace with no ci.branches is not read", async () => {
    expect(await found(repo(workspace({ release: ["app"] }, pipeline("release"))))).toEqual([]);
    expect(await found(repo(workspace(undefined, pipeline("anything"))))).toEqual([]);
  });

  test("a pipeline generated before the route changed fails", async () => {
    const root = repo(workspace({ release: ["app"] }, pipeline("main")));
    expect(await found(root)).toEqual([
      ["ci-branch-route-differs", "app", "error"],
      ["ci-branch-route-differs", "app", "error"],
      ["ci-branch-route-differs", "app", "error"],
    ]);
  });

  test("an unrouted member's pipeline may not target a branch ci.branches reserves", async () => {
    expect(await found(repo(workspace({ release: ["other"] }, pipeline("release"))))).toHaveLength(3);
    expect(await found(repo(workspace({ release: ["other"] }, pipeline("main"))))).toEqual([]);
  });

  test("the code is a documented reason code", () => {
    expect(REASONS["ci-branch-route-differs"]).toMatch(/targets a branch other than/);
  });
});

describe("the branches ci serve polls (#4325)", () => {
  const branches = { release: ["prod-*"], staging: ["stg-*"] };

  test("a routed member polls its route alone, and a branch that disagrees is refused", () => {
    expect(servedBranches(branches, "prod-eu", "main", false)).toEqual({ served: ["release"], routed: ["release"] });
    expect(servedBranches(branches, "prod-eu", "release", true).served).toEqual(["release"]);
    expect(() => servedBranches(branches, "prod-eu", "main", true)).toThrow(/routes member prod-eu to release/);
  });

  test("an unrouted member polls the default branch, and not one reserved for other members", () => {
    expect(servedBranches(branches, "docs", "main", false)).toEqual({ served: ["main"], routed: [] });
    expect(() => servedBranches(branches, "docs", "release", true)).toThrow(/member docs is not one/);
  });

  test("with no member, the default branch and then each routed branch", () => {
    expect(servedBranches(branches, undefined, "main", false)).toEqual({ served: ["main", "release", "staging"], routed: ["release", "staging"] });
    expect(servedBranches(undefined, undefined, "main", false)).toEqual({ served: ["main"], routed: [] });
    expect(servedBranches(branches, undefined, "release", true).served).toEqual(["release", "staging"]);
  });
});
