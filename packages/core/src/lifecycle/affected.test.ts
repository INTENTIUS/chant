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

// A second lexicon, so a stack that serializes through two of them can be shown
// folding into one artifact.
const fakeSerializer2: Serializer = {
  name: "fake2",
  rulePrefix: "FAKE2",
  serialize: (entities) =>
    JSON.stringify([...entities.keys()].sort().map((k) => ({ k, t: entities.get(k)!.entityType }))),
};

function otherWidget(type: string): string {
  return `export const bar = { lexicon: "fake2", entityType: "${type}", [Symbol.for("chant.declarable")]: true };\n`;
}

function deployTimeParam(): string {
  return `export const p = { lexicon: "fake", entityType: "Param", parameterType: "String", [Symbol.for("chant.declarable")]: true };\n`;
}

describe("affectedStacks — per-stack mode (#2420)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "chant-affected-stacks-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // A project root holding one source directory per stack, as ChantConfig.stacks
  // describes it: { api: <infra.ts contents>, worker: ... }.
  const project = (name: string, sources: Record<string, string>): string => {
    const dir = join(root, name);
    for (const [stack, content] of Object.entries(sources)) {
      mkdirSync(join(dir, stack), { recursive: true });
      writeFileSync(join(dir, stack, "infra.ts"), content);
    }
    return dir;
  };

  const stacks = [
    { name: "api-stack", src: "api" },
    { name: "worker-stack", src: "worker" },
  ];

  test("a stacks[] entry whose src is not there is refused by name at head", async () => {
    const base = project("base", { api: widget("Widget"), worker: widget("Queue") });
    const head = project("head", { api: widget("Gadget") });
    await expect(
      affectedStacks({ projectPath: head, baseDir: base, serializers: [fakeSerializer], stacks }),
    ).rejects.toThrow(/stack "worker-stack" declares src "worker", which does not exist/);
  });

  test("a stack added since base is changed, rather than refused for having no base source", async () => {
    const base = project("base", { api: widget("Widget") });
    const head = project("head", { api: widget("Widget"), worker: widget("Queue") });
    const r = await affectedStacks({ projectPath: head, baseDir: base, serializers: [fakeSerializer], stacks });
    expect(r.changed).toEqual(["worker-stack"]);
  });

  test("names the changed stack, not its lexicon — and leaves the untouched stack out", async () => {
    const base = project("base", { api: widget("Widget"), worker: widget("Queue") });
    const head = project("head", { api: widget("Gadget"), worker: widget("Queue") });
    const r = await affectedStacks({ projectPath: head, baseDir: base, serializers: [fakeSerializer], stacks });
    expect(r.changed).toEqual(["api-stack"]);
    expect(r.changed).not.toContain("fake"); // the lexicon name is not an answer
  });

  test("a no-output-change refactor in the changed stack's own directory is NOT affected", async () => {
    const base = project("base", { api: widget("Widget"), worker: widget("Queue") });
    const head = project("head", { api: "// a harmless refactor\n" + widget("Widget"), worker: widget("Queue") });
    const r = await affectedStacks({ projectPath: head, baseDir: base, serializers: [fakeSerializer], stacks });
    expect(r.changed).toEqual([]);
  });

  test("a stack spanning two lexicons folds into one artifact keyed by the stack", async () => {
    const both = (type: string) => widget("Widget") + otherWidget(type);
    const base = project("base", { api: both("Topic"), worker: widget("Queue") });
    // Only the second lexicon's partition moves; the stack is still what changed.
    const head = project("head", { api: both("Bus"), worker: widget("Queue") });
    const r = await affectedStacks({
      projectPath: head,
      baseDir: base,
      serializers: [fakeSerializer, fakeSerializer2],
      stacks,
    });
    expect(r.changed).toEqual(["api-stack"]);
  });

  test("a deploy-time Parameter is reported as indeterminate under the stack name", async () => {
    const base = project("base", { api: deployTimeParam(), worker: widget("Queue") });
    const head = project("head", { api: deployTimeParam(), worker: widget("Queue") });
    const r = await affectedStacks({ projectPath: head, baseDir: base, serializers: [fakeSerializer], stacks });
    expect(r.indeterminate).toEqual(["api-stack"]);
  });

  test("dependents stay empty — the stack-to-stack relation is not in the build", async () => {
    const base = project("base", { api: widget("Widget"), worker: widget("Queue") });
    const head = project("head", { api: widget("Gadget"), worker: widget("Queue") });
    const r = await affectedStacks({
      projectPath: head,
      baseDir: base,
      serializers: [fakeSerializer],
      stacks,
      includeDependents: true,
    });
    expect(r.changed).toEqual(["api-stack"]);
    expect(r.dependents).toEqual([]);
  });

  test("an empty stacks list keeps the single-root, lexicon-keyed answer", async () => {
    const base = project("base", { api: widget("Widget") });
    const head = project("head", { api: widget("Gadget") });
    const r = await affectedStacks({
      projectPath: join(head, "api"),
      baseDir: join(base, "api"),
      serializers: [fakeSerializer],
      stacks: [],
    });
    expect(r.changed).toEqual(["fake"]);
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
