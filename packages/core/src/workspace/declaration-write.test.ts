/**
 * #3596: a declaration's members and hosts written through chant, the way a
 * local lobby plants, retires and starts boxes, without editing the file.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, repo } from "./__fixtures__/contract-repo";
import { readDeclaration } from "./declaration";
import { declarationWrite, type DeclarationWriteDocument, type DeclarationWriteRequest } from "./declaration-write";
import schema from "./member-write.schema.json";
import { appendElement, removeElement, setElement } from "./json-edit";
import { parseJsonText } from "./jsonc";
import { workingTree } from "./tree";

afterAll(cleanScratch);

const { expectValid } = contract(schema);

const HOST = { name: "local", ports: { from: 18100, to: 18199, perBox: 10 }, stateRoot: "${STUDIO_LOBBY_HOME}/boxes" };
const box = (name: string, slot: number) => ({
  name,
  dir: `boxes/${name}`,
  kind: "other",
  because: "a box the lobby planted",
  box: { host: "local", slot, ports: { door: 0, site: 1 }, state: { record: "box.json" }, cookies: ["hud_session"] },
});

const JSONC = `{
  // the lobby
  "name": "studio-lobby",
  "schema": 1,
  "minReader": "0.93.0",
  "members": [
    // planted boxes
  ],
}
`;

function lobby(text = JSONC, file = "chant.workspace.jsonc"): string {
  return repo({ [file]: text });
}

function run(root: string, req: Omit<DeclarationWriteRequest, "cwd" | "entry"> & { entry?: unknown }): DeclarationWriteDocument {
  const doc = declarationWrite({ ...req, cwd: root, entry: req.entry === undefined ? undefined : JSON.stringify(req.entry) });
  expectValid(doc);
  return doc;
}

const code = (doc: DeclarationWriteDocument) => ("error" in doc ? doc.error.code : null);
const declOf = (root: string) => readDeclaration(workingTree(root));

describe("host set and member add|remove on a lobby's declaration (#3596)", () => {
  test("the first start writes the host, plants two boxes and retires one, keeping the file's comments", () => {
    const root = lobby();
    const host = run(root, { action: "host set", name: "local", entry: HOST });
    expect(host).toMatchObject({ action: "host set", name: "local", changed: true, previous: null, entry: HOST, paths: ["chant.workspace.jsonc"] });

    const fern = run(root, { action: "member add", name: "fern", entry: box("fern", 0) });
    expect(fern).toMatchObject({ changed: true, previous: null, entry: box("fern", 0) });
    expect(run(root, { action: "member add", name: "moss", entry: { ...box("moss", 1), name: undefined } })).toMatchObject({ changed: true });
    expect(declOf(root).members.map((m) => [m.name, m.box?.isolation?.slot])).toEqual([
      ["fern", 0],
      ["moss", 1],
    ]);

    const text = readFileSync(join(root, "chant.workspace.jsonc"), "utf-8");
    expect(text).toContain("// the lobby");
    expect(text).toContain("// planted boxes");
    expect(declarationWrite({ cwd: root, action: "host set", name: "local", entry: JSON.stringify(HOST) })).toMatchObject({ changed: false, previous: HOST, paths: [] });

    const retire = run(root, { action: "member remove", name: "fern" });
    expect(retire).toMatchObject({ changed: true, previous: box("fern", 0), entry: null });
    expect(declOf(root).members.map((m) => m.name)).toEqual(["moss"]);
    expect(readFileSync(join(root, "chant.workspace.jsonc"), "utf-8")).toContain("// planted boxes");
  });

  test("host set replaces a host in place, and a dry run writes nothing", () => {
    const root = lobby(`${JSON.stringify({ name: "l", schema: 1, members: [], hosts: [HOST] }, null, 2)}\n`, "chant.workspace.json");
    const before = readFileSync(join(root, "chant.workspace.json"), "utf-8");
    const wider = { ...HOST, ports: { from: 18100, to: 18299, perBox: 10 } };
    const dry = run(root, { action: "host set", name: "local", entry: wider, dryRun: true });
    expect(dry).toMatchObject({ changed: true, dryRun: true, previous: HOST, entry: wider });
    expect(readFileSync(join(root, "chant.workspace.json"), "utf-8")).toBe(before);
    run(root, { action: "host set", name: "local", entry: wider });
    expect(declOf(root).hosts.map((h) => h.ports.to)).toEqual([18299]);
  });

  test("refuses a name taken, a member not there, an entry that doesn't read, and two boxes in one slot", () => {
    const root = lobby();
    run(root, { action: "host set", name: "local", entry: HOST });
    run(root, { action: "member add", name: "fern", entry: box("fern", 0) });
    const before = readFileSync(join(root, "chant.workspace.jsonc"), "utf-8");

    expect(run(root, { action: "member add", name: "fern", entry: box("fern", 0) })).toMatchObject({ changed: false });
    expect(code(run(root, { action: "member add", name: "fern", entry: box("fern", 2) }))).toBe("member-exists");
    expect(code(run(root, { action: "member remove", name: "ghost" }))).toBe("member-unknown");
    const invalid = run(root, { action: "member add", name: "moss", entry: { ...box("moss", 1), because: undefined } });
    expect(code(invalid)).toBe("write-input-invalid");
    expect("error" in invalid && invalid.error.message).toMatch(/needs "because"/);
    const shared = run(root, { action: "member add", name: "moss", entry: box("moss", 0) });
    expect(code(shared)).toBe("box-isolation-collision");
    expect("error" in shared && shared.error.message).toMatch(/fern\.door and moss\.door/);
    expect(code(run(root, { action: "member add", name: "moss", entry: { ...box("moss", 1), name: "fern" } }))).toBe("write-input-invalid");
    expect(code(run(root, { action: "host set", name: "local", entry: { ...HOST, stateRoot: "/var/boxes" } }))).toBe("box-isolation-literal");
    expect(code(run(root, { action: "member remove", name: "fern", entry: {} }))).toBe("write-usage-invalid");
    expect(code(run(root, { action: "host set", name: "local" }))).toBe("write-usage-invalid");
    expect(readFileSync(join(root, "chant.workspace.jsonc"), "utf-8")).toBe(before);
  });

  test("a writer the write scope at base keeps off the declaration is refused, unless except allows members and hosts", () => {
    const decl = (except?: string[]) => ({
      name: "l",
      schema: 1,
      members: [{ name: "root", dir: ".", kind: "other", because: "the lobby" }],
      writeScope: { human: { protected: [except ? { path: "chant.workspace.json", except } : "chant.workspace.json"] } },
    });
    const root = repo({ "chant.workspace.json": `${JSON.stringify(decl(), null, 2)}\n` }, true);
    git(root, "branch", "-M", "main");
    expect(code(run(root, { action: "host set", name: "local", entry: HOST }))).toBe("write-scope-protected");
    writeFileSync(join(root, "chant.workspace.json"), `${JSON.stringify(decl(["members", "hosts"]), null, 2)}\n`);
    git(root, "commit", "-q", "-am", "allow the lobby's writes");
    expect(run(root, { action: "host set", name: "local", entry: HOST })).toMatchObject({ changed: true });
    expect(run(root, { action: "member add", name: "fern", entry: box("fern", 0) })).toMatchObject({ changed: true });
  });
});

describe("array edits in place (#3596)", () => {
  const read = (text: string) => {
    const r = parseJsonText(text, { jsonc: true });
    if (!r.ok) throw new Error(r.message);
    return r.value;
  };

  test("append to an empty, a multi-line and a one-line array", () => {
    expect(read(appendElement('{ "a": [] }', false, "/a", { x: 1 }))).toEqual({ a: [{ x: 1 }] });
    const multi = '{\n  "a": [\n    1, // one\n    2\n  ]\n}\n';
    const out = appendElement(multi, true, "/a", 3);
    expect(out).toBe('{\n  "a": [\n    1, // one\n    2,\n    3\n  ]\n}\n');
    expect(appendElement('{ "a": [1, 2] }', false, "/a", 3)).toBe('{ "a": [1, 2, 3] }');
    expect(read(appendElement('{\n  "a": [\n    1,\n  ],\n}', true, "/a", 2))).toEqual({ a: [1, 2] });
  });

  test("remove the first, a middle, the last and the only element, and replace one", () => {
    const text = '{\n  "a": [\n    1,\n    2,\n    3\n  ]\n}\n';
    expect(removeElement(text, false, "/a", 0)).toBe('{\n  "a": [\n    2,\n    3\n  ]\n}\n');
    expect(removeElement(text, false, "/a", 1)).toBe('{\n  "a": [\n    1,\n    3\n  ]\n}\n');
    expect(removeElement(text, false, "/a", 2)).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}\n');
    expect(removeElement('{ "a": [1] }', false, "/a", 0)).toBe('{ "a": [] }');
    expect(removeElement('{\n  "a": [\n    // kept\n    1\n  ]\n}', true, "/a", 0)).toBe('{\n  "a": [\n    // kept\n  ]\n}');
    expect(read(setElement(text, false, "/a", 1, { b: true }))).toEqual({ a: [1, { b: true }, 3] });
    expect(() => removeElement(text, false, "/a", 3)).toThrow(/no element 3/);
  });
});
