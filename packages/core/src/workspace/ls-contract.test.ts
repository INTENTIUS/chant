/**
 * The read contract for `chant workspace ls --json` (#2534, #2524 D15): the
 * output schema is a valid draft 2020-12 document, its closed code lists match
 * the code, and real output validates against it, for the chant repo's own
 * declaration (#2557) and for small workspaces built here.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { afterAll, describe, expect, test } from "vitest";
import { WORKSPACE_ERROR_CODES } from "./declaration";
import { GROUP_REASON_CODES, listWorkspace, LS_CONTRACT_VERSION, LS_OUTPUT_SCHEMA_ID, MEMBER_REASON_CODES, type LsDocument } from "./ls";
import schema from "./ls.schema.json";

const REPO = join(import.meta.dirname, "..", "..", "..", "..");

const ajv = new Ajv2020({ strict: true, allErrors: true });
const validate = ajv.compile(schema);

function expectValid(doc: LsDocument): void {
  const ok = validate(doc);
  expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
}

function result(doc: LsDocument): Extract<LsDocument, { members: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A git repository holding `files`. */
function repo(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-ls-")));
  scratch.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  git(root, "init", "-q");
  return root;
}

const declaration = (members: unknown[]) => JSON.stringify({ name: "acme", schema: 1, members }, null, 2);

describe("ls output schema", () => {
  test("is a valid draft 2020-12 document with the published $id", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(ajv.validateSchema(schema)).toBe(true);
    expect(schema.$id).toBe(LS_OUTPUT_SCHEMA_ID);
    expect(LS_CONTRACT_VERSION).toBe(1);
  });

  test("lists exactly the reason and error codes the code can return", () => {
    expect(schema.$defs.member.properties.reason.oneOf[1].properties!.code.enum).toEqual([...MEMBER_REASON_CODES]);
    expect(schema.$defs.group.properties.reason.oneOf[1].properties!.code.enum).toEqual([...GROUP_REASON_CODES]);
    expect(schema.$defs.failure.properties.error.properties.code.enum).toEqual([...WORKSPACE_ERROR_CODES]);
  });
});

describe("chant workspace ls on the chant repo (#2557)", () => {
  const doc = result(listWorkspace({ cwd: join(REPO, "lexicons", "aws", "examples") }));

  test("validates, from any directory below the root, with every member readable", () => {
    expectValid(doc);
    expect(doc.workspace).toMatchObject({ name: "chant", root: ".", file: "chant.workspace.json", schema: 1 });
    expect(doc.members.filter((m) => !m.readable)).toEqual([]);
  });

  test("declares every package and every lexicon as a member", () => {
    const dirs = new Set(doc.members.map((m) => m.dir));
    for (const parent of ["packages", "lexicons"]) {
      for (const d of readdirSync(join(REPO, parent), { withFileTypes: true })) {
        if (d.isDirectory()) expect(dirs.has(`${parent}/${d.name}`), `${parent}/${d.name} is not declared in chant.workspace.json`).toBe(true);
      }
    }
  });

  test("declares the examples and fixtures as example groups (ws-051)", () => {
    expect(doc.groups.map((g) => [g.name, g.glob])).toEqual([
      ["examples", ["examples/*"]],
      ["lexicon-examples", ["lexicons/*/examples/*"]],
      ["fixtures", ["test/forgejo-preview-e2e", "test/leftness"]],
    ]);
    for (const g of doc.groups) expect(g.reason, g.name).toBeNull();
    expect(doc.groups[0].matches).toContain("examples/getting-started");
    expect(doc.groups[0].skipped).toContain("examples/terraform-carve-out");
    expect(doc.groups[1].matches).toContain("lexicons/aws/examples/lambda-api");
  });
});

