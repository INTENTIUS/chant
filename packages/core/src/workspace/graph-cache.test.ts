/**
 * The per-member cache behind `chant workspace graph` (#2876, ws-059): a
 * member whose source, install, toolchain, command line and environment are
 * unchanged is answered without starting its chant, and anything else reads.
 *
 * Members run under a fake chant that logs each `graph` it answers, so a test
 * can count the processes a read started. Files are aged past the freshness
 * window before a read that should be stored, since a read of a file younger
 * than the window is never cached.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, declaration, repo } from "./__fixtures__/contract-repo";
import { planMembers } from "./member-commands";
import {
  environmentStamp,
  graphCacheDir,
  isCacheableArgv,
  memberStamp,
  openGraphCache,
  splitCached,
  VOLATILE_ENV,
} from "./graph-cache";
import { workspaceGraph, type GraphDocument } from "./graph-cli";
import schema from "./graph.schema.json";
import type { ParsedArgs } from "../cli/registry";

afterAll(cleanScratch);

const { expectValid } = contract(schema);

function result(doc: GraphDocument): Extract<GraphDocument, { nodes: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

/**
 * A chant older than member-run that logs every `graph` it answers to
 * `<root>/spawns.log`, and touches `race.txt` mid-read when `race` exists.
 */
function loggingChant(root: string): string {
  return `#!/bin/sh
case "$1" in
  graph)
    echo "$PWD" >> "${root}/spawns.log"
    [ -f race ] && echo moved > race.txt
    [ -f fail ] && { echo "Error: broken" >&2; exit 1; }
    printf '{"version":1,"nodes":['
    sep=""
    while read -r id; do printf '%s{"id":"%s","kind":"Thing","lexicon":"fake","attrs":{}}' "$sep" "$id"; sep=","; done < ids.txt
    printf '],"edges":[],"groups":{}}\\n'
    ;;
  *) echo "Error: Unknown command: $1" >&2; exit 1 ;;
esac
`;
}

function workspace(): string {
  const root = repo({
    "chant.workspace.json": declaration([
      { name: "api", dir: "services/api", kind: "chant" },
      { name: "web", dir: "apps/web", kind: "chant" },
    ]),
    "services/api/chant.config.ts": "export default {};\n",
    "services/api/ids.txt": "Queue\n",
    "apps/web/chant.config.ts": "export default {};\n",
    "apps/web/ids.txt": "Site\n",
    ".gitignore": "node_modules\nspawns.log\n",
  });
  repoWrite(root, "node_modules/.bin/chant", loggingChant(root), 0o755);
  age(root);
  return root;
}

function repoWrite(root: string, path: string, text: string, mode?: number): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
  if (mode !== undefined) chmodSync(full, mode);
}

/** Set every file's mtime to one fixed moment long past the freshness window. */
const THEN = new Date("2026-01-01T00:00:00Z");
function age(dir: string): void {
  const then = THEN;
  const walk = (at: string): void => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const path = join(at, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.isFile()) utimesSync(path, then, then);
    }
  };
  walk(dir);
}

function spawns(root: string): string[] {
  const log = join(root, "spawns.log");
  return existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean) : [];
}

