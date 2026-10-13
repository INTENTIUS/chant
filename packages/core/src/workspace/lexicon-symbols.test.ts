/**
 * Symbol resolvers from a member's lexicon (#3313): `graph --intent
 * path#symbol` on a file in a member whose lexicon exports a resolver.
 *
 * The workspace has a chant member `db` whose chant.config.json declares a
 * lexicon by module path, `lexicon/plugin.mjs`, which resolves `create table`
 * and `create function` statements in `.sql` files. A loader stands in for
 * the plugin in the unit cases; one case loads the module path the way any
 * command does.
 */

import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, repo } from "./__fixtures__/contract-repo";
import { intentGraph, type IntentDocument, type RegionNode } from "./intent";
import intentSchema from "./intent.schema.json";
import { memberSymbolResolvers, type SymbolPluginLoader } from "./lexicon-symbols";
import { resolveSymbol, type SymbolDeclaration, type SymbolResolver } from "./symbols";

afterAll(cleanScratch);

const intent = contract(intentSchema);

/** A tiny SQL resolver: each `create table|function <name>` up to the line ending in `;`. */
const SQL_RESOLVER_SOURCE = `
export const sqlResolver = {
  language: "SQL",
  extensions: [".sql"],
  declarations(path, text) {
    const lines = text.split("\\n");
    const out = [];
    lines.forEach((line, i) => {
      const m = /^create\\s+(table|function)\\s+([a-z_.]+)/i.exec(line);
      if (!m) return;
      let end = i;
      while (end < lines.length - 1 && !lines[end].trimEnd().endsWith(";")) end++;
      out.push({ qualified: m[2], kind: m[1].toLowerCase(), lines: { start: i + 1, end: end + 1 } });
    });
    return out;
  },
};
`;

const PLUGIN = `${SQL_RESOLVER_SOURCE}
export const plugin = {
  name: "sqlish",
  serializer: { name: "sqlish", rulePrefix: "SQI", serialize: () => "" },
  async generate() {},
  async validate() {},
  async coverage() {},
  async package() {},
  symbolResolvers: () => [sqlResolver],
};
`;

const SCHEMA = ["-- the app's schema", "create table app.users (", "  id int primary key", ");", "", "create function app.touch()", "  returns void as $$ select 1 $$ language sql;", ""].join("\n");

async function sqlResolver(): Promise<SymbolResolver> {
  const mod = (await import(`data:text/javascript,${encodeURIComponent(SQL_RESOLVER_SOURCE)}`)) as { sqlResolver: SymbolResolver };
  return mod.sqlResolver;
}

function workspace(): string {
  const root = repo(
    {
      "chant.workspace.json": `${JSON.stringify({
        name: "demo",
        schema: 1,
        members: [
          { name: "db", dir: "db", kind: "chant" },
          { name: "notes", dir: "notes", kind: "other", because: "prose" },
        ],
      })}\n`,
      "db/chant.config.json": `${JSON.stringify({ lexicons: [{ name: "sqlish", module: "../lexicon/plugin.mjs" }] })}\n`,
      "db/schema.sql": SCHEMA,
      "db/main.ts": "export const x = 1;\n",
      "lexicon/plugin.mjs": PLUGIN,
      "notes/schema.sql": SCHEMA,
    },
    true,
  );
  git(root, "branch", "-M", "main");
  return root;
}

const region = (doc: IntentDocument) => {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc.nodes.find((n) => n.kind === "region") as RegionNode;
};

describe("a lexicon's symbol resolvers (#3313)", () => {
  test("resolveSymbol uses an extra resolver for its extensions, and core's for .ts", async () => {
    const sql = await sqlResolver();
    expect(resolveSymbol("db/schema.sql", SCHEMA, "app.users", [sql])).toEqual({ ok: true, declaration: { qualified: "app.users", kind: "table", lines: { start: 2, end: 4 } } });
    expect(resolveSymbol("db/schema.sql", SCHEMA, "users", [sql])).toMatchObject({ ok: true, declaration: { qualified: "app.users" } });
    expect(resolveSymbol("db/schema.sql", SCHEMA, "app.users")).toMatchObject({ ok: false, reason: "unsupported" });
    // A lexicon's resolver never takes .ts from core's.
    const greedy: SymbolResolver = { language: "greedy", extensions: [".ts"], declarations: (): SymbolDeclaration[] => [{ qualified: "x", kind: "lie", lines: { start: 9, end: 9 } }] };
    expect(resolveSymbol("a.ts", "export const x = 1;\n", "x", [greedy])).toMatchObject({ ok: true, declaration: { kind: "variable", lines: { start: 1, end: 1 } } });
  });

  test("graph --intent path#symbol resolves through the member's lexicon", async () => {
    const root = workspace();
    const sql = await sqlResolver();
    const load: SymbolPluginLoader = async (name) => {
      expect(name).toBe("sqlish");
      return { name, symbolResolvers: () => [sql] };
    };
    const { doc } = await intentGraph({ cwd: root, region: "db/schema.sql#app.touch", loadLexicon: load });
    intent.expectValid(doc);
    expect(region(doc)).toMatchObject({ path: "db/schema.sql", lines: { start: 6, end: 7 }, member: "db", symbol: { name: "app.touch", qualified: "app.touch", kind: "function" } });
  });

  test("loads the lexicon the member's config declares, by module path, as any command does", async () => {
    const root = workspace();
    const { doc } = await intentGraph({ cwd: root, region: "db/schema.sql#app.users" });
    intent.expectValid(doc);
    expect(region(doc)).toMatchObject({ lines: { start: 2, end: 4 }, symbol: { qualified: "app.users", kind: "table" } });
  });

  test("a file in a member with no such lexicon, or whose lexicon fails, stays intent-symbol-unsupported and says why", async () => {
    const root = workspace();
    const other = await intentGraph({ cwd: root, region: "notes/schema.sql#app.users" });
    intent.expectValid(other.doc);
    expect("error" in other.doc && other.doc.error.code).toBe("intent-symbol-unsupported");
    const broken = await intentGraph({
      cwd: root,
      region: "db/schema.sql#app.users",
      loadLexicon: async () => {
        throw new Error("Cannot find package");
      },
    });
    expect("error" in broken.doc && broken.doc.error).toMatchObject({ code: "intent-symbol-unsupported", message: expect.stringContaining('lexicon "sqlish" could not be loaded: Cannot find package') });
  });

  test("a malformed resolver or bad declarations are dropped, not read as lines", async () => {
    const root = workspace();
    const got = await memberSymbolResolvers(join(root, "db"), async () => ({
      symbolResolvers: () => [
        { language: "bad", extensions: ["sql"], declarations: () => [] },
        { language: "ok", extensions: [".sql"], declarations: () => [{ qualified: "t", kind: "table", lines: { start: 3, end: 1 } }, { qualified: "u", kind: "table", lines: { start: 1, end: 2 } }] },
      ],
    }));
    expect(got.problems).toEqual([expect.stringContaining("not { language, extensions")]);
    expect(got.resolvers).toHaveLength(1);
    expect(got.resolvers[0].declarations("x.sql", "")).toEqual([{ qualified: "u", kind: "table", lines: { start: 1, end: 2 } }]);
  });
});