describe("chant workspace ls on built workspaces", () => {
  test("lists a member it can't read with a reason code, and the read still succeeds", () => {
    const root = repo({
      "chant.workspace.json": declaration([
        { name: "web", dir: "apps/web", kind: "chant", roles: [{ name: "frontend", path: "src" }] },
        { name: "gone", dir: "apps/gone", kind: "chant" },
        { name: "infra", dir: "infra", kind: "terraform" },
        { name: "tools", dir: "tools", kind: "chant" },
        { name: "vendor", dir: "vendor", kind: "other", because: "vendored" },
        { name: "examples", kind: "examples", glob: "examples/*" },
      ]),
      "apps/web/chant.config.ts": "",
      "infra/main.tf": "",
      "tools/README.md": "",
      "vendor/x.txt": "",
      "examples/README.md": "",
    });
    const doc = result(listWorkspace({ cwd: join(root, "apps", "web") }));
    expectValid(doc);
    expect(doc.members.map((m) => [m.name, m.readable, m.reason?.code ?? null])).toEqual([
      ["web", true, null],
      ["gone", false, "dir-missing"],
      ["infra", false, "unknown-kind"],
      ["tools", false, "kind-probe-failed"],
      ["vendor", true, null],
    ]);
    expect(doc.members[2].reason?.message).toMatch(/known kinds: chant, design, other, workspace/);
    expect(doc.members[0].roles).toEqual([{ name: "frontend", path: "src" }]);
    expect(doc.groups[0].reason?.code).toBe("no-matches");
    expect(doc.summary).toEqual({ members: 5, unreadable: 3, groups: 1, matches: 0 });
  });

  test("lists declared diagrams flattened across the workspace and its members (#2764)", () => {
    const root = repo({
      "chant.workspace.json": JSON.stringify({
        name: "acme",
        schema: 1,
        members: [
          {
            name: "docs",
            dir: "docs",
            kind: "other",
            because: "the docs site",
            diagrams: [
              {
                name: "architecture",
                title: "Studio architecture",
                source: "docs/diagrams/architecture.d2",
                render: "docs/diagrams/architecture.svg",
                renderer: { tool: "d2", version: "0.9.0", args: ["--layout=elk", "--theme=0", "--pad=40", "--omit-version"] },
                sourceHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
              },
            ],
          },
        ],
        diagrams: [
          {
            name: "boundary",
            title: "chant and hud",
            source: null,
            render: "docs/diagrams/boundary.svg",
            renderer: { tool: "graphviz", version: "9.0.0", args: [] },
          },
          {
            name: "flow",
            title: "Request flow",
            source: "docs/diagrams/flow.mmd",
            renderer: { tool: "mermaid", version: "11.4.1" },
          },
        ],
      }),
      "docs/README.md": "",
    });
    const doc = result(listWorkspace({ cwd: root }));
    expectValid(doc);
    expect(doc.diagrams).toEqual([
      {
        name: "boundary",
        title: "chant and hud",
        source: null,
        render: "docs/diagrams/boundary.svg",
        renderer: { tool: "graphviz", version: "9.0.0", args: [] },
        member: null,
      },
      {
        name: "flow",
        title: "Request flow",
        source: "docs/diagrams/flow.mmd",
        render: null,
        renderer: { tool: "mermaid", version: "11.4.1", args: [] },
        member: null,
      },
      {
        name: "architecture",
        title: "Studio architecture",
        source: "docs/diagrams/architecture.d2",
        render: "docs/diagrams/architecture.svg",
        renderer: { tool: "d2", version: "0.9.0", args: ["--layout=elk", "--theme=0", "--pad=40", "--omit-version"] },
        member: "docs",
      },
    ]);
  });

  test("a nested workspace member is readable by its own declaration, and ls inside it lists the inner one", () => {
    const root = repo({
      "chant.workspace.json": declaration([{ name: "kit", dir: "vendor/kit", kind: "workspace" }]),
      "vendor/kit/chant.workspace.jsonc": "// inner\n" + JSON.stringify({ name: "kit", schema: 1, members: [] }),
    });
    expect(result(listWorkspace({ cwd: root })).members[0].readable).toBe(true);
    expect(result(listWorkspace({ cwd: join(root, "vendor", "kit") })).workspace).toMatchObject({ name: "kit", root: "vendor/kit", file: "chant.workspace.jsonc" });
  });

  test("every failure validates with its code, and a parse error carries its location", () => {
    const empty = repo({});
    const ambiguous = repo({ "chant.workspace.json": declaration([]), "chant.workspace.jsonc": declaration([]) });
    const broken = repo({ "chant.workspace.json": '{\n  "name": "acme",\n  "schema": 1\n  "members": []\n}\n' });
    const invalid = repo({ "chant.workspace.json": declaration([{ name: "_members", dir: "a", kind: "chant" }]) });
    const placement = repo({ "chant.workspace.json": declaration([{ name: "a", dir: "a", kind: "chant" }, { name: "b", dir: "a/b", kind: "chant" }]) });
    const tooOld = repo({ "chant.workspace.json": JSON.stringify({ name: "acme", schema: 1, minReader: "999.0.0", members: [] }) });
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "chant-ls-nogit-")));
    scratch.push(outside);
    const docs = [
      listWorkspace({ cwd: empty }),
      listWorkspace({ cwd: ambiguous }),
      listWorkspace({ cwd: broken }),
      listWorkspace({ cwd: invalid }),
      listWorkspace({ cwd: placement }),
      listWorkspace({ cwd: tooOld }),
      listWorkspace({ cwd: outside, at: "HEAD" }),
      listWorkspace({ cwd: empty, at: "no-such-rev" }),
    ];
    for (const doc of docs) expectValid(doc);
    expect(docs.map((d) => ("error" in d ? d.error.code : "ok"))).toEqual([
      "declaration-missing",
      "declaration-ambiguous",
      "declaration-unparseable",
      "declaration-invalid",
      "placement-invalid",
      "reader-too-old",
      "not-a-git-repository",
      "revision-unknown",
    ]);
    const parseError = docs[2] as Extract<LsDocument, { error: unknown }>;
    expect(parseError.error.location).toEqual({ file: "chant.workspace.json", line: 4, column: 3 });
  });

  test("--at reads the declaration and members from a commit, offline", () => {
    const root = repo({
      "chant.workspace.json": declaration([{ name: "web", dir: "web", kind: "chant" }, { name: "ex", kind: "examples", glob: "examples/*" }]),
      "web/chant.config.ts": "",
      "examples/one/chant.config.ts": "",
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    const first = git(root, "rev-parse", "HEAD");
    // Change the working tree after the commit: --at must not see it.
    rmSync(join(root, "web"), { recursive: true });
    writeFileSync(join(root, "chant.workspace.json"), declaration([]));
    const doc = result(listWorkspace({ cwd: root, at: "HEAD" }));
    expectValid(doc);
    expect(doc.at).toBe(first);
    expect(doc.members.map((m) => [m.name, m.readable])).toEqual([["web", true]]);
    expect(doc.groups[0].matches).toEqual(["examples/one"]);
    expect(result(listWorkspace({ cwd: root })).members).toEqual([]);
  });
});

