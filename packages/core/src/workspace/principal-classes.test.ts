/**
 * Principal classes a plugin supplies (#3080, ws-079): the data file, the
 * registry, and how a principal's role grants at base put it in a class.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, scratchDir } from "./__fixtures__/contract-repo";
import {
  CLASS_NAME,
  classesOf,
  coreClassRegistry,
  loadClassRegistry,
  parseClassData,
  principalClass,
  PRINCIPALS_SCHEMA_ID,
  readPackageClasses,
  treeFiles,
  unknownScopeClasses,
} from "./principal-classes";
import { emptyPolicy } from "./trust/policy";
import type { WorkspaceTree } from "./tree";

afterAll(cleanScratch);

const data = (classes: unknown[]) => JSON.stringify({ schema: 1, classes });
const reviewer = { name: "reviewer", description: "people who review decisions", role: "reviewer" };
const operator = { name: "operator", description: "people who apply infrastructure", role: "ops" };

/** A plugin package directory on disk, publishing `classes` at ./workspace-principals. */
function plugin(root: string, dir: string, classes: unknown[], pkg: Record<string, unknown> = {}): void {
  const abs = join(root, ...dir.split("/"));
  mkdirSync(abs, { recursive: true });
  writeFileSync(join(abs, "package.json"), JSON.stringify({ name: dir.replace(/\//g, "-"), version: "1.0.0", exports: { "./workspace-principals": "./principals.json" }, ...pkg }));
  writeFileSync(join(abs, "principals.json"), data(classes));
}

describe("the principals file", () => {
  test("has a versioned schema id and a name grammar shared with writeScope", () => {
    expect(PRINCIPALS_SCHEMA_ID).toBe("https://intentius.io/chant/schemas/workspace/principals/v1/workspace-principals.schema.json");
    expect(CLASS_NAME.test("reviewer")).toBe(true);
    expect(CLASS_NAME.test("x-reviewer")).toBe(false);
    expect(CLASS_NAME.test("Reviewer")).toBe(false);
  });

  test("a valid file yields its classes in file order, with the pin as source", () => {
    expect(parseClassData(data([reviewer, operator]), "plugins/review")).toEqual({
      classes: [
        { ...reviewer, source: "plugins/review" },
        { ...operator, source: "plugins/review" },
      ],
      problems: [],
    });
  });

  test.each([
    ["not JSON", "{", /not JSON/],
    ["a missing role", data([{ name: "reviewer", description: "d" }]), /role/],
    ["an unknown field", data([{ ...reviewer, members: ["app"] }]), /additional properties/],
    ["an x- name", data([{ ...reviewer, name: "x-reviewer" }]), /pattern/],
  ])("refuses %s", (_, text, message) => {
    const read = parseClassData(text, "p");
    expect(read.classes).toEqual([]);
    expect(read.problems.join("\n")).toMatch(message);
  });

  test("leaves out a core name, a core role, a name twice and a role twice, keeping the rest", () => {
    const read = parseClassData(
      data([
        { name: "human", description: "d", role: "people" },
        { name: "bots", description: "d", role: "agent" },
        reviewer,
        { ...reviewer, role: "other" },
        { name: "checker", description: "d", role: "reviewer" },
        operator,
      ]),
      "p",
    );
    expect(read.classes.map((c) => c.name)).toEqual(["reviewer", "operator"]);
    expect(read.problems).toEqual([
      "p: class human is a core class and can't be supplied by a package",
      "p: class bots names the role agent, which puts a principal in the core agent class",
      "p: class reviewer is listed twice",
      "p: class checker names the role reviewer, which another class in the file names; a role puts a principal in one class",
    ]);
  });
});

describe("reading a package's classes", () => {
  test("a package exporting no ./workspace-principals supplies none, without a problem", () => {
    const root = scratchDir();
    plugin(root, "kinds-only", [reviewer], { exports: { "./workspace-kinds": "./kinds.json" } });
    expect(loadClassRegistry([{ package: null, version: null, path: "kinds-only" }], root)).toMatchObject({ problems: [] });
  });

  test("the export must name a JSON file inside the package", () => {
    const files = (pkg: object) => (p: string) => (p === "package.json" ? JSON.stringify(pkg) : undefined);
    expect(readPackageClasses(files({ exports: { "./workspace-principals": "./index.js" } }), "p").problems[0]).toMatch(/must name a .json file/);
    expect(readPackageClasses(files({ exports: { "./workspace-principals": "./../x.json" } }), "p").problems[0]).toMatch(/points outside the package/);
    expect(readPackageClasses(files({ exports: { "./workspace-principals": "./gone.json" } }), "p").problems[0]).toMatch(/does not exist/);
  });

  test("a path pin is read through a tree when one is given, such as the base revision", () => {
    const files: Record<string, string> = {
      "plugins/review/package.json": JSON.stringify({ exports: { "./workspace-principals": "./principals.json" } }),
      "plugins/review/principals.json": data([reviewer]),
    };
    const tree: WorkspaceTree = {
      label: " at base",
      stat: (p) => (p in files ? "file" : undefined),
      list: () => undefined,
      read: (p) => files[p],
    };
    expect(readPackageClasses(treeFiles(tree, "plugins/review"), "plugins/review").classes.map((c) => c.name)).toEqual(["reviewer"]);
    // The working tree is not consulted: nothing exists on disk at this root.
    const loaded = loadClassRegistry([{ package: null, version: null, path: "plugins/review" }], "/nonexistent", { tree });
    expect(loaded.problems).toEqual([]);
    expect(loaded.registry.names()).toEqual(["human", "agent", "runner", "service", "reviewer"]);
  });

  test("a class name or a role two pins supply is left out, with a problem on the second pin", () => {
    const root = scratchDir();
    plugin(root, "a", [reviewer, operator]);
    plugin(root, "b", [{ ...reviewer, role: "approver" }]);
    plugin(root, "c", [{ name: "applier", description: "d", role: "ops" }]);
    const pins = ["a", "b", "c"].map((path) => ({ package: null, version: null, path }));
    const { registry, problems } = loadClassRegistry(pins, root);
    expect(registry.names()).toEqual(["human", "agent", "runner", "service"]);
    expect(problems).toEqual([
      { pin: 1, message: "class reviewer is supplied by both a and b; a class name has one source" },
      { pin: 2, message: "class applier (c) names the role ops, which class operator (a) names; a role puts a principal in one class" },
    ]);
  });

  test("a package pin that is not installed is a problem, and a pin naming neither is skipped", () => {
    const root = scratchDir();
    const { problems } = loadClassRegistry(
      [
        { package: "absent", version: "1.0.0", path: null },
        { package: null, version: null, path: null },
      ],
      root,
    );
    expect(problems).toEqual([{ pin: 0, message: "pinned package absent is not installed; install it to read the kinds it supplies" }]);
  });
});

describe("a principal's classes", () => {
  const root = scratchDir();
  plugin(root, "review", [reviewer, operator]);
  const { registry } = loadClassRegistry([{ package: null, version: null, path: "review" }], root);
  const policy = { ...emptyPolicy("x"), roles: { reviewer: ["Rev@example.com", "ci@example.com"], ops: ["rev@example.com"], runner: ["ci@example.com"] } };

  test("come from role grants at base, core first, then the domain classes in order", () => {
    expect(classesOf(registry, policy, "rev@example.com")).toEqual(["reviewer", "operator"]);
    expect(classesOf(registry, policy, "ci@example.com")).toEqual(["runner", "reviewer"]);
    expect(classesOf(registry, policy, "lex00")).toEqual([]);
    expect(classesOf(registry, policy, null)).toEqual([]);
  });

  test("write scope judges a principal by the first, and human is the rest", () => {
    expect(principalClass(policy, "rev@example.com", registry)).toBe("reviewer");
    expect(principalClass(policy, "ci@example.com", registry)).toBe("runner");
    expect(principalClass(policy, "lex00", registry)).toBe("human");
    // Without the plugin's classes, a domain principal is a human (the behaviour before #3080).
    expect(principalClass(policy, "rev@example.com")).toBe("human");
  });

  test("a writeScope key no class has is unknown", () => {
    expect(unknownScopeClasses({ human: {}, reviewer: {}, auditor: {} }, registry)).toEqual(["auditor"]);
    expect(unknownScopeClasses({ reviewer: {} }, coreClassRegistry())).toEqual(["reviewer"]);
    expect(unknownScopeClasses(null, registry)).toEqual([]);
  });
});
