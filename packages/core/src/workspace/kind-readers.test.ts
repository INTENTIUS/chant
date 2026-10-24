/**
 * Members of a package's kind read through a reader project (#2874).
 *
 * The workspace pins a fake lexicon package whose kinds file carries a
 * `graph` block, and its members run under a fake chant installed in the
 * workspace's `node_modules/.bin`. That chant answers `chant graph` in the
 * reader project with one node carrying what it found there: the config
 * chant wrote, whether the lexicon resolves through `node_modules`, and its
 * own directory, so a test can check the project is gone afterwards. The
 * real terraform lexicon runs in `kind-readers.e2e.test.ts`.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, declaration, repo } from "./__fixtures__/contract-repo";
import { workspaceGraph, type GraphDocument } from "./graph-cli";
import { planMembers } from "./member-commands";
import { loadKindRegistry } from "./kinds";
import schema from "./graph.schema.json";

afterAll(cleanScratch);

const { expectValid } = contract(schema);

function result(doc: GraphDocument): Extract<GraphDocument, { nodes: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

/** Prints one node whose attrs hold the reader project's config, whether the lexicon resolves, the argv, and the directory. */
const READER_CHANT = `#!/bin/sh
[ "$1" = graph ] || { echo "Error: Unknown command: $1" >&2; exit 1; }
if [ -f node_modules/@intentius/chant-lexicon-fake/package.json ]; then found=true; else found=false; fi
printf '{"version":1,"nodes":[{"id":"root/Thing","kind":"Thing","lexicon":"fake","attrs":{"found":%s,"pwd":"%s","argv":"%s","config":' "$found" "$(pwd -P)" "$*"
cat chant.config.json
printf '}}],"edges":[],"groups":{"byLexicon":{"fake":["root/Thing"]}}}\\n'
`;

const GRAPH = { lexicon: "fake", config: { moduleRoot: "{workspace}", roots: { "{member}": { dir: "{dir}" } } } };

function lexiconPackage(name: string, kinds: unknown[]): Record<string, string> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({ name, version: "1.0.0", exports: { ".": "./index.js", "./workspace-kinds": "./workspace-kinds.json" } }),
    [`node_modules/${name}/workspace-kinds.json`]: JSON.stringify({ schema: 1, kinds }),
  };
}

const TF_KIND = { name: "tf", description: "a root", precedence: 400, probe: { anyFile: ["*.tf"] }, graph: GRAPH };

function workspace(extra: Record<string, string | { text: string; mode: number }> = {}, pins = [{ package: "@intentius/chant-lexicon-fake", version: "1.0.0" }]): string {
  return repo({
    "chant.workspace.json": declaration(
      [
        { name: "net", dir: "estates/net", kind: "tf" },
        { name: "docs", dir: "docs", kind: "other", because: "prose" },
      ],
      { pins },
    ),
    "estates/net/main.tf": 'module "vpc" { source = "../modules/vpc" }\n',
    "estates/modules/vpc/main.tf": "",
    "docs/README.md": "",
    ".gitignore": "node_modules\n",
    "node_modules/.bin/chant": { text: READER_CHANT, mode: 0o755 },
    ...lexiconPackage("@intentius/chant-lexicon-fake", [TF_KIND]),
    ...extra,
  });
}