describe("chant workspace ls: generated files and job names (#3050)", () => {
  const workflow = [
    "name: ci",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "  deploy:",
    "    name: Deploy to prod",
    "    runs-on: ubuntu-latest",
    "",
  ].join("\n");
  const gitlab = ["stages: [build]", "variables:", "  A: b", ".hidden:", "  script: [x]", "api-build:", "  stage: build", "  script: [x]", ""].join("\n");

  function build(prefix: string) {
    const p = (path: string) => (prefix === "" ? path : `${prefix}/${path}`);
    const record = {
      schema: 1,
      files: [
        { path: ".github/workflows/chant-api-prod.yml", command: "chant build --components --generate github --env prod", env: "prod" },
        { path: ".gitlab/ci/chant-api-prod.gitlab-ci.yml", command: "chant build --components --generate gitlab --env prod", env: "prod" },
        { path: p("services/api/dist/out.json"), command: "chant build" },
      ],
    };
    return repo({
      [p("chant.workspace.json")]: declaration([
        { name: "api", dir: "services/api", kind: "other", because: "an api", generated: [{ path: "dist/out.json", generator: "chant build --out dist/out.json" }, { path: "NOTES.md", generator: "x", handWritten: { because: "kept by hand" } }] },
        { name: "docs", dir: "docs", kind: "other", because: "the docs" },
      ]),
      [p("services/api/.chant/generated.json")]: JSON.stringify(record),
      [p(".github/workflows/chant-api-prod.yml")]: workflow,
      [p(".gitlab/ci/chant-api-prod.gitlab-ci.yml")]: gitlab,
      [p("docs/README.md")]: "x",
    });
  }

  test("lists each member's generated files with the job names in its CI files", () => {
    const root = build("");
    const doc = result(listWorkspace({ cwd: root }));
    expectValid(doc);
    const api = doc.members.find((m) => m.name === "api")!;
    expect(api.generated).toEqual([
      { path: ".github/workflows/chant-api-prod.yml", command: "chant build --components --generate github --env prod", env: "prod", jobs: ["build", "Deploy to prod"] },
      { path: ".gitlab/ci/chant-api-prod.gitlab-ci.yml", command: "chant build --components --generate gitlab --env prod", env: "prod", jobs: ["api-build"] },
      { path: "services/api/dist/out.json", command: "chant build --out dist/out.json", env: null, jobs: null },
    ]);
    expect(doc.members.find((m) => m.name === "docs")!.generated).toEqual([]);
  });

  test("names paths from the repository root for a workspace below it", () => {
    const root = build("infra");
    const doc = result(listWorkspace({ cwd: join(root, "infra") }));
    expectValid(doc);
    const api = doc.members.find((m) => m.name === "api")!;
    expect(api.generated.map((g) => g.path)).toEqual([
      ".github/workflows/chant-api-prod.yml",
      ".gitlab/ci/chant-api-prod.gitlab-ci.yml",
      "infra/services/api/dist/out.json",
    ].sort());
    expect(api.generated.find((g) => g.path.endsWith("chant-api-prod.yml"))!.jobs).toBeNull();
  });

  test("reads the job names at a revision", () => {
    const root = build("");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "x");
    const rev = git(root, "rev-parse", "HEAD");
    const doc = result(listWorkspace({ cwd: root, at: rev }));
    expectValid(doc);
    expect(doc.members.find((m) => m.name === "api")!.generated[0].jobs).toEqual(["build", "Deploy to prod"]);
  });

  test("lists a CI file with null jobs when it can't be parsed, and nothing when there is no record", () => {
    const root = repo({
      "chant.workspace.json": declaration([{ name: "api", dir: "api", kind: "other", because: "x" }]),
      "api/.chant/generated.json": JSON.stringify({ schema: 1, files: [{ path: ".github/workflows/x.yml", command: "c" }] }),
      ".github/workflows/x.yml": "jobs: [unclosed",
    });
    const doc = result(listWorkspace({ cwd: root }));
    expectValid(doc);
    expect(doc.members[0].generated).toEqual([{ path: ".github/workflows/x.yml", command: "c", env: null, jobs: null }]);
  });
});

