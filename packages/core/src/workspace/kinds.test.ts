import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, describe, expect, test } from "vitest";
import declarationSchema from "./declaration.schema.json";
import {
  BUILTIN_KINDS,
  builtinKindRegistry,
  createKindRegistry,
  EXAMPLES_KIND,
  KINDS_SCHEMA_ID,
  kindsExportTarget,
  kindsFileShips,
  loadKindRegistry,
  parseKindData,
  readPackageKinds,
  resolveKind,
  type MemberKind,
} from "./kinds";
import schema from "./workspace-kinds.schema.json";
import { workingTree } from "./tree";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function dir(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-kinds-")));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const kindsFile = (kinds: unknown[]) => JSON.stringify({ schema: 1, kinds });
const tf = { name: "terraform", description: "a Terraform root module", precedence: 400, probe: { anyFile: ["main.tf"] } };

/**
 * A package whose code writes a marker file when it is imported, so a test
 * can tell that reading its kinds imported nothing.
 */
function pkg(name: string, version: string, kinds: unknown[] | null, extra: Record<string, unknown> = {}): Record<string, string> {
  const marker = `globalThis.__chantKindsImported = true; require("node:fs").writeFileSync(require("node:path").join(__dirname, "IMPORTED"), "");\n`;
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({
      name,
      version,
      main: "./index.js",
      exports: { ".": "./index.js", "./*": "./src/*.js", ...(kinds ? { "./workspace-kinds": "./workspace-kinds.json" } : {}) },
      ...extra,
    }),
    [`node_modules/${name}/index.js`]: marker,
    [`node_modules/${name}/src/workspace-kinds.js`]: marker,
    ...(kinds ? { [`node_modules/${name}/workspace-kinds.json`]: kindsFile(kinds) } : {}),
  };
}

describe("the built-in kinds (#2535)", () => {
  test("are chant, workspace and other, and the group kind examples", () => {
    expect(BUILTIN_KINDS.map((k) => `${k.name}:${k.shape}`)).toEqual(["chant:member", "workspace:member", "other:member", "examples:group"]);
    const registry = builtinKindRegistry();
    expect(registry.names()).toEqual(["chant", "other", "workspace"]);
    expect(registry.get(EXAMPLES_KIND)?.shape).toBe("group");
  });

  test("agree with the declaration schema: examples is the one entry kind that makes a group", () => {
    const entry = declarationSchema.$defs.entry;
    expect(entry.if.properties.kind.const).toBe(EXAMPLES_KIND);
    expect(declarationSchema.$defs.group.properties.kind.const).toBe(EXAMPLES_KIND);
    expect(declarationSchema.$defs.member.if.properties.kind.const).toBe("other");
    expect(declarationSchema.$defs.member.then.required).toEqual(["because"]);
  });

  test("a registry refuses a name twice", () => {
    expect(() => createKindRegistry([{ ...BUILTIN_KINDS[0], source: "x" }])).toThrow(/registered twice/);
  });
});

describe("the kinds schema", () => {
  test("is a valid draft 2020-12 document that compiles in strict mode, with the published $id", () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true });
    expect(ajv.validateSchema(schema)).toBe(true);
    expect(() => ajv.compile(schema)).not.toThrow();
    expect(KINDS_SCHEMA_ID).toBe("https://intentius.io/chant/schemas/workspace/kinds/v1/workspace-kinds.schema.json");
  });
});

describe("parseKindData", () => {
  test("reads valid kinds, with their source", () => {
    const data = parseKindData(kindsFile([tf]), "@acme/tf-kinds");
    expect(data.problems).toEqual([]);
    expect(data.kinds).toEqual([{ ...tf, shape: "member", source: "@acme/tf-kinds" }]);
  });

  test("refuses a built-in name, a name twice, a schema mismatch and text that isn't JSON", () => {
    expect(parseKindData(kindsFile([{ ...tf, name: "chant" }]), "p").problems).toEqual(["p: kind chant is built in and can't be supplied by a package"]);
    expect(parseKindData(kindsFile([{ ...tf, name: "examples" }]), "p").problems[0]).toMatch(/examples is built in/);
    expect(parseKindData(kindsFile([tf, tf]), "p").problems).toEqual(["p: kind terraform is listed twice"]);
    expect(parseKindData(kindsFile([{ ...tf, precedence: 1000 }]), "p").problems[0]).toMatch(/precedence/);
    expect(parseKindData(kindsFile([{ ...tf, probe: { anyFile: ["../main.tf"] } }]), "p").problems[0]).toMatch(/anyFile/);
    expect(parseKindData(kindsFile([{ ...tf, run: "node x.js" }]), "p").problems[0]).toMatch(/additional properties/);
    expect(parseKindData("{", "p").problems[0]).toMatch(/^p: the kinds file is not JSON/);
  });
});