describe("workspace graph reads a package kind with a graph block (#2874)", () => {
  test("in a reader project of its own, with the kind's config substituted and the pinned lexicon linked", async () => {
    const root = workspace();
    const { doc, failed } = await workspaceGraph({ cwd: root, args: { env: "prod" } });
    const g = result(doc);
    expectValid(g);
    expect(failed).toBe(false);
    expect(g.members.map((m) => [m.name, m.kind, m.status, m.reason?.code ?? null])).toEqual([
      ["net", "tf", "composed", null],
      ["docs", "other", "skipped", "kind-not-run"],
    ]);
    expect(g.nodes.map((n) => n.id)).toEqual(["net/root/Thing"]);
    const attrs = g.nodes[0].attrs as { found: boolean; pwd: string; argv: string; config: Record<string, unknown> };
    expect(attrs.config).toEqual({ lexicons: ["fake"], fake: { moduleRoot: root, roots: { net: { dir: `${root}/estates/net` } } }, graph: { lint: "report" } });
    expect(attrs.found).toBe(true);
    // A reader project declares no environments, so --env stays with the chant members.
    expect(attrs.argv).toBe("graph . --format ir");
    expect(attrs.pwd.startsWith(root)).toBe(false);
    expect(existsSync(attrs.pwd)).toBe(false);
  });

  test("--at points the reader at the revision's tree", async () => {
    const root = workspace();
    const sha = commitAll(root);
    const g = result((await workspaceGraph({ cwd: root, at: sha })).doc);
    expectValid(g);
    const config = (g.nodes[0].attrs as { config: { fake: { moduleRoot: string; roots: { net: { dir: string } } } } }).config.fake;
    expect(config.moduleRoot).not.toBe(root);
    expect(config.roots.net.dir).toBe(`${config.moduleRoot}/estates/net`);
  });

  test("a lexicon found somewhere other than its pin fails the member with command-failed, and the rest still run", async () => {
    const root = workspace(
      { "plugins/fake/package.json": JSON.stringify({ name: "@intentius/chant-lexicon-fake", version: "1.0.0", exports: { "./workspace-kinds": "./workspace-kinds.json" } }), "plugins/fake/workspace-kinds.json": JSON.stringify({ schema: 1, kinds: [TF_KIND] }) },
      [{ path: "plugins/fake" } as never],
    );
    const { doc, failed } = await workspaceGraph({ cwd: root });
    const g = result(doc);
    expectValid(g);
    expect(failed).toBe(true);
    const net = g.members.find((m) => m.name === "net")!;
    expect(net).toMatchObject({ status: "failed", reason: { code: "command-failed" } });
    expect(net.reason!.message).toMatch(/install the pinned package/);
    expect(g.members.find((m) => m.name === "docs")).toMatchObject({ status: "skipped" });
  });

  test("a member whose directory the kind's probe doesn't claim is kind-probe-failed, and nothing runs", async () => {
    const root = workspace();
    rmSync(join(root, "estates", "net", "main.tf"));
    const g = result((await workspaceGraph({ cwd: root })).doc);
    expect(g.members.find((m) => m.name === "net")).toMatchObject({ status: "failed", reason: { code: "kind-probe-failed" } });
    expect(g.nodes).toEqual([]);
  });

  test("build, lint and audit still skip the kind with kind-not-run", () => {
    const root = workspace();
    const { registry } = loadKindRegistry([{ package: "@intentius/chant-lexicon-fake", version: "1.0.0", path: null }], root);
    for (const verb of ["build", "lint", "audit"] as const) {
      const plan = planMembers(verb, root, { kinds: registry });
      expect(plan.groups).toEqual([]);
      expect(plan.skipped.find((s) => s.name === "net")?.reason.code).toBe("kind-not-run");
    }
    expect(planMembers("graph", root, { kinds: registry }).groups[0].units[0].reader).toMatchObject({ lexicon: "fake" });
  });
});

describe("a graph reader module from a package that is not a lexicon (#4413)", () => {
  /** A fake chant that prints the reader project's config, so the test sees what the member's chant is handed. */
  const MODULE_CHANT = `#!/bin/sh
[ "$1" = graph ] || { echo "Error: Unknown command: $1" >&2; exit 1; }
printf '{"version":1,"nodes":[{"id":"org","kind":"Org","lexicon":"gov","attrs":{"config":'
cat chant.config.json
printf ',"linked":%s}}],"edges":[],"groups":{}}\\n' "$([ -e node_modules ] && echo true || echo false)"
`;

  test("the reader project names the module and links no lexicon", async () => {
    const root = repo({
      "chant.workspace.json": declaration([{ name: "forge", dir: "gov", kind: "gov" }], { pins: [{ package: "@acme/warden", version: "1.0.0" }] }),
      "gov/governance.yml": "org: acme\n",
      ".gitignore": "node_modules\n",
      "node_modules/.bin/chant": { text: MODULE_CHANT, mode: 0o755 },
      "node_modules/@acme/warden/package.json": JSON.stringify({ name: "@acme/warden", version: "1.0.0", exports: { "./workspace-kinds": "./workspace-kinds.json" } }),
      "node_modules/@acme/warden/graph.mjs": "export default () => ({ nodes: [], edges: [] });\n",
      "node_modules/@acme/warden/workspace-kinds.json": JSON.stringify({
        schema: 1,
        kinds: [{ name: "gov", description: "governance", precedence: 500, probe: { anyFile: ["governance.yml"] }, graph: { reader: "graph.mjs", config: { dir: "{dir}" } } }],
      }),
    });
    const { doc, failed } = await workspaceGraph({ cwd: root });
    const g = result(doc);
    expectValid(g);
    expect(failed).toBe(false);
    expect(g.members.map((m) => [m.name, m.status])).toEqual([["forge", "composed"]]);
    const attrs = g.nodes[0].attrs as { config: Record<string, unknown>; linked: boolean };
    expect(attrs.config).toEqual({
      lexicons: [],
      graph: { lint: "report", reader: { module: join(root, "node_modules/@acme/warden/graph.mjs"), config: { dir: `${root}/gov` } } },
    });
    expect(attrs.linked).toBe(false);
  });
});
