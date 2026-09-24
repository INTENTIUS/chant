import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, describe, expect, test } from "vitest";
import {
  compareVersions,
  DECLARATION_SCHEMA_ID,
  ownerOf,
  parseDeclaration,
  readDeclaration,
  resolveGroups,
  rootExclusions,
  WorkspaceReadError,
  type Declaration,
} from "./declaration";
import schema from "./declaration.schema.json";
import { workingTree } from "./tree";

const FILE = "chant.workspace.json";

function parse(value: unknown, file = FILE, reader = "0.80.0"): Declaration {
  return parseDeclaration(typeof value === "string" ? value : JSON.stringify(value, null, 2), file, reader);
}

function failure(value: unknown, file = FILE, reader = "0.80.0"): WorkspaceReadError {
  try {
    parse(value, file, reader);
  } catch (err) {
    if (err instanceof WorkspaceReadError) return err;
    throw err;
  }
  throw new Error("expected the declaration to be refused");
}

const base = (members: unknown[], extra: Record<string, unknown> = {}) => ({ name: "acme", schema: 1, members, ...extra });

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function tree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-declaration-")));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("the declaration schema (#2534)", () => {
  test("is a valid draft 2020-12 document that compiles in strict mode, with the published $id", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(ajv.validateSchema(schema)).toBe(true);
    expect(() => ajv.compile(schema)).not.toThrow();
    expect(schema.$id).toBe(DECLARATION_SCHEMA_ID);
    expect(DECLARATION_SCHEMA_ID).toBe("https://intentius.io/chant/schemas/workspace/declaration/v1/chant.workspace.schema.json");
  });

  test("the required fields are name, schema and members; minReader and pins are optional", () => {
    expect(schema.required).toEqual(["name", "schema", "members"]);
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["minReader", "pins"]));
  });
});

