/**
 * `chant workspace box listing set` (#3308): a box's listing written through
 * chant, in place, on workspaces built in throwaway git repositories whose
 * main holds the declaration the write scope is read from.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, repo, scratchDir } from "./__fixtures__/contract-repo";
import { boxListingSet, BOX_LISTING_ERROR_CODES, type BoxListingWriteDocument, type BoxListingWriteRequest } from "./box-listing";
import schema from "./box-listing-write.schema.json";
import { workspaceStatus } from "./status";

afterAll(cleanScratch);

const { expectValid } = contract(schema);

/** A 1x1 PNG, and the first bytes of a JPEG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const JSONC = `{
  // the box this workspace runs
  "name": "demo",
  "schema": 1,
  "members": [
    {
      "name": "app",
      "dir": "app",
      "kind": "other",
      "because": "a plain Node server", // not a chant project
      "box": {
        "services": [{ "name": "web", "cmd": "node server.mjs" }],
      },
    },
    { "name": "docs", "dir": "docs", "kind": "other", "because": "prose" },
  ],
}
`;

function declaration(extra: Record<string, unknown> = {}, box: Record<string, unknown> = { services: [{ name: "web", cmd: "node server.mjs" }] }): string {
  return `${JSON.stringify(
    {
      name: "demo",
      schema: 1,
      members: [
        { name: "app", dir: "app", kind: "other", because: "a plain Node server", box },
        { name: "docs", dir: "docs", kind: "other", because: "prose" },
      ],
      ...extra,
    },
    null,
    2,
  )}\n`;
}

/** A workspace committed on main, so main is the base the write scope is read from. */
function workspace(files: Record<string, string>): string {
  const root = repo({ "app/server.mjs": "export {};\n", "docs/README.md": "# Docs\n", ...files }, true);
  git(root, "branch", "-M", "main");
  return root;
}

function inputs(): string {
  const dir = scratchDir("chant-listing-inputs-");
  writeFileSync(join(dir, "cover.png"), PNG);
  writeFileSync(join(dir, "cover.jpg"), JPEG);
  writeFileSync(join(dir, "notes.txt"), "not a picture");
  return dir;
}

function set(req: Omit<BoxListingWriteRequest, "member"> & { member?: string }, fields?: unknown): BoxListingWriteDocument {
  const doc = boxListingSet({ member: "app", ...req, ...(fields !== undefined ? { fields: JSON.stringify(fields) } : {}) });
  expectValid(doc);
  return doc;
}

const ok = (doc: BoxListingWriteDocument) => {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
};
const code = (doc: BoxListingWriteDocument) => ("error" in doc ? doc.error.code : null);

