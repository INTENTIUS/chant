/**
 * The links `chant migrate` writes into a workspace declaration (#4399):
 * which members are the producer and the consumer, that the edit touches only
 * the consumer's `links`, that a second run adds nothing, and that every case
 * with nothing to link says why.
 */
import { afterAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseDeclaration } from "./declaration";
import { planMigrateLinks } from "./migrate-links";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function repo(declaration: string, file = "chant.workspace.json"): string {
  const root = mkdtempSync(join(tmpdir(), "chant-migrate-links-"));
  scratch.push(root);
  for (const [path, text] of Object.entries({ [file]: declaration, "db/schema.sql": "", "mirror/mirrors.ts": "", "other/x.ts": "" })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const decl = (members: unknown[]) => `${JSON.stringify({ name: "shop", schema: 1, members }, null, 2)}\n`;
const MEMBERS = [
  { name: "db", dir: "db", kind: "chant" },
  { name: "mirror", dir: "mirror", kind: "chant" },
];
const outputs = ["public.users.id", "public.users.email"];

describe("planMigrateLinks", () => {
  test("adds one link per output to the member holding the output file, and changes nothing else", () => {
    const root = repo(decl(MEMBERS));
    const r = planMigrateLinks({ sourcePath: join(root, "db/schema.sql"), outputPath: join(root, "mirror/mirrors.ts"), outputs });
    if (!r || !("plan" in r)) throw new Error(JSON.stringify(r));
    expect(r.plan).toMatchObject({ producer: "db", consumer: "mirror", added: outputs });
    const members = parseDeclaration(r.plan.text, "chant.workspace.json").members;
    expect(members.find((m) => m.name === "mirror")!.links.map((l) => `${l.member} ${l.output}`)).toEqual(outputs.map((o) => `db ${o}`));
    expect(members.find((m) => m.name === "db")!.links).toEqual([]);
    expect(r.plan.text.startsWith('{\n  "name": "shop"')).toBe(true);
  });

  test("keeps the links already there and adds only the new ones; a second plan adds nothing", () => {
    const root = repo(decl([MEMBERS[0], { ...MEMBERS[1], links: [{ member: "db", output: "public.users.id" }, { member: "other", output: "x" }] }, { name: "other", dir: "other", kind: "chant" }]));
    const r = planMigrateLinks({ sourcePath: join(root, "db"), outputPath: join(root, "mirror/mirrors.ts"), outputs });
    if (!r || !("plan" in r)) throw new Error(JSON.stringify(r));
    expect(r.plan.added).toEqual(["public.users.email"]);
    const links = parseDeclaration(r.plan.text, "x.json").members.find((m) => m.name === "mirror")!.links;
    expect(links.map((l) => `${l.member} ${l.output}`)).toEqual(["db public.users.id", "other x", "db public.users.email"]);
    writeFileSync(join(root, "chant.workspace.json"), r.plan.text);
    const again = planMigrateLinks({ sourcePath: join(root, "db"), outputPath: join(root, "mirror/mirrors.ts"), outputs });
    expect(again).toMatchObject({ plan: { added: [] } });
  });

  test("reads a jsonc declaration and keeps its comments", () => {
    const text = `{\n  // the shop\n  "name": "shop", "schema": 1,\n  "members": [\n    { "name": "db", "dir": "db", "kind": "chant" },\n    { "name": "mirror", "dir": "mirror", "kind": "chant" } // the mirror\n  ]\n}\n`;
    const root = repo(text, "chant.workspace.jsonc");
    const r = planMigrateLinks({ sourcePath: join(root, "db/schema.sql"), outputPath: join(root, "mirror/mirrors.ts"), outputs });
    if (!r || !("plan" in r)) throw new Error(JSON.stringify(r));
    expect(r.plan.text).toContain("// the shop");
    expect(r.plan.text).toContain("// the mirror");
    expect(r.plan.added).toEqual(outputs);
  });

  test("the deepest member holds a path: a nested member is not its parent's", () => {
    const root = repo(decl([{ name: "all", dir: ".", kind: "chant" }, { name: "db", dir: "db", kind: "chant" }, { name: "mirror", dir: "mirror", kind: "chant" }]));
    const r = planMigrateLinks({ sourcePath: join(root, "db/schema.sql"), outputPath: join(root, "mirror/mirrors.ts"), outputs });
    expect(r).toMatchObject({ plan: { producer: "db", consumer: "mirror" } });
  });

  test("no workspace above the source is no outcome at all", () => {
    const root = mkdtempSync(join(tmpdir(), "chant-no-workspace-"));
    scratch.push(root);
    writeFileSync(join(root, "schema.sql"), "");
    expect(planMigrateLinks({ sourcePath: join(root, "schema.sql"), outputPath: join(root, "out.ts"), outputs })).toBeUndefined();
  });

  test.each([
    ["output to stdout", (root: string) => ({ sourcePath: join(root, "db/schema.sql"), outputPath: undefined }), "pass --output inside the ClickHouse member"],
    ["a source in no member", (root: string) => ({ sourcePath: join(root, "elsewhere/schema.sql"), outputPath: join(root, "mirror/mirrors.ts") }), "is in no member"],
    ["an output in no member", (root: string) => ({ sourcePath: join(root, "db/schema.sql"), outputPath: join(root, "elsewhere/out.ts") }), "is in no member"],
    ["a source and output in one member", (root: string) => ({ sourcePath: join(root, "db/schema.sql"), outputPath: join(root, "db/out.ts") }), "does not link to itself"],
  ])("%s is skipped with a reason", (_name, paths, reason) => {
    const root = repo(decl(MEMBERS));
    const r = planMigrateLinks({ ...paths(root), outputs });
    expect(r && "skipped" in r ? r.skipped : r).toContain(reason);
  });

  test("a declaration that does not read is skipped with its error, never rewritten", () => {
    const root = repo("{ not json");
    const r = planMigrateLinks({ sourcePath: join(root, "db/schema.sql"), outputPath: join(root, "mirror/mirrors.ts"), outputs });
    expect(r && "skipped" in r ? r.skipped : r).toContain("does not read, so no link was written");
  });
});
