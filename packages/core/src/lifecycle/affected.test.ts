import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  changedStacks,
  dependentStacks,
  computeAffected,
  externalInputStacks,
  affectedStacks,
} from "./affected";
import type { StackGraph } from "../build";
import type { Serializer } from "../serializer";
import type { Declarable } from "../declarable";

const execFileAsync = promisify(execFile);

// Serializer whose output reflects entity names + types, so a value change moves
// the bytes but an unrelated edit (comment) does not.
const fakeSerializer: Serializer = {
  name: "fake",
  rulePrefix: "FAKE",
  serialize: (entities) =>
    JSON.stringify([...entities.keys()].sort().map((k) => ({ k, t: entities.get(k)!.entityType }))),
};

function widget(type: string): string {
  return `export const foo = { lexicon: "fake", entityType: "${type}", [Symbol.for("chant.declarable")]: true };\n`;
}

// ── Pure model ────────────────────────────────────────────────────────────────

describe("changedStacks", () => {
  test("flags stacks whose output differs, and added/removed stacks", () => {
    const base = new Map([["a", "1"], ["b", "2"], ["gone", "x"]]);
    const head = new Map([["a", "1"], ["b", "CHANGED"], ["new", "y"]]);
    expect(changedStacks(base, head)).toEqual(["b", "gone", "new"]);
  });
  test("identical builds → nothing changed", () => {
    const m = new Map([["a", "1"], ["b", "2"]]);
    expect(changedStacks(m, new Map(m))).toEqual([]);
  });
});

describe("dependentStacks", () => {
  // Diamond: top→left, top→right, left→base, right→base (consumer→producer).
  const graph: StackGraph = {
    nodes: ["base", "left", "right", "top"],
    edges: [
      { from: "left", to: "base" },
      { from: "right", to: "base" },
      { from: "top", to: "left" },
      { from: "top", to: "right" },
    ],
    order: ["base", "left", "right", "top"],
    waves: [["base"], ["left", "right"], ["top"]],
    cycles: [],
  };
  test("a changed producer surfaces all transitive consumers", () => {
    expect(dependentStacks(["base"], graph)).toEqual(["left", "right", "top"]);
  });
  test("a changed mid-stack surfaces only what's above it", () => {
    expect(dependentStacks(["left"], graph)).toEqual(["top"]);
  });
  test("nothing depends on the top", () => {
    expect(dependentStacks(["top"], graph)).toEqual([]);
  });
});

describe("computeAffected", () => {
  const graph: StackGraph = {
    nodes: ["aws", "k8s"],
    edges: [{ from: "k8s", to: "aws" }],
    order: ["aws", "k8s"],
    waves: [["aws"], ["k8s"]],
    cycles: [],
  };
  const base = new Map([["aws", "v1"], ["k8s", "same"]]);
  const head = new Map([["aws", "v2"], ["k8s", "same"]]);

  test("dependents excluded by default", () => {
    const r = computeAffected(base, head, graph);
    expect(r.changed).toEqual(["aws"]);
    expect(r.dependents).toEqual([]);
  });
  test("--include-dependents adds the unchanged consumer of a changed producer", () => {
    const r = computeAffected(base, head, graph, { includeDependents: true });
    expect(r.changed).toEqual(["aws"]);
    expect(r.dependents).toEqual(["k8s"]); // k8s bytes unchanged, but consumes aws
  });
  test("external-input stacks are reported as indeterminate", () => {
    const r = computeAffected(base, head, graph, { externalInput: ["k8s"] });
    expect(r.indeterminate).toEqual(["k8s"]);
  });
});

describe("externalInputStacks", () => {
  test("detects stacks declaring a deploy-time parameter", () => {
    const entities = new Map<string, Declarable>([
      ["p", { lexicon: "aws", entityType: "Param", parameterType: "String" } as unknown as Declarable],
      ["r", { lexicon: "k8s", entityType: "Deployment" } as unknown as Declarable],
    ]);
    expect(externalInputStacks(entities)).toEqual(["aws"]);
  });
});

// ── Integration: artifact diff over real builds ──────────────────────────────

describe("affectedStacks — baseDir (caller-supplied)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "chant-affected-it-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const srcDir = (name: string, content: string): string => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "infra.ts"), content);
    return dir;
  };

  test("a value change makes the stack affected", async () => {
    const base = srcDir("base", widget("Widget"));
    const head = srcDir("head", widget("Gadget"));
    const r = await affectedStacks({ projectPath: head, baseDir: base, serializers: [fakeSerializer] });
    expect(r.changed).toEqual(["fake"]);
  });

  test("a no-output-change refactor is NOT affected (deterministic build)", async () => {
    const base = srcDir("base", widget("Widget"));
    // Same declarable, only a comment added — serialized output is identical.
    const head = srcDir("head", "// a harmless refactor\n" + widget("Widget"));
    const r = await affectedStacks({ projectPath: head, baseDir: base, serializers: [fakeSerializer] });
    expect(r.changed).toEqual([]);
  });
});

describe("affectedStacks — baseRef (git worktree)", () => {
  let repo: string;
  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), "chant-affected-git-"));
    const git = (...a: string[]) => execFileAsync("git", a, { cwd: repo });
    await git("init", "-q");
    await git("config", "user.email", "t@t.dev");
    await git("config", "user.name", "t");
    writeFileSync(join(repo, "infra.ts"), widget("Widget"));
    await git("add", "-A");
    await git("commit", "-q", "-m", "base");
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test("diffs the working tree against a base ref via one worktree", async () => {
    // Mutate the working tree (uncommitted) — the head build sees this.
    writeFileSync(join(repo, "infra.ts"), widget("Gadget"));
    const r = await affectedStacks({ projectPath: repo, baseRef: "HEAD", serializers: [fakeSerializer] });
    expect(r.changed).toEqual(["fake"]);
  }, 30_000);
});