describe("box listing set writes the listing in place (#3308)", () => {
  test("adds a listing to a box that has none, copies the cover in, and keeps the file's comments and layout", async () => {
    const root = workspace({ "chant.workspace.jsonc": JSONC });
    const dir = inputs();
    const doc = ok(set({ cwd: root, cover: join(dir, "cover.png") }, { title: "Demo", line: "A box that demos" }));
    expect(doc.paths).toEqual(["app/listing/cover.png", "chant.workspace.jsonc"]);
    expect(doc.changed).toBe(true);
    expect(doc.previous).toBeNull();
    const sha = doc.cover!.sha256;
    expect(doc.listing).toEqual({ published: true, title: "Demo", line: "A box that demos", cover: { path: "app/listing/cover.png", sha256: sha } });
    expect(doc.cover).toEqual({ path: "app/listing/cover.png", sha256: sha, bytes: PNG.length, type: "image/png", replaced: null });
    expect(readFileSync(join(root, "app/listing/cover.png"))).toEqual(PNG);
    const text = readFileSync(join(root, "chant.workspace.jsonc"), "utf-8");
    expect(text).toBe(
      JSONC.replace(
        `        "services": [{ "name": "web", "cmd": "node server.mjs" }],\n`,
        `        "services": [{ "name": "web", "cmd": "node server.mjs" }],\n        "listing": {\n          "title": "Demo",\n          "line": "A box that demos",\n          "cover": "app/listing/cover.png"\n        },\n`,
      ),
    );
    // What the read contract prints is what the write printed.
    const status = await workspaceStatus({ env: "dev", cwd: root });
    if ("error" in status) throw new Error(status.error.message);
    expect(status.members.find((m) => m.name === "app")!.box!.listing).toEqual(doc.listing);
  });

  test("changes only the fields given; null takes one out, and the same values again change nothing", () => {
    const root = workspace({ "chant.workspace.json": declaration({}, { listing: { title: "Old", line: "old line", "x-studio": { slot: 1 } } }) });
    const before = readFileSync(join(root, "chant.workspace.json"), "utf-8");
    const doc = ok(set({ cwd: root }, { title: "New", line: null, published: false }));
    expect(doc.previous).toEqual({ published: true, title: "Old", line: "old line", cover: null });
    expect(doc.listing).toEqual({ published: false, title: "New", line: "", cover: null });
    const after = readFileSync(join(root, "chant.workspace.json"), "utf-8");
    expect(JSON.parse(after).members[0].box.listing).toEqual({ title: "New", "x-studio": { slot: 1 }, published: false });
    expect(after).toBe(
      before.replace(
        `"title": "Old",\n          "line": "old line",\n          "x-studio": {\n            "slot": 1\n          }\n`,
        `"title": "New",\n          "x-studio": {\n            "slot": 1\n          },\n          "published": false\n`,
      ),
    );
    const again = ok(set({ cwd: root }, { title: "New", published: false }));
    expect(again.changed).toBe(false);
    expect(again.paths).toEqual([]);
    expect(readFileSync(join(root, "chant.workspace.json"), "utf-8")).toBe(after);
  });

  test("a new cover with another format goes to its own path and names the one it replaced; --cover-path chooses the path", () => {
    const root = workspace({ "chant.workspace.json": declaration() });
    const dir = inputs();
    ok(set({ cwd: root, cover: join(dir, "cover.png") }));
    const jpeg = ok(set({ cwd: root, cover: join(dir, "cover.jpg") }));
    expect(jpeg.cover).toMatchObject({ path: "app/listing/cover.jpg", type: "image/jpeg", replaced: "app/listing/cover.png" });
    expect(existsSync(join(root, "app/listing/cover.png"))).toBe(true);
    const chosen = ok(set({ cwd: root, cover: join(dir, "cover.png"), coverPath: "app/public/box.png" }));
    expect(chosen.listing.cover!.path).toBe("app/public/box.png");
    expect(chosen.paths).toEqual(["app/public/box.png", "chant.workspace.json"]);
  });

  test("a cover field names a picture already in the workspace, and null takes the cover out, leaving the file", () => {
    const root = workspace({ "chant.workspace.json": declaration() });
    writeFileSync(join(root, "docs/shot.png"), PNG);
    expect(ok(set({ cwd: root }, { cover: "docs/shot.png" })).listing.cover!.path).toBe("docs/shot.png");
    expect(ok(set({ cwd: root }, { cover: null })).listing.cover).toBeNull();
    expect(existsSync(join(root, "docs/shot.png"))).toBe(true);
  });

  test("--dry-run prints the document and writes nothing", () => {
    const root = workspace({ "chant.workspace.json": declaration() });
    const before = readFileSync(join(root, "chant.workspace.json"), "utf-8");
    const doc = ok(set({ cwd: root, dryRun: true, cover: join(inputs(), "cover.png") }, { title: "Dry" }));
    expect(doc.dryRun).toBe(true);
    expect(doc.paths).toEqual(["app/listing/cover.png", "chant.workspace.json"]);
    expect(doc.listing.title).toBe("Dry");
    expect(readFileSync(join(root, "chant.workspace.json"), "utf-8")).toBe(before);
    expect(existsSync(join(root, "app/listing"))).toBe(false);
  });

  test("refuses, writing nothing, what it can't write", () => {
    const root = workspace({ "chant.workspace.json": declaration() });
    const dir = inputs();
    const before = readFileSync(join(root, "chant.workspace.json"), "utf-8");
    expect(code(set({ cwd: root, member: "nope" }, { title: "x" }))).toBe("listing-member-unknown");
    expect(code(set({ cwd: root, member: "docs" }, { title: "x" }))).toBe("listing-box-missing");
    expect(code(set({ cwd: root }))).toBe("write-usage-invalid");
    expect(code(set({ cwd: root, coverPath: "a.png" }, {}))).toBe("write-usage-invalid");
    expect(code(set({ cwd: root, cover: join(dir, "cover.png") }, { cover: "x.png" }))).toBe("write-usage-invalid");
    expect(code(set({ cwd: root }, { subtitle: "x" }))).toBe("write-input-invalid");
    expect(code(set({ cwd: root }, { published: "yes" }))).toBe("write-input-invalid");
    expect(code(set({ cwd: root }, ["title"]))).toBe("write-input-invalid");
    expect(code(boxListingSet({ cwd: root, member: "app", fields: "{" }))).toBe("write-input-invalid");
    const long = set({ cwd: root }, { title: "t".repeat(61) });
    expect(code(long)).toBe("write-input-invalid");
    expect("error" in long && long.error.message).toMatch(/would make the declaration invalid: .*60 characters/);
    expect(code(set({ cwd: root, cover: join(dir, "notes.txt") }))).toBe("listing-cover-invalid");
    expect(code(set({ cwd: root, cover: join(dir, "missing.png") }))).toBe("listing-cover-invalid");
    expect(code(set({ cwd: root, cover: join(dir, "cover.png"), coverPath: "../out.png" }))).toBe("listing-cover-invalid");
    expect(code(set({ cwd: root, cover: join(dir, "cover.png"), coverPath: "app/cover.jpg" }))).toBe("listing-cover-invalid");
    expect(code(set({ cwd: root }, { cover: "docs/README.md" }))).toBe("listing-cover-invalid");
    expect(code(set({ cwd: root }, { cover: "docs/none.png" }))).toBe("listing-cover-invalid");
    expect(readFileSync(join(root, "chant.workspace.json"), "utf-8")).toBe(before);
    expect(existsSync(join(root, "app/listing"))).toBe(false);
    expect(code(boxListingSet({ cwd: scratchDir(), member: "app", fields: "{}" }))).toBe("declaration-missing");
  });

  test("every error code it can print is in its schema", () => {
    const enumCodes = (schema.$defs.failure.properties.error.properties.code as { enum: string[] }).enum;
    expect([...enumCodes].sort()).toEqual([...BOX_LISTING_ERROR_CODES].sort());
  });
});