describe("reading a package's kinds", () => {
  test("follows only the literal ./workspace-kinds key, and only to a JSON file inside the package", () => {
    expect(kindsExportTarget({ exports: { "./*": "./src/*.ts" } })).toBeUndefined();
    expect(kindsExportTarget({ exports: { "./workspace-kinds": "./k.json" } })).toBe("./k.json");
    expect(kindsExportTarget({ exports: { "./workspace-kinds": { types: "./k.d.ts", default: "./k.json" } } })).toBe("./k.json");
    expect(kindsExportTarget({ exports: { "./workspace-kinds": "./src/kinds.ts" } })).toEqual({ problem: expect.stringMatching(/must name a \.json file/) });
    expect(kindsExportTarget({ exports: { "./workspace-kinds": ["./a.json"] } })).toEqual({ problem: expect.stringMatching(/must name one file/) });
  });

  test("refuses a target outside the package, and a target that doesn't exist", () => {
    const root = dir({
      "a/package.json": JSON.stringify({ name: "a", exports: { "./workspace-kinds": "./../b/k.json" } }),
      "b/k.json": kindsFile([tf]),
      "c/package.json": JSON.stringify({ name: "c", exports: { "./workspace-kinds": "./missing.json" } }),
    });
    expect(readPackageKinds(join(root, "a")).problems[0]).toMatch(/outside the package/);
    expect(readPackageKinds(join(root, "c")).problems[0]).toMatch(/does not exist/);
  });

  test("a package with no subpath supplies no kinds and no problem", () => {
    const root = dir({ "package.json": JSON.stringify({ name: "lexicon", exports: { ".": "./index.js" } }) });
    expect(readPackageKinds(root)).toEqual({ kinds: [], problems: [], file: undefined });
  });

  test("knows whether the kinds file ships, from package.json files", () => {
    const root = dir({ "package.json": JSON.stringify({ files: ["dist/", "./kinds"] }) });
    expect(kindsFileShips(root, join(root, "kinds/workspace-kinds.json"))).toBe(true);
    expect(kindsFileShips(root, join(root, "dist/k.json"))).toBe(true);
    expect(kindsFileShips(root, join(root, "workspace-kinds.json"))).toBe(false);
    const open = dir({ "package.json": JSON.stringify({ name: "x" }) });
    expect(kindsFileShips(open, join(open, "workspace-kinds.json"))).toBe(true);
  });
});