describe("parseDeclaration (#2534)", () => {
  test("reads members, roles, pins and example groups (ws-051)", () => {
    const d = parse(
      base(
        [
          { name: "app", dir: "apps/web", kind: "chant", roles: ["frontend", { name: "docs", path: "docs" }], "x-owner": "web team" },
          { name: "infra", dir: "infra", kind: "terraform", upstream: "github:acme/infra-kit" },
          { name: "vendor", dir: "vendor", kind: "other", because: "vendored code chant never reads" },
          { name: "examples", kind: "examples", glob: "examples/*" },
          { name: "fixtures", kind: "examples", glob: ["test/a", "test/b"] },
        ],
        { minReader: "0.79.0", pins: [{ package: "@intentius/chant", version: "0.80.0" }, { path: "plugins/kinds", integrity: "sha256-AAAA" }], "x-note": "hi" },
      ),
    );
    expect(d.name).toBe("acme");
    expect(d.minReader).toBe("0.79.0");
    expect(d.members.map((m) => [m.name, m.dir, m.kind])).toEqual([
      ["app", "apps/web", "chant"],
      ["infra", "infra", "terraform"],
      ["vendor", "vendor", "other"],
    ]);
    expect(d.members[0].roles).toEqual([
      { name: "frontend", path: null },
      { name: "docs", path: "docs" },
    ]);
    expect(d.members[1].upstream).toBe("github:acme/infra-kit");
    expect(d.groups.map((g) => [g.name, g.globs])).toEqual([
      ["examples", ["examples/*"]],
      ["fixtures", ["test/a", "test/b"]],
    ]);
    expect(d.entries.map((e) => e.type)).toEqual(["member", "member", "member", "group", "group"]);
    expect(d.pins).toEqual([
      { package: "@intentius/chant", version: "0.80.0", path: null, integrity: null },
      { package: null, version: null, path: "plugins/kinds", integrity: "sha256-AAAA" },
    ]);
  });

  test("a .jsonc declaration may carry comments and trailing commas; a .json one may not", () => {
    const text = '{\n  // the acme workspace\n  "name": "acme",\n  "schema": 1,\n  "members": [],\n}\n';
    expect(parse(text, "chant.workspace.jsonc").name).toBe("acme");
    const err = failure(text);
    expect(err.code).toBe("declaration-unparseable");
    expect(err.describe()).toMatch(/^chant\.workspace\.json:2:3: comments are only allowed/);
  });

  test("a parse error names the file and location and never reads as an empty declaration", () => {
    for (const text of ["", "   ", "{", '{ "name": "acme", }']) {
      const err = failure(text);
      expect(err.code).toBe("declaration-unparseable");
      expect(err.location).toMatchObject({ file: FILE, line: 1 });
    }
    expect(failure("[]").code).toBe("declaration-invalid");
    expect(failure("{}").message).toMatch(/missing required field "name"/);
  });

  test("a schema error names the line of the offending value", () => {
    const err = failure(base([{ name: "app", dir: "app", kind: "chant" }, { name: "Bad_Name", dir: "b", kind: "chant" }]));
    expect(err.code).toBe("declaration-invalid");
    expect(err.message).toMatch(/"Bad_Name" is not a valid name/);
    expect(err.location).toEqual({ file: FILE, line: 11, column: 15 });
  });

  test("an unknown field is refused at its key; x- fields are kept out of the way", () => {
    const err = failure(base([{ name: "app", dir: "app", kind: "chant", dependsOn: ["b"] }]));
    expect(err.message).toMatch(/unknown field "dependsOn"; only fields named x-\.\.\. may be added/);
    expect(err.location).toMatchObject({ line: 9, column: 7 });
    expect(() => parse({ ...base([]), $schema: "x", $comment: "y", "x-anything": { a: 1 } })).not.toThrow();
    expect(failure({ ...base([]), extra: 1 }).message).toMatch(/unknown field "extra"/);
  });

  test("member names follow the D2 grammar, and _workspace and _members are reserved", () => {
    for (const name of ["_workspace", "_members"]) {
      expect(failure(base([{ name, dir: "a", kind: "chant" }])).message).toMatch(new RegExp(`"${name}" is reserved`));
    }
    for (const name of ["", "-a", "A", "a_b", "a.b", "a/b", "x".repeat(41)]) {
      expect(failure(base([{ name, dir: "a", kind: "chant" }])).code, name).toBe("declaration-invalid");
    }
    for (const name of ["a", "0", "a-b", "lexicon-aws", "x".repeat(40)]) {
      expect(() => parse(base([{ name, dir: "a", kind: "chant" }])), name).not.toThrow();
    }
  });

  test("names are unique across members and groups", () => {
    const err = failure(base([{ name: "web", dir: "web", kind: "chant" }, { name: "web", kind: "examples", glob: "examples/*" }]));
    expect(err.code).toBe("declaration-invalid");
    expect(err.message).toMatch(/the name "web" is already used by the entry at \/members\/0/);
  });

  test("an other member needs because", () => {
    expect(failure(base([{ name: "v", dir: "v", kind: "other" }])).message).toMatch(/kind other needs "because"/);
  });

  test("schema must be 1", () => {
    expect(failure({ name: "acme", schema: 2, members: [] }).message).toMatch(/schema must be 1/);
  });

  test("a group has a glob and nothing a member has", () => {
    expect(failure(base([{ name: "ex", kind: "examples" }])).message).toMatch(/missing required field "glob"/);
    expect(failure(base([{ name: "ex", kind: "examples", glob: "examples/*", dir: "examples" }])).message).toMatch(/unknown field "dir"/);
    expect(failure(base([{ name: "ex", kind: "examples", glob: [] }])).code).toBe("declaration-invalid");
  });

  describe("placement (#2524 D2)", () => {
    test("directories stay inside the workspace: no .., no absolute paths, no . segments", () => {
      for (const dir of ["../x", "a/../b", "/abs", "./a", "a/./b", "a/", "", "a\\b"]) {
        const err = failure(base([{ name: "a", dir, kind: "chant" }]));
        expect(err.code, dir).toBe("declaration-invalid");
      }
      expect(failure(base([{ name: "a", dir: "../x", kind: "chant" }])).message).toMatch(/not a directory inside the workspace/);
      for (const glob of ["../*", "/examples/*", "examples/../x"]) {
        expect(failure(base([{ name: "ex", kind: "examples", glob }])).message, glob).toMatch(/not a glob inside the workspace/);
      }
    });

    test("no two members share a directory", () => {
      const err = failure(base([{ name: "a", dir: "x", kind: "chant" }, { name: "b", dir: "x", kind: "other", because: "y" }]));
      expect(err.code).toBe("placement-invalid");
      expect(err.message).toMatch(/member b has the same directory as member a/);
    });

    test('only the root member "." contains other members', () => {
      expect(() => parse(base([{ name: "root", dir: ".", kind: "chant" }, { name: "a", dir: "apps/a", kind: "chant" }]))).not.toThrow();
      const err = failure(base([{ name: "apps", dir: "apps", kind: "chant" }, { name: "a", dir: "apps/a", kind: "chant" }]));
      expect(err.code).toBe("placement-invalid");
      expect(err.message).toMatch(/member a \(apps\/a\) sits inside member apps \(apps\)/);
      expect(err.location).toMatchObject({ file: FILE, line: 12 });
      // A prefix that isn't a parent directory is no overlap.
      expect(() => parse(base([{ name: "app", dir: "app", kind: "chant" }, { name: "app2", dir: "app2", kind: "chant" }]))).not.toThrow();
    });
  });

  test("minReader newer than this chant fails as reader-too-old, before any schema check", () => {
    const err = failure({ ...base([]), minReader: "0.90.0", futureField: true }, FILE, "0.80.0");
    expect(err.code).toBe("reader-too-old");
    expect(err.message).toMatch(/needs chant 0\.90\.0 or newer/);
    expect(() => parse({ ...base([]), minReader: "0.80.0" }, FILE, "0.80.0")).not.toThrow();
    expect(failure({ ...base([]), minReader: "0.80.0" }, FILE, "0.80.0-rc.1").code).toBe("reader-too-old");
  });

  test("compareVersions orders releases and prereleases", () => {
    expect(compareVersions("0.80.0", "0.79.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
  });
});

describe("readDeclaration (#2534)", () => {
  test("both chant.workspace.json and chant.workspace.jsonc is an error", () => {
    const root = tree({ [FILE]: JSON.stringify(base([])), "chant.workspace.jsonc": JSON.stringify(base([])) });
    expect(() => readDeclaration(workingTree(root))).toThrow(expect.objectContaining({ code: "declaration-ambiguous" }));
  });

  test("a missing declaration is its own code", () => {
    expect(() => readDeclaration(workingTree(tree({})))).toThrow(expect.objectContaining({ code: "declaration-missing" }));
  });

  test("reads the .jsonc name", () => {
    const root = tree({ "chant.workspace.jsonc": "// c\n" + JSON.stringify(base([])) });
    expect(readDeclaration(workingTree(root)).file).toBe("chant.workspace.jsonc");
  });
});

describe("example groups on a tree (ws-051)", () => {
  const files = {
    "lexicons/aws/package.json": "{}",
    "lexicons/aws/examples/one/chant.config.ts": "",
    "lexicons/aws/examples/two/src/chant.config.json": "{}",
    "lexicons/aws/examples/three/package.json": JSON.stringify({ dependencies: { "@intentius/chant-lexicon-aws": "*" } }),
    "lexicons/aws/examples/notes/README.md": "",
    "lexicons/gcp/examples/one/chant.config.ts": "",
    "apps/web/chant.config.ts": "",
  };
  const members = [
    { name: "lexicon-aws", dir: "lexicons/aws", kind: "other", because: "a package" },
    { name: "web", dir: "apps/web", kind: "chant" },
  ];

  test("matches that hold a chant project are listed; the rest are skipped; a match may sit in a member", () => {
    const root = tree(files);
    const d = parse(base([...members, { name: "lexicon-examples", kind: "examples", glob: "lexicons/*/examples/*" }]));
    const [g] = resolveGroups(d, workingTree(root));
    expect(g.matches).toEqual(["lexicons/aws/examples/one", "lexicons/aws/examples/three", "lexicons/aws/examples/two", "lexicons/gcp/examples/one"]);
    expect(g.skipped).toEqual(["lexicons/aws/examples/notes"]);
  });

  test("the group owns its matches, even inside a member's directory; a match inside a member leaves with it", () => {
    const root = tree(files);
    const d = parse(base([...members, { name: "lexicon-examples", kind: "examples", glob: "lexicons/*/examples/*" }]));
    const groups = resolveGroups(d, workingTree(root));
    expect(ownerOf(d, groups, "lexicons/aws/examples/one/src/index.ts")).toMatchObject({ group: { name: "lexicon-examples" }, match: "lexicons/aws/examples/one" });
    expect(ownerOf(d, groups, "lexicons/aws/src/index.ts")).toMatchObject({ member: { name: "lexicon-aws" } });
    expect(ownerOf(d, groups, "README.md")).toBeUndefined();
    expect(rootExclusions(d, groups)).toEqual([
      { dir: "apps/web", owner: "web" },
      { dir: "lexicons/aws", owner: "lexicon-aws" },
      { dir: "lexicons/gcp/examples/one", owner: "lexicon-examples" },
    ]);
  });

  test("a match is never a member, never contains one, and no two groups claim it", () => {
    const root = tree(files);
    const cases: [unknown[], RegExp][] = [
      [[{ name: "g", kind: "examples", glob: "apps/*" }], /matches apps\/web, which is member web's directory/],
      [[{ name: "g", kind: "examples", glob: "apps" }], /which contains member web/],
      [
        [
          { name: "g1", kind: "examples", glob: "lexicons/*/examples/*" },
          { name: "g2", kind: "examples", glob: "lexicons/gcp/examples/*" },
        ],
        /group g2 matches lexicons\/gcp\/examples\/one, which group g1 also matches/,
      ],
    ];
    for (const [groups, message] of cases) {
      const d = parse(base([...members, ...groups]));
      let err: unknown;
      try {
        resolveGroups(d, workingTree(root));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(WorkspaceReadError);
      expect((err as WorkspaceReadError).code).toBe("placement-invalid");
      expect((err as WorkspaceReadError).message).toMatch(message);
      expect((err as WorkspaceReadError).location?.line).toBeGreaterThan(1);
    }
  });

  test("a match inside a nested workspace member is refused", () => {
    const root = tree({ ...files, "inner/chant.workspace.json": "{}", "inner/examples/a/chant.config.ts": "" });
    const d = parse(base([{ name: "inner", dir: "inner", kind: "workspace" }, { name: "g", kind: "examples", glob: "inner/examples/*" }]));
    expect(() => resolveGroups(d, workingTree(root))).toThrow(/sits inside the nested workspace inner/);
  });
});
