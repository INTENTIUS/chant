/**
 * #3146, ws-077: the factory and listing on a box block, the protected paths
 * in writeScope, and whether a workspace is plantable.
 *
 * The declaration reads the fields with their defaults filled in, and a
 * factory that names an undeclared member, or a second factory, fails the
 * read (declaration-invalid, so check fails with WSP001). Everything is
 * opt-in: a records-only workspace and an infra workspace that declares a
 * factory with no box services both read and check cleanly. `status --json`
 * and `graph --json` print the factory, the listing (with the cover's hash)
 * and `plantable`; `check --changes` reports a write to a protected path with
 * write-scope-protected, unless the entry's except allows the change.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, git, repo, writeFiles } from "./__fixtures__/contract-repo";
import { agentSession } from "./agent-cli";
import agentSchema from "./agent.schema.json";
import { plantability } from "./box-factory";
import { checkChanges, type ChangesDocument } from "./changes";
import changesSchema from "./changes.schema.json";
import { runDeclarationChecks } from "./checks";
import { parseDeclaration, WorkspaceReadError, type Declaration } from "./declaration";
import { workspaceGraph } from "./graph-cli";
import graphSchema from "./graph.schema.json";
import { workspaceStatus } from "./status";
import statusSchema from "./status.schema.json";
import { judgePath, onlyKeysChanged, protectedEntry, resolveWriter } from "./write-scope";
import { emptyPolicy } from "./trust/policy";

afterAll(cleanScratch);

type Json = Record<string, unknown>;

const FACTORY = {
  builds: ["studio"],
  check: "npm run --silent check && npm test --silent",
  checks: "checks",
  builders: "steward",
  publish: { repo: "arugula-salad/studio", branchPrefix: "box/" },
};

const SERVICES = [{ name: "app", cmd: "node app.mjs", health: "http://127.0.0.1:5173/health" }];

function declaration(over: { box?: Json; members?: Json[]; writeScope?: Json; agents?: Json[] } = {}): Json {
  return {
    name: "studio",
    schema: 1,
    members: over.members ?? [
      { name: "studio", dir: ".", kind: "other", because: "the repo itself" },
      { name: "steward", dir: "steward", kind: "other", because: "the box's steward", box: over.box ?? { services: SERVICES, factory: FACTORY } },
    ],
    ...(over.writeScope ? { writeScope: over.writeScope } : {}),
    ...(over.agents ? { agents: over.agents } : {}),
  };
}

const parse = (doc: Json): Declaration => parseDeclaration(JSON.stringify(doc, null, 2), "chant.workspace.json");

/** The error a declaration's read fails with, and the line of the file it points at. */
function readFailure(doc: Json): { code: string; message: string; at: string | undefined } {
  const text = JSON.stringify(doc, null, 2);
  try {
    parseDeclaration(text, "chant.workspace.json");
  } catch (err) {
    if (err instanceof WorkspaceReadError) return { code: err.code, message: err.message, at: err.location ? text.split("\n")[err.location.line - 1]?.trim() : undefined };
    throw err;
  }
  throw new Error("the declaration read");
}