describe("loadKindRegistry: kinds from the pins", () => {
  test("reads an installed package's kinds as data and never imports the package", () => {
    const root = dir(pkg("@acme/chant-lexicon-tf", "1.2.3", [tf]));
    const { registry, problems } = loadKindRegistry([{ package: "@acme/chant-lexicon-tf", version: "1.2.3", path: null }], root);
    expect(problems).toEqual([]);
    expect(registry.get("terraform")).toMatchObject({ source: "@acme/chant-lexicon-tf", precedence: 400 });
    expect(registry.names()).toEqual(["chant", "other", "terraform", "workspace"]);
    expect(existsSync(join(root, "node_modules/@acme/chant-lexicon-tf/IMPORTED"))).toBe(false);
    expect((globalThis as { __chantKindsImported?: boolean }).__chantKindsImported).toBeUndefined();
  });

  test("finds the package in an ancestor's node_modules, as Node does", () => {
    const root = dir({ ...pkg("tf-kinds", "1.0.0", [tf]), "ws/.keep": "" });
    expect(loadKindRegistry([{ package: "tf-kinds", version: "1.0.0", path: null }], join(root, "ws")).registry.get("terraform")).toBeDefined();
  });

  test("a package without the subpath supplies nothing; one not installed, or at another version, is a problem", () => {
    const root = dir({ ...pkg("plain", "1.0.0", null), ...pkg("tf-kinds", "2.0.0", [tf]) });
    const { registry, problems } = loadKindRegistry(
      [
        { package: "plain", version: "1.0.0", path: null },
        { package: "absent", version: "1.0.0", path: null },
        { package: "tf-kinds", version: "1.0.0", path: null },
      ],
      root,
    );
    expect(registry.names()).toEqual(["chant", "other", "workspace"]);
    expect(problems).toEqual([
      { pin: 1, message: "pinned package absent is not installed; install it to read the kinds it supplies" },
      { pin: 2, message: "tf-kinds is pinned at 1.0.0, and 2.0.0 is installed" },
    ]);
    expect(existsSync(join(root, "node_modules/plain/IMPORTED"))).toBe(false);
  });

  test("reads a local plugin by path, and leaves out a kind two sources both supply", () => {
    const root = dir({
      "plugins/tf/package.json": JSON.stringify({ name: "tf", exports: { "./workspace-kinds": "./k.json" } }),
      "plugins/tf/k.json": kindsFile([tf, { ...tf, name: "helm-chart", probe: { anyFile: ["Chart.yaml"] } }]),
      "plugins/tf2/package.json": JSON.stringify({ name: "tf2", exports: { "./workspace-kinds": "./k.json" } }),
      "plugins/tf2/k.json": kindsFile([tf]),
    });
    const { registry, problems } = loadKindRegistry(
      [
        { package: null, version: null, path: "plugins/tf" },
        { package: null, version: null, path: "plugins/tf2" },
      ],
      root,
    );
    expect(registry.get("helm-chart")?.source).toBe("plugins/tf");
    expect(registry.get("terraform")).toBeUndefined();
    expect(problems).toEqual([{ pin: 1, message: "kind terraform is supplied by both plugins/tf and plugins/tf2; a kind name has one source" }]);
  });

  test("a kinds subpath that names code is refused, and the code is not run", () => {
    const files = pkg("sneaky", "1.0.0", null, { exports: { "./workspace-kinds": "./index.js" } });
    const root = dir(files);
    const { problems } = loadKindRegistry([{ package: "sneaky", version: "1.0.0", path: null }], root);
    expect(problems[0].message).toMatch(/must name a \.json file/);
    expect(existsSync(join(root, "node_modules/sneaky/IMPORTED"))).toBe(false);
  });
});

describe("resolveKind: overlapping probes", () => {
  const kind = (name: string, precedence: number, file: string): MemberKind => ({
    name,
    description: name,
    precedence,
    probe: { anyFile: [file] },
    shape: "member",
    source: "test",
  });

  test("the highest precedence decides", () => {
    const registry = createKindRegistry([kind("terraform", 400, "main.tf")]);
    const tree = workingTree(dir({ "infra/main.tf": "", "infra/chant.config.ts": "" }));
    const r = resolveKind(registry, tree, "infra");
    expect(r.claims.map((k) => k.name)).toEqual(["chant", "terraform"]);
    expect(r.winner?.name).toBe("chant");
    expect(r.tie).toEqual([]);
  });

  test("equal highest precedences are a tie, and there is no winner", () => {
    const registry = createKindRegistry([kind("terraform", 400, "main.tf"), kind("opentofu", 400, "main.tf")]);
    const r = resolveKind(registry, workingTree(dir({ "main.tf": "" })), "");
    expect(r.winner).toBeUndefined();
    expect(r.tie.map((k) => k.name)).toEqual(["opentofu", "terraform"]);
  });

  test("other and examples never claim, and exclude leaves a kind out", () => {
    const tree = workingTree(dir({ "chant.workspace.json": "{}", "chant.config.ts": "" }));
    expect(resolveKind(builtinKindRegistry(), tree, "").winner?.name).toBe("workspace");
    expect(resolveKind(builtinKindRegistry(), tree, "", ["workspace"]).winner?.name).toBe("chant");
    expect(resolveKind(builtinKindRegistry(), workingTree(dir({ "README.md": "" })), "").claims).toEqual([]);
  });
});