describe("chant workspace ls: each member's agent sessions (#3615)", () => {
  const jsonc = (agents: unknown[]) =>
    [
      "// the lobby's declaration",
      "{",
      '  "name": "acme", "schema": 1,',
      '  "members": [{ "name": "app", "dir": "app", "kind": "other", "because": "b" }, { "name": "design", "dir": "design", "kind": "other", "because": "b" }, { "name": "docs", "dir": "docs", "kind": "other", "because": "b" },],',
      `  "agents": ${JSON.stringify(agents)},`,
      "}",
    ].join("\n");
  const sessions = (doc: LsDocument) => Object.fromEntries(result(doc).members.map((m) => [m.name, m.agents]));

  test("reads a .jsonc declaration in the working tree when there is no base", () => {
    const root = repo({
      "chant.workspace.jsonc": jsonc([
        { name: "app-agent", member: "app" },
        { name: "factory", members: ["app", "design"] },
      ]),
      "app/a.txt": "",
      "design/d.txt": "",
      "docs/d.txt": "",
    });
    const doc = listWorkspace({ cwd: root });
    expectValid(doc);
    expect(sessions(doc)).toEqual({ app: ["app-agent", "factory"], design: ["factory"], docs: [] });
    expect(result(doc).workspace.agentsFrom).toBe("working-tree");
  });

  test("reads them at base, as workspace agent does, and at the revision under --at", () => {
    const root = repo({
      "chant.workspace.jsonc": jsonc([{ name: "app-agent", member: "app" }]),
      "app/a.txt": "",
      "design/d.txt": "",
      "docs/d.txt": "",
    });
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "one");
    git(root, "branch", "-M", "main");
    // A session added in the working tree binds nothing until it reaches base.
    writeFileSync(join(root, "chant.workspace.jsonc"), jsonc([{ name: "app-agent", member: "app" }, { name: "docs-agent", member: "docs" }]));
    const doc = listWorkspace({ cwd: join(root, "docs") });
    expectValid(doc);
    expect(sessions(doc)).toEqual({ app: ["app-agent"], design: [], docs: [] });
    expect(result(doc).workspace.agentsFrom).toBe("base");
    git(root, "commit", "-q", "-am", "two");
    const at = listWorkspace({ cwd: root, at: "HEAD~1" });
    expectValid(at);
    expect(sessions(at)).toEqual({ app: ["app-agent"], design: [], docs: [] });
    expect(result(at).workspace.agentsFrom).toBe("at");
    expect(sessions(listWorkspace({ cwd: root }))).toEqual({ app: ["app-agent"], design: [], docs: ["docs-agent"] });
  });
});