describe("the factory on a box block (#3146)", () => {
  test("reads with its defaults filled in", () => {
    const box = parse(declaration()).members[1].box!;
    expect(box.factory).toEqual({
      builds: ["studio"],
      check: { run: "npm run --silent check && npm test --silent", kind: "test" },
      checks: "checks",
      builders: "steward",
      tiers: [],
      publish: { forge: "github", repo: "arugula-salad/studio", base: null, branchPrefix: "box/", head: null },
      pointer: "/members/1/box/factory",
    });
    expect(box.listing).toBeNull();
  });

  test("a check says what it is, a publish target names a base and a fork, and the branch prefix defaults to the work branch", () => {
    const f = parse(
      declaration({
        box: { factory: { builds: ["studio", "steward"], check: { run: "chant build && chant lint", kind: "lint" }, publish: { repo: "acme/infra", base: "main", head: "alex/infra" } } },
      }),
    ).members[1].box!.factory!;
    expect(f.builds).toEqual(["studio", "steward"]);
    expect(f.check).toEqual({ run: "chant build && chant lint", kind: "lint" });
    expect(f.publish).toEqual({ forge: "github", repo: "acme/infra", base: "main", branchPrefix: "chant/work/", head: "alex/infra" });
    expect(f.checks).toBeNull();
    expect(f.builders).toBeNull();
  });

  test("builds must name a declared member", () => {
    const failure = readFailure(declaration({ box: { factory: { builds: ["app"] } } }));
    expect(failure.code).toBe("declaration-invalid");
    expect(failure.message).toContain('the factory builds "app", which is not a declared member');
    expect(failure.at).toBe('"app"');
  });

  test("builders must name a declared member", () => {
    const failure = readFailure(declaration({ box: { factory: { builds: ["studio"], builders: "delivery" } } }));
    expect(failure.message).toContain('the factory\'s builders names "delivery"');
    expect(failure.at).toBe('"builders": "delivery"');
  });

  test("a workspace has one factory", () => {
    const failure = readFailure(
      declaration({
        members: [
          { name: "a", dir: "a", kind: "other", because: "a", box: { factory: { builds: ["a"] } } },
          { name: "b", dir: "b", kind: "other", because: "b", box: { factory: { builds: ["b"] } } },
        ],
      }),
    );
    expect(failure.message).toContain("members a and b both declare a factory");
    expect(failure.at).toBe('"factory": {');
  });

  test("the schema refuses a factory without builds, an unknown check kind, a bad repo and an unknown field", () => {
    expect(readFailure(declaration({ box: { factory: {} } })).code).toBe("declaration-invalid");
    expect(readFailure(declaration({ box: { factory: { builds: ["studio"], check: { run: "x", kind: "smoke" } } } })).code).toBe("declaration-invalid");
    expect(readFailure(declaration({ box: { factory: { builds: ["studio"], publish: { repo: "not a repo" } } } })).code).toBe("declaration-invalid");
    expect(readFailure(declaration({ box: { factory: { builds: ["studio"], app: "studio" } } })).message).toContain('unknown field "app"');
    // An x- field is still allowed, so a runtime can carry its own knobs beside chant's.
    expect(parse(declaration({ box: { factory: { builds: ["studio"], "x-studio": { budget: 3 } } } })).members[1].box!.factory!.builds).toEqual(["studio"]);
  });
});

describe("the listing on a box block (#3146)", () => {
  test("reads with its defaults: listed, empty title and line, no cover", () => {
    expect(parse(declaration({ box: { listing: {} } })).members[1].box!.listing).toEqual({ published: true, title: "", line: "", cover: null });
    expect(parse(declaration({ box: { listing: { published: false, title: "Fern", line: "A garden planner", cover: "steward/cover.png" } } })).members[1].box!.listing).toEqual({
      published: false,
      title: "Fern",
      line: "A garden planner",
      cover: "steward/cover.png",
    });
  });

  test("a title over 60 characters, a line over 140 and a control character are refused", () => {
    expect(readFailure(declaration({ box: { listing: { title: "x".repeat(61) } } })).code).toBe("declaration-invalid");
    expect(readFailure(declaration({ box: { listing: { line: "x".repeat(141) } } })).code).toBe("declaration-invalid");
    expect(readFailure(declaration({ box: { listing: { title: "two\nlines" } } })).code).toBe("declaration-invalid");
  });
});

