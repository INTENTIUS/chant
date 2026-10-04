/**
 * The app member kind and member fields (#3151, ws-093): a data-only kinds
 * file that declares the fields its members set, a probe that reads a key of
 * a JSON file, WSP005 on a field the kind doesn't declare, and status --json
 * printing every field with its defaults.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { runDeclarationChecks } from "./checks";
import { createKindRegistry, parseKindData, probeKind, readPackageKinds, resolveKind, resolveMemberFields, type MemberKind } from "./kinds";
import { workspaceStatus } from "./status";
import { workingTree } from "./tree";

const here = dirname(fileURLToPath(import.meta.url));
const canonical = join(here, "reference-kinds", "app");
const reference = join(here, "..", "..", "..", "..", "reference-workspace");

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-3151-")));
  scratch.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

/** A workspace that pins a copy of the app kind at kinds/app. */
function appWorkspace(members: unknown[], files: Record<string, string> = {}): string {
  const root = repo({ "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, members, pins: [{ path: "kinds/app" }] }, null, 2), ...files });
  cpSync(canonical, join(root, "kinds", "app"), { recursive: true });
  return root;
}

const app = (): MemberKind => {
  const read = readPackageKinds(canonical, "kinds/app");
  expect(read.problems).toEqual([]);
  return read.kinds[0];
};

const pkg = (scripts: Record<string, string>) => JSON.stringify({ name: "web", scripts });

describe("the app kind's file", () => {
  test("is valid kind data: one kind, app, with the outputs and fields a delivery member and an orchestrator read", () => {
    const k = app();
    expect(k.name).toBe("app");
    expect(k.outputs).toEqual({ from: "declared", names: ["source", "url"] });
    expect(Object.keys(k.fields ?? {})).toEqual(["scripts", "env", "health"]);
  });

  test("the reference workspace pins a byte-for-byte copy of it", () => {
    const files = readdirSync(canonical).sort();
    expect(readdirSync(join(reference, "kinds", "app")).sort()).toEqual(files);
    for (const f of files) expect(readFileSync(join(reference, "kinds", "app", f), "utf-8")).toBe(readFileSync(join(canonical, f), "utf-8"));
  });

  test("its probe claims a Node package with a start script and nothing else, and a chant project outranks it", () => {
    const tree = workingTree(
      repo({
        "web/package.json": pkg({ start: "node server.js" }),
        "lib/package.json": pkg({ test: "node --test" }),
        "broken/package.json": "{ not json",
        "none/README.md": "",
        "both/package.json": pkg({ start: "node x.js" }),
        "both/chant.config.ts": "",
      }),
    );
    const k = app();
    expect(["web", "lib", "broken", "none"].map((d) => probeKind(k, tree, d))).toEqual([true, false, false, false]);
    const kinds = createKindRegistry([k]);
    expect(resolveKind(kinds, tree, "both").winner?.name).toBe("chant");
    expect(resolveKind(kinds, tree, "web").winner?.name).toBe("app");
  });
});

describe("anyJsonKey and fields in a kinds file", () => {
  const base = { name: "svc", description: "a service", precedence: 10, probe: { anyJsonKey: { in: ["svc.json"], pointers: ["/run", "/a~1b/c"] } } };
  const file = (kinds: unknown[]) => JSON.stringify({ schema: 1, kinds });

  test("anyJsonKey takes JSON Pointers, with ~1 for a slash in a key", () => {
    const tree = workingTree(repo({ "a/svc.json": '{"run":null}', "b/svc.json": '{"a/b":{"c":1}}', "c/svc.json": '{"a":{"b":{"c":1}}}' }));
    const k = parseKindData(file([base]), "p").kinds[0];
    expect(["a", "b", "c"].map((d) => probeKind(k, tree, d))).toEqual([true, true, false]);
  });

  test("a pointer must start with a slash, and a field's type, description and default are checked", () => {
    expect(parseKindData(file([{ ...base, probe: { anyJsonKey: { in: ["svc.json"], pointers: ["run"] } } }]), "p").problems[0]).toMatch(/pointers/);
    expect(parseKindData(file([{ ...base, fields: { port: { type: "integer", description: "the port", default: 80 } } }]), "p").problems).toEqual([]);
    expect(parseKindData(file([{ ...base, fields: { port: { type: "number", description: "the port" } } }]), "p").problems.length).toBeGreaterThan(0);
    expect(parseKindData(file([{ ...base, fields: { port: { type: "integer", description: "the port", default: "80" } } }]), "p").problems).toEqual([
      "p: kind svc declares field port whose default is \"80\", and the field is an integer",
    ]);
    expect(parseKindData(file([{ ...base, fields: { path: { type: "string", description: "a path", default: "x", pattern: "^/" } } }]), "p").problems).toEqual([
      'p: kind svc declares field path whose default is "x", which does not match ^/',
    ]);
    expect(parseKindData(file([{ ...base, fields: { path: { type: "string", description: "a path", pattern: "(" } } }]), "p").problems[0]).toMatch(/not a regular expression/);
  });
});

describe("resolveMemberFields", () => {
  test("fills every declared field from its default, and keeps what the entry sets", () => {
    const r = resolveMemberFields(app(), { health: "/healthz", scripts: { start: "serve" } });
    expect(r.problems).toEqual([]);
    expect(r.fields).toEqual({
      scripts: { start: "serve", dev: "dev", test: "test", migrate: "migrate" },
      env: { port: "PORT", data: "APP_DATA", revision: "APP_REVISION" },
      health: "/healthz",
    });
  });

  test("a field the kind doesn't declare, a value of the wrong type or pattern, and an object given a scalar are problems, and read as the default", () => {
    const r = resolveMemberFields(app(), { healthz: "/x", health: "health", env: { port: 8080, host: "x" }, scripts: "start" });
    expect(r.problems.map((p) => p.path)).toEqual(["healthz", "scripts", "env/host", "env/port", "health"]);
    expect(r.fields?.health).toBe("/health");
    expect(r.fields?.env).toEqual({ port: "PORT", data: "APP_DATA", revision: "APP_REVISION" });
  });

  test("a kind with no fields reads as null, and fields set on it are one problem; an unknown kind has nothing to check", () => {
    const other: MemberKind = { ...app(), name: "plain", fields: undefined };
    expect(resolveMemberFields(other, null)).toEqual({ fields: null, problems: [] });
    expect(resolveMemberFields(other, { health: "/" }).problems).toHaveLength(1);
    expect(resolveMemberFields(undefined, { health: "/" })).toEqual({ fields: null, problems: [] });
  });
});

describe("chant workspace check and status on an app member", () => {
  const ids = async (root: string) => (await runDeclarationChecks(root)).diagnostics.map((d) => `${d.ruleId}:${d.entity ?? ""}:${d.message}`);

  test("an app member with valid fields checks clean, and a delivery member may link to its source", async () => {
    const root = appWorkspace(
      [
        { name: "web", dir: "web", kind: "app", fields: { health: "/healthz" } },
        { name: "deploy", dir: "deploy", kind: "chant", links: [{ member: "web", output: "source" }] },
      ],
      { "web/package.json": pkg({ start: "node server.js" }), "deploy/chant.config.ts": "" },
    );
    expect(await ids(root)).toEqual([]);
  });

  test("a bad field, fields on a kind that declares none, and an app with no start script fail WSP005", async () => {
    const root = appWorkspace(
      [
        { name: "web", dir: "web", kind: "app", fields: { health: "healthz", port: 3000 } },
        { name: "lib", dir: "lib", kind: "app" },
        { name: "deploy", dir: "deploy", kind: "chant", fields: { health: "/" } },
      ],
      { "web/package.json": pkg({ start: "node server.js" }), "lib/package.json": pkg({ test: "x" }), "deploy/chant.config.ts": "" },
    );
    const found = await ids(root);
    expect(found).toHaveLength(4);
    expect(found.every((f) => f.startsWith("WSP005:"))).toBe(true);
    expect(found.join("\n")).toMatch(/web: field health is "healthz", which does not match \^\//);
    expect(found.join("\n")).toMatch(/web: kind app declares no field port/);
    expect(found.join("\n")).toMatch(/lib \(lib\) is not an app/);
    expect(found.join("\n")).toMatch(/deploy: kind chant declares no fields/);
  });

  test("an other member that is a Node package with a start script is claimed by the app kind (WSP008), and one without isn't", async () => {
    const root = appWorkspace(
      [
        { name: "server", dir: "server", kind: "other", because: "a server" },
        { name: "tools", dir: "tools", kind: "other", because: "scripts" },
      ],
      { "server/package.json": pkg({ start: "node s.js" }), "tools/package.json": pkg({ build: "x" }) },
    );
    const found = await ids(root);
    expect(found.filter((f) => f.startsWith("WSP008"))).toEqual([expect.stringMatching(/^WSP008:server:.*declare it as app/)]);
  });

  test("status --json prints each member's fields, with defaults, and null for a kind with none", async () => {
    const root = appWorkspace([
      { name: "web", dir: "web", kind: "app", fields: { scripts: { migrate: "db:migrate" } } },
      { name: "notes", dir: "notes", kind: "other", because: "notes" },
    ], { "web/package.json": pkg({ start: "node server.js" }), "notes/README.md": "" });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init"], { cwd: root });
    const doc = await workspaceStatus({ cwd: root, env: "prod" });
    if ("error" in doc) throw new Error(doc.error.message);
    const byName = Object.fromEntries(doc.members.map((m) => [m.name, m.fields]));
    expect(byName.web).toEqual({
      scripts: { start: "start", dev: "dev", test: "test", migrate: "db:migrate" },
      env: { port: "PORT", data: "APP_DATA", revision: "APP_REVISION" },
      health: "/health",
    });
    expect(byName.notes).toBeNull();
  });
});
