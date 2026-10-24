/**
 * A member kind names a JSON Schema its member's file must pass (#3672): the
 * kinds file's memberFile block, the schema read as data from the package,
 * and WSP012 from `chant workspace check`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "./checks";
import { checkMemberFile, parseKindData, readPackageKinds } from "./kinds";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-3672-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const controlSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["estates"],
  properties: { estates: { type: "array", items: { type: "string" } } },
  additionalProperties: false,
};

const controlKind = (memberFile: unknown = { path: "terragucci.yml", schema: "schemas/control.schema.json" }) => ({
  name: "control",
  description: "a terragucci control repo, with a terragucci.yml",
  precedence: 300,
  probe: { anyFile: ["terragucci.yml"] },
  memberFile,
});

/** A kinds-only package at kinds/control, and a workspace that pins it. */
function workspace(files: Record<string, string>, opts: { schema?: string | null; kind?: unknown } = {}): string {
  const schemaText = opts.schema === undefined ? JSON.stringify(controlSchema) : opts.schema;
  return repo({
    "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, pins: [{ path: "kinds/control" }], members: [{ name: "ctl", dir: "ctl", kind: "control" }] }),
    "kinds/control/package.json": JSON.stringify({ name: "control-kinds", exports: { "./workspace-kinds": "./workspace-kinds.json" } }),
    "kinds/control/workspace-kinds.json": JSON.stringify({ schema: 1, kinds: [opts.kind ?? controlKind()] }),
    ...(schemaText === null ? {} : { "kinds/control/schemas/control.schema.json": schemaText }),
    ...files,
  });
}

const wsp012 = async (root: string) =>
  (await runDeclarationChecks(root)).diagnostics.filter((d) => d.ruleId === "WSP012" || d.ruleId === "WSP002").map((d) => `${d.ruleId}: ${d.message}`);

describe("the kinds file's memberFile block", () => {
  test("is kind data: a path in the member and a .json schema in the package", () => {
    const ok = parseKindData(JSON.stringify({ schema: 1, kinds: [controlKind()] }), "p");
    expect(ok.problems).toEqual([]);
    expect(ok.kinds[0].memberFile).toEqual({ path: "terragucci.yml", schema: "schemas/control.schema.json" });
    for (const bad of [{ path: "../x.yml", schema: "s.json" }, { path: "x.yml", schema: "s.yaml" }, { path: "x.yml", schema: "../s.json" }, { path: "x.yml" }]) {
      expect(parseKindData(JSON.stringify({ schema: 1, kinds: [controlKind(bad)] }), "p").problems).not.toEqual([]);
    }
  });

  test("reading the package compiles the schema as data, and reports one that is missing or not a schema", () => {
    const good = workspace({});
    const read = readPackageKinds(join(good, "kinds/control"));
    expect(read.problems).toEqual([]);
    expect(typeof read.kinds[0].memberFile?.validate).toBe("function");
    expect(readPackageKinds(join(workspace({}, { schema: null }), "kinds/control")).problems[0]).toMatch(/does not exist/);
    expect(readPackageKinds(join(workspace({}, { schema: "{ nope" }), "kinds/control")).problems[0]).toMatch(/is not JSON/);
    expect(readPackageKinds(join(workspace({}, { schema: JSON.stringify({ type: 12 }) }), "kinds/control")).problems[0]).toMatch(/does not compile/);
  });
});

describe("checkMemberFile", () => {
  const mf = () => readPackageKinds(join(workspace({}), "kinds/control")).kinds[0].memberFile!;
  test("parses YAML by extension and JSON otherwise, and names each failing place", () => {
    expect(checkMemberFile(mf(), "terragucci.yml", "estates: [a, b]\n")).toEqual([]);
    expect(checkMemberFile(mf(), "t.json", '{"estates":["a"]}')).toEqual([]);
    expect(checkMemberFile(mf(), "terragucci.yml", "estates: [1]\nextra: true\n").map((p) => p.message).sort()).toEqual(["/estates/0 must be string", "the file must NOT have additional properties (extra)"]);
    expect(checkMemberFile(mf(), "t.json", "estates: []")[0].message).toMatch(/^is not JSON/);
  });
});

describe("WSP012: a member's file passes its kind's schema", () => {
  test("a member whose file passes has no finding", async () => {
    expect(await wsp012(workspace({ "ctl/terragucci.yml": "estates: [prod]\n" }))).toEqual([]);
  });

  test("a file that fails the schema fails the check, once per reason", async () => {
    const report = await runDeclarationChecks(workspace({ "ctl/terragucci.yml": "estates: prod\n" }));
    expect(report.ok).toBe(false);
    const found = report.diagnostics.filter((d) => d.ruleId === "WSP012");
    expect(found.map((d) => d.message)).toEqual(["member ctl's terragucci.yml fails kind control's schema schemas/control.schema.json: /estates must be array"]);
    expect(found[0].file).toMatch(/ctl\/terragucci\.yml$/);
  });

  test("a member without the file fails it", async () => {
    // The probe also wants the file; the declared kind still names the schema, so WSP012 says what is missing.
    expect(await wsp012(workspace({ "ctl/README.md": "" }))).toEqual(["WSP012: member ctl (ctl) has no terragucci.yml, which kind control requires"]);
  });

  test("a schema that doesn't load is WSP002, and its members can't pass WSP012", async () => {
    const found = await wsp012(workspace({ "ctl/terragucci.yml": "estates: []\n" }, { schema: null }));
    expect(found).toHaveLength(2);
    expect(found[0]).toMatch(/^WSP002: .*kind control names member-file schema schemas\/control.schema.json, which does not exist/);
    expect(found[1]).toMatch(/^WSP012: .*did not load/);
  });

  test("the declaration can turn it down", async () => {
    const root = workspace({ "ctl/terragucci.yml": "nope: 1\n" });
    const decl = JSON.parse(execFileSync("cat", [join(root, "chant.workspace.json")], { encoding: "utf-8" }));
    writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ ...decl, checks: { WSP012: "warning" } }));
    const report = await runDeclarationChecks(root);
    expect(report.ok).toBe(true);
    expect(report.diagnostics.filter((d) => d.ruleId === "WSP012").every((d) => d.severity === "warning")).toBe(true);
  });
});