describe("plantable (#3146)", () => {
  test("exactly one member's box block declares services", () => {
    expect(plantability(parse(declaration()))).toEqual({ plantable: true, box: "steward", reason: null });
  });

  test("an infra workspace with a factory and no box services reads and checks cleanly, and isn't plantable (#3174)", async () => {
    const doc = declaration({
      members: [
        { name: "estate", dir: "estate", kind: "other", because: "terraform" },
        { name: "ops", dir: "ops", kind: "other", because: "the steward", box: { factory: { builds: ["estate"], check: { run: "terraform plan", kind: "plan" }, publish: { repo: "acme/estate" } } } },
      ],
    });
    const d = parse(doc);
    expect(plantability(d)).toMatchObject({ plantable: false, box: null, reason: { code: "box-none" } });
    const root = repo({ "chant.workspace.json": JSON.stringify(doc), "estate/main.tf": "", "ops/README.md": "" });
    const { diagnostics } = await runDeclarationChecks(root);
    expect(diagnostics.filter((x) => x.severity === "error")).toEqual([]);
  });

  test("a records-only workspace isn't plantable, and two boxes with services aren't either", () => {
    expect(plantability(parse({ name: "notes", schema: 1, members: [] }))).toMatchObject({ plantable: false, reason: { code: "box-none" } });
    const two = declaration({
      members: [
        { name: "a", dir: "a", kind: "other", because: "a", box: { services: SERVICES } },
        { name: "b", dir: "b", kind: "other", because: "b", box: { services: SERVICES } },
      ],
    });
    expect(plantability(parse(two))).toMatchObject({ plantable: false, box: null, reason: { code: "box-several", message: expect.stringContaining("a, b") } });
  });
});

describe("protected paths in writeScope (#3146)", () => {
  const scope = {
    agent: {
      protected: ["ops", "decisions/**", { path: "chant.workspace.json", except: ["diagrams"] }],
    },
  };
  const d = parse(declaration({ writeScope: scope, agents: [{ name: "builder", member: "studio" }] }));
  const writer = resolveWriter(d, emptyPolicy(null), { agent: "builder" });

  test("read in file order, with except empty for a glob", () => {
    expect(d.writeScope!.agent!.protected).toEqual([
      { path: "ops", except: [] },
      { path: "decisions/**", except: [] },
      { path: "chant.workspace.json", except: ["diagrams"] },
    ]);
  });

  test("an entry covers the files it matches and everything under a directory it matches", () => {
    expect(protectedEntry(d.writeScope!.agent!.protected, "ops/factory/guard.mjs")?.path).toBe("ops");
    expect(protectedEntry(d.writeScope!.agent!.protected, "decisions/ws-001.md")?.path).toBe("decisions/**");
    expect(protectedEntry(d.writeScope!.agent!.protected, "opsy.md")).toBeNull();
  });

  test("a write to a protected path is out of scope, even in the session's own member", () => {
    expect(judgePath(d, writer, "src/server.mjs")).toEqual({ ok: true });
    expect(judgePath(d, writer, "ops/factory/guard.mjs")).toMatchObject({ ok: false, code: "write-scope-protected", message: expect.stringContaining("writeScope.agent.protected lists ops") });
  });

  test("except lets a JSON file change only in the keys it names", () => {
    const before = JSON.stringify({ name: "studio", diagrams: [] });
    const onlyDiagrams = JSON.stringify({ name: "studio", diagrams: [{ name: "flow" }] });
    const alsoName = JSON.stringify({ name: "other", diagrams: [{ name: "flow" }] });
    expect(onlyKeysChanged(before, onlyDiagrams, ["diagrams"])).toBe(true);
    expect(onlyKeysChanged(before, alsoName, ["diagrams"])).toBe(false);
    expect(onlyKeysChanged(null, onlyDiagrams, ["diagrams"])).toBe(false);
    expect(onlyKeysChanged("not json", onlyDiagrams, ["diagrams"])).toBe(false);
    expect(judgePath(d, writer, "chant.workspace.json", { before: () => before, after: () => onlyDiagrams })).toEqual({ ok: true });
    expect(judgePath(d, writer, "chant.workspace.json", { before: () => before, after: () => alsoName })).toMatchObject({
      ok: false,
      code: "write-scope-protected",
      message: expect.stringContaining("outside what its except allows (diagrams)"),
    });
    // Without the change in hand, an except entry can't be satisfied.
    expect(judgePath(d, writer, "chant.workspace.json")).toMatchObject({ ok: false, code: "write-scope-protected" });
  });
});