describe("the per-member graph cache (#2876)", () => {
  test("an unchanged member is served without starting its chant", async () => {
    const root = workspace();
    const first = result((await workspaceGraph({ cwd: root })).doc);
    expectValid(first);
    expect(first.members.map((m) => [m.name, m.cached])).toEqual([
      ["api", false],
      ["web", false],
    ]);
    expect(spawns(root)).toHaveLength(2);
    expect(readdirSync(graphCacheDir(root))).toHaveLength(2);
    // A read never changes the workspace it reads: the cache lives elsewhere.
    expect(existsSync(join(root, ".chant"))).toBe(false);

    const second = result((await workspaceGraph({ cwd: root })).doc);
    expectValid(second);
    expect(spawns(root)).toHaveLength(2);
    expect(second.members.map((m) => [m.name, m.cached])).toEqual([
      ["api", true],
      ["web", true],
    ]);
    expect(second.nodes).toEqual(first.nodes);
    expect(second.members.map((m) => m.stamp)).toEqual(first.members.map((m) => m.stamp));
    expect(second.members[0].stamp).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("an edit to one member reads that member again, and only it", async () => {
    const root = workspace();
    await workspaceGraph({ cwd: root });
    writeFileSync(join(root, "services", "api", "ids.txt"), "Queue\nTopic\n");
    age(root);
    const g = result((await workspaceGraph({ cwd: root })).doc);
    expect(g.nodes.map((n) => n.id)).toEqual(["api/Queue", "api/Topic", "web/Site"]);
    expect(g.members.map((m) => [m.name, m.cached])).toEqual([
      ["api", false],
      ["web", true],
    ]);
    expect(spawns(root).filter((p) => p.endsWith("services/api"))).toHaveLength(2);
    expect(spawns(root).filter((p) => p.endsWith("apps/web"))).toHaveLength(1);
  });

  test("an install change reads every member again", async () => {
    const root = workspace();
    await workspaceGraph({ cwd: root });
    writeFileSync(join(root, "node_modules", ".package-lock.json"), "{}\n");
    const g = result((await workspaceGraph({ cwd: root })).doc);
    expect(g.members.every((m) => m.cached === false)).toBe(true);
  });

  test("--no-cache reads every member and writes nothing", async () => {
    const root = workspace();
    const g = result((await workspaceGraph({ cwd: root, noCache: true })).doc);
    expect(g.members.every((m) => m.cached === false)).toBe(true);
    expect(existsSync(graphCacheDir(root))).toBe(false);
    await workspaceGraph({ cwd: root });
    await workspaceGraph({ cwd: root, noCache: true });
    expect(spawns(root)).toHaveLength(6);
  });

  test("a read of a file younger than the freshness window is not stored", async () => {
    const root = workspace();
    writeFileSync(join(root, "apps", "web", "ids.txt"), "Site\n");
    await workspaceGraph({ cwd: root });
    const g = result((await workspaceGraph({ cwd: root })).doc);
    expect(g.members.map((m) => [m.name, m.cached])).toEqual([
      ["api", true],
      ["web", false],
    ]);
  });

  test("a stamp that moves during the read is not stored", async () => {
    const root = workspace();
    writeFileSync(join(root, "apps", "web", "race"), "");
    age(root);
    await workspaceGraph({ cwd: root });
    age(root);
    const g = result((await workspaceGraph({ cwd: root })).doc);
    expect(g.members.find((m) => m.name === "web")?.cached).toBe(false);
    expect(g.members.find((m) => m.name === "api")?.cached).toBe(true);
  });

  test("a failed member read is not stored", async () => {
    const root = workspace();
    writeFileSync(join(root, "apps", "web", "fail"), "");
    age(root);
    const one = result((await workspaceGraph({ cwd: root })).doc);
    expect(one.members.find((m) => m.name === "web")).toMatchObject({ status: "failed", reason: { code: "command-failed" } });
    unlinkSync(join(root, "apps", "web", "fail"));
    age(root);
    const two = result((await workspaceGraph({ cwd: root })).doc);
    expect(two.members.find((m) => m.name === "web")).toMatchObject({ status: "composed", cached: false });
    expect(two.members.find((m) => m.name === "api")?.cached).toBe(true);
  });

  test("--at reads are keyed on the commit, so an edit after it still hits", async () => {
    const root = workspace();
    const sha = commitAll(root, "one");
    const first = result((await workspaceGraph({ cwd: root, at: sha })).doc);
    expectValid(first);
    expect(first.members.every((m) => m.cached === false)).toBe(true);
    writeFileSync(join(root, "services", "api", "ids.txt"), "Changed\n");
    const before = spawns(root).length;
    const second = result((await workspaceGraph({ cwd: root, at: sha })).doc);
    expect(spawns(root)).toHaveLength(before);
    expect(second.members.every((m) => m.cached === true)).toBe(true);
    expect(second.nodes.map((n) => n.id)).toEqual(["api/Queue", "web/Site"]);
    // The working tree is its own key.
    const now = result((await workspaceGraph({ cwd: root })).doc);
    expect(now.nodes.map((n) => n.id)).toEqual(["api/Changed", "web/Site"]);
  });

  test("a live command line is never looked up or stamped", () => {
    const root = workspace();
    const plan = planMembers("graph", root);
    const cache = openGraphCache(root);
    const args = {} as ParsedArgs;
    const live = splitCached(plan, args, cache, null, () => ["graph", ".", "--format", "ir", "--live"]);
    expect(live.hits).toEqual([]);
    expect(live.pending.size).toBe(0);
    expect(live.stamps.size).toBe(0);
    const source = splitCached(plan, args, cache, null);
    expect(source.pending.size).toBe(2);
  });
});

describe("the cache's pieces", () => {
  test("only a source read is cacheable", () => {
    expect(isCacheableArgv(["graph", ".", "--format", "ir"])).toBe(true);
    expect(isCacheableArgv(["graph", ".", "--format", "ir", "--env", "prod"])).toBe(true);
    for (const f of ["--live", "--overlay", "--traffic", "--traffic=peak"]) expect(isCacheableArgv(["graph", ".", f])).toBe(false);
  });

  test("the stamp skips node_modules, dist, .git and dot-directories, and member exclusions", () => {
    const root = repo({ "a.ts": "", "sub/b.ts": "", "other/c.ts": "" });
    const base = memberStamp(root, ["other"])!.value;
    for (const path of ["node_modules/x.js", "dist/y.js", ".cache/z", "sub/node_modules/q.js", "other/c.ts"]) {
      repoWrite(root, path, String(Math.random()));
      expect(memberStamp(root, ["other"])!.value, path).toBe(base);
    }
    repoWrite(root, "sub/b.ts", "changed");
    expect(memberStamp(root, ["other"])!.value).not.toBe(base);
    expect(memberStamp(join(root, "missing"))).toBeUndefined();
  });

  test("the environment digest ignores the volatile variables and nothing else", () => {
    const base = { PATH: "/bin", HOME: "/h" };
    const s = environmentStamp(base);
    expect(environmentStamp({ ...base, PWD: "/x", SHLVL: "3", TERM_PROGRAM: "y", npm_config_x: "1" })).toBe(s);
    expect(environmentStamp({ ...base, CHANT_ENV: "prod" })).not.toBe(s);
    expect(VOLATILE_ENV).toContain("PWD");
  });

  test("an entry is written whole: a torn or foreign file is a miss", () => {
    const root = repo({});
    const cache = openGraphCache(root);
    cache.put({ format: 1, key: "k", member: "m", stamp: "s", chant: null, stdout: "{}" });
    expect(cache.get("k")?.stdout).toBe("{}");
    writeFileSync(join(cache.dir, "k.json"), '{"format":1,"key":"k"');
    expect(cache.get("k")).toBeUndefined();
    writeFileSync(join(cache.dir, "j.json"), JSON.stringify({ format: 1, key: "other", stdout: "{}" }));
    expect(cache.get("j")).toBeUndefined();
    expect(readdirSync(cache.dir).some((n) => n.endsWith(".tmp"))).toBe(false);
  });

  test("each workspace has its own directory under the cache dir", () => {
    const a = repo({});
    const b = repo({});
    expect(graphCacheDir(a, { CHANT_CACHE_DIR: "/c" })).toMatch(/^\/c\/workspace-graph\/[0-9a-f]{16}$/);
    expect(graphCacheDir(a, { CHANT_CACHE_DIR: "/c" })).not.toBe(graphCacheDir(b, { CHANT_CACHE_DIR: "/c" }));
    expect(graphCacheDir(a, { XDG_CACHE_HOME: "/x" })).toMatch(/^\/x\/chant\/workspace-graph\//);
    expect(environmentStamp({ PATH: "/bin", CHANT_CACHE_DIR: "/one" })).toBe(environmentStamp({ PATH: "/bin", CHANT_CACHE_DIR: "/two" }));
  });
});

describe("a member read through a kind's reader project (#2874)", () => {
  /** Logs every graph it answers, and prints one node naming the directory it ran in. */
  function readerChant(root: string): string {
    return `#!/bin/sh
[ "$1" = graph ] || { echo "Error: Unknown command: $1" >&2; exit 1; }
echo "$PWD" >> "${root}/spawns.log"
printf '{"version":1,"nodes":[{"id":"root/Thing","kind":"Thing","lexicon":"fake","attrs":{}}],"edges":[],"groups":{}}\\n'
`;
  }

  const KIND = {
    name: "tf",
    description: "a root",
    precedence: 400,
    probe: { anyFile: ["*.tf"] },
    graph: { lexicon: "fake", config: { roots: { "{member}": { dir: "{dir}" } } } },
  };

  function readerWorkspace(): string {
    const root = repo({
      "chant.workspace.json": declaration([{ name: "net", dir: "estates/net", kind: "tf" }], { pins: [{ package: "@intentius/chant-lexicon-fake", version: "1.0.0" }] }),
      "estates/net/main.tf": "",
      ".gitignore": "node_modules\nspawns.log\n",
      "node_modules/@intentius/chant-lexicon-fake/package.json": JSON.stringify({
        name: "@intentius/chant-lexicon-fake",
        version: "1.0.0",
        exports: { ".": "./index.js", "./workspace-kinds": "./workspace-kinds.json" },
      }),
      "node_modules/@intentius/chant-lexicon-fake/workspace-kinds.json": JSON.stringify({ schema: 1, kinds: [KIND] }),
    });
    repoWrite(root, "node_modules/.bin/chant", readerChant(root), 0o755);
    age(root);
    return root;
  }

  test("is cached on the member's own directory, not the temporary reader project", async () => {
    const root = readerWorkspace();
    const first = result((await workspaceGraph({ cwd: root })).doc);
    expectValid(first);
    expect(first.members[0]).toMatchObject({ name: "net", status: "composed", cached: false });
    // It ran in a reader project outside the workspace.
    expect(spawns(root)[0].startsWith(root)).toBe(false);

    const second = result((await workspaceGraph({ cwd: root })).doc);
    expect(second.members[0]).toMatchObject({ cached: true, stamp: first.members[0].stamp });
    expect(spawns(root)).toHaveLength(1);
    expect(second.nodes.map((n) => n.id)).toEqual(["net/root/Thing"]);

    // The stamp is the member's: an edit in its directory reads it again.
    writeFileSync(join(root, "estates", "net", "main.tf"), 'resource "x" "y" {}\n');
    age(root);
    const third = result((await workspaceGraph({ cwd: root })).doc);
    expect(third.members[0].cached).toBe(false);
    expect(third.members[0].stamp).not.toBe(first.members[0].stamp);
  });

  test("a change to the kind's graph block reads the member again", async () => {
    const root = readerWorkspace();
    await workspaceGraph({ cwd: root });
    const kinds = join(root, "node_modules", "@intentius", "chant-lexicon-fake", "workspace-kinds.json");
    writeFileSync(kinds, JSON.stringify({ schema: 1, kinds: [{ ...KIND, graph: { lexicon: "fake", config: { callModuleType: "none", roots: { "{member}": { dir: "{dir}" } } } } }] }));
    const g = result((await workspaceGraph({ cwd: root })).doc);
    expect(g.members[0].cached).toBe(false);
    expect(spawns(root)).toHaveLength(2);
  });
});