describe("box listing set honours the write scope and identity rule at base (#3308, ws-067, ws-080)", () => {
  const PROTECTED = (except?: string[]) => ({ writeScope: { human: { protected: [except ? { path: "chant.workspace.json", except } : "chant.workspace.json"] } } });

  test("a protected declaration refuses the write, unless except names the listing by JSON Pointer", () => {
    const root = workspace({ "chant.workspace.json": declaration(PROTECTED()) });
    expect(code(set({ cwd: root, by: "alice@example.com" }, { title: "x" }))).toBe("write-scope-protected");

    const members = workspace({ "chant.workspace.json": declaration(PROTECTED(["/members/*/box/intent"])) });
    const refused = set({ cwd: members, by: "alice@example.com" }, { title: "x" });
    expect(code(refused)).toBe("write-scope-protected");
    expect("error" in refused && refused.error.message).toMatch(/outside what its except allows \(\/members\/\*\/box\/intent\)/);

    const allowed = workspace({ "chant.workspace.json": declaration(PROTECTED(["/members/*/box/listing"])) });
    expect(ok(set({ cwd: allowed, by: "alice@example.com", cover: join(inputs(), "cover.png") }, { title: "x" })).listing.title).toBe("x");
  });

  test("the scope is read at base: a working-tree edit can't widen it", () => {
    const root = workspace({ "chant.workspace.json": declaration(PROTECTED()) });
    writeFileSync(join(root, "chant.workspace.json"), declaration(PROTECTED(["/members/*/box/listing"])));
    expect(code(set({ cwd: root }, { title: "x" }))).toBe("write-scope-protected");
  });

  test("a protected cover path is refused like any other file", () => {
    const root = workspace({ "chant.workspace.json": declaration({ writeScope: { human: { protected: ["app/listing/**"] } } }) });
    expect(code(set({ cwd: root, cover: join(inputs(), "cover.png") }))).toBe("write-scope-protected");
    expect(ok(set({ cwd: root, cover: join(inputs(), "cover.png"), coverPath: "app/public/cover.png" })).paths).toContain("app/public/cover.png");
  });

  test("an agent session writes only its own member, and the declaration is in none", () => {
    const root = workspace({ "chant.workspace.json": declaration({ agents: [{ name: "app-agent", member: "app" }] }) });
    const doc = set({ cwd: root, agent: "app-agent" }, { title: "x" });
    expect(code(doc)).toBe("write-scope-member");
    expect(code(set({ cwd: root, agent: "ghost" }, { title: "x" }))).toBe("agent-unknown");
  });

  test("under identity.attribution identified, --by names a forge identity or a signer", () => {
    const root = workspace({ "chant.workspace.json": declaration({ identity: { attribution: "identified" } }) });
    expect(code(set({ cwd: root, by: "alice" }, { title: "x" }))).toBe("principal-unidentified");
    expect(ok(set({ cwd: root, by: "github:alice" }, { title: "x" })).listing.title).toBe("x");
  });
});