describe("the read contract: status, graph, agent and check --changes (#3146)", () => {
  const status = contract(statusSchema);
  const graph = contract(graphSchema);
  const agent = contract(agentSchema);
  const changes = contract(changesSchema);
  const cover = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const doc = declaration({
    box: { services: SERVICES, factory: FACTORY, listing: { title: "Studio", line: "Where boxes are planted", cover: "steward/cover.png" } },
    writeScope: { agent: { protected: ["ops", { path: "chant.workspace.json", except: ["diagrams"] }] } },
    agents: [{ name: "builder", member: "studio" }],
  });
  let root: string;

  beforeAll(() => {
    root = repo({ "chant.workspace.json": `${JSON.stringify(doc, null, 2)}\n`, "steward/README.md": "the steward\n", "ops/guard.mjs": "export {};\n", "server.mjs": "export {};\n" });
    writeFileSync(`${root}/steward/cover.png`, cover);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "the workspace");
    git(root, "branch", "-M", "main");
  });

  test("status --json prints the factory, the listing with the cover's hash, and plantable", async () => {
    const out = await workspaceStatus({ cwd: root, env: "prod" });
    status.expectValid(out);
    if ("error" in out) throw new Error(out.error.message);
    expect(out.plantable).toEqual({ plantable: true, box: "steward", reason: null });
    const box = out.members.find((m) => m.name === "steward")!.box!;
    expect(box.factory).toEqual({
      builds: ["studio"],
      check: { run: "npm run --silent check && npm test --silent", kind: "test" },
      checks: "checks",
      builders: "steward",
      tiers: [],
      builderFor: { studio: {} },
      publish: { forge: "github", repo: "arugula-salad/studio", base: null, branchPrefix: "box/", head: null },
    });
    expect(box.listing).toEqual({
      published: true,
      title: "Studio",
      line: "Where boxes are planted",
      cover: { path: "steward/cover.png", sha256: createHash("sha256").update(cover).digest("hex") },
    });
  });

  test("graph --json prints them too, at a revision with --at", async () => {
    const head = git(root, "rev-parse", "HEAD");
    for (const at of [undefined, head]) {
      const { doc: out } = await workspaceGraph({ cwd: root, at });
      graph.expectValid(out);
      if ("error" in out) throw new Error(out.error.message);
      expect(out.plantable).toMatchObject({ plantable: true, box: "steward" });
      const byName = Object.fromEntries(out.members.map((m) => [m.name, m.box]));
      expect(byName.studio).toBeNull();
      expect(byName.steward?.factory?.builds).toEqual(["studio"]);
      expect(byName.steward?.listing?.cover?.sha256).toBe(createHash("sha256").update(cover).digest("hex"));
    }
  });

  test("workspace agent lists the protected paths", async () => {
    const out = await agentSession({ cwd: root, name: "builder" });
    agent.expectValid(out);
    if ("error" in out) throw new Error(out.error.message);
    expect(out.scope.protected).toEqual([
      { path: "ops", except: [] },
      { path: "chant.workspace.json", except: ["diagrams"] },
    ]);
  });

  test("check --changes reports a write to a protected path, and lets an excepted key change", async () => {
    git(root, "checkout", "-q", "-b", "work");
    const trailer = "\n\nChant-Agent: builder";
    writeFiles(root, { "server.mjs": "export const port = 1;\n" });
    const ok = commitAll(root, `app: a port${trailer}`);
    writeFiles(root, { "chant.workspace.json": `${JSON.stringify({ ...doc, diagrams: [] }, null, 2)}\n` });
    const excepted = commitAll(root, `a diagram${trailer}`);
    writeFiles(root, { "ops/guard.mjs": "export const off = true;\n" });
    const guard = commitAll(root, `the steward${trailer}`);
    writeFiles(root, { "chant.workspace.json": `${JSON.stringify({ ...doc, name: "renamed", diagrams: [] }, null, 2)}\n` });
    const renamed = commitAll(root, `rename${trailer}`);
    const { doc: out } = (await checkChanges({ cwd: root, range: "main..work" })) as { doc: Exclude<ChangesDocument, { error: unknown }> };
    changes.expectValid(out);
    const found = out.scope!.findings.map((f) => [f.commit, f.code, f.path]);
    expect(found).toEqual([
      [guard, "write-scope-protected", "ops/guard.mjs"],
      [renamed, "write-scope-protected", "chant.workspace.json"],
    ]);
    expect(found.map(([c]) => c)).not.toContain(ok);
    expect(found.map(([c]) => c)).not.toContain(excepted);
  });
});
