/**
 * A project's own investigation templates (behold#1142): `templateCatalog(dir)`
 * reads `.chant/templates.json` at the workspace root, or at the project root
 * with no workspace, lists its entries after chant's with their origin, and
 * refuses a bad entry alone, naming the file and the field.
 *
 * Every project is a mkdtemp directory; nothing here touches the repository.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHANT_TEMPLATES_FILE,
  PROJECT_TEMPLATES_FILE,
  PROJECT_TEMPLATES_FLOOR,
  TemplateCatalogError,
  investigationTemplates,
  parseTemplates,
  templateCatalog,
  templatesRoot,
  type TemplateEntry,
} from "./templates";
import { NEXT_RELEASE } from "../release-floors";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A project root: a package.json, and `.chant/templates.json` holding `doc` (a string is written as is). */
function project(doc?: unknown, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-project-templates-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), "{}");
  if (doc !== undefined) writeTemplates(dir, doc);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

function writeTemplates(dir: string, doc: unknown): void {
  mkdirSync(join(dir, ".chant"), { recursive: true });
  writeFileSync(join(dir, PROJECT_TEMPLATES_FILE), typeof doc === "string" ? doc : JSON.stringify(doc));
}

const bucketReaders = (): TemplateEntry => ({
  id: "bucket-readers",
  title: "Bucket readers",
  question: "which functions read this bucket",
  kinds: ["AWS::S3::Bucket", "aws_s3_bucket"],
  inputs: [{ name: "node", kind: "resource", description: "the bucket" }],
  reads: "session",
  query: { kind: "cypher", text: "MATCH (f:Resource)-[:REF]->(b:Resource {key: $key}) RETURN DISTINCT f.key AS key" },
});

const reachesTable = (): TemplateEntry => ({
  id: "reaches-table",
  title: "Reaches a table",
  question: "does this resource reach a DynamoDB table",
  inputs: [{ name: "node", kind: "resource", description: "the resource" }],
  reads: "source",
  query: { kind: "path", text: "{{node}} ->*kind:AWS::DynamoDB::Table" },
});

const file = (...templates: unknown[]) => ({ version: 1, templates });
const chantIds = () => investigationTemplates().map((t) => t.id);

describe("templateCatalog", () => {
  it("is chant's templates alone, each marked chant, when the project has no file", () => {
    const { templates, refused } = templateCatalog(project());
    expect(templates.map((t) => t.id)).toEqual(chantIds());
    expect(templates.every((t) => t.origin === "chant")).toBe(true);
    expect(refused).toEqual([]);
  });

  it("lists a project's templates after chant's, each marked project, kinds kept", () => {
    const { templates, refused } = templateCatalog(project(file(bucketReaders(), reachesTable())));
    expect(refused).toEqual([]);
    expect(templates.map((t) => t.id)).toEqual([...chantIds(), "bucket-readers", "reaches-table"]);
    const own = templates.filter((t) => t.origin === "project");
    expect(own).toEqual([
      { ...bucketReaders(), origin: "project" },
      { ...reachesTable(), origin: "project" },
    ]);
  });

  it("reads the file at the project root from a folder below it", () => {
    const dir = project(file(reachesTable()), { "src/stack/main.ts": "" });
    expect(templatesRoot(join(dir, "src", "stack"))).toBe(dir);
    expect(templateCatalog(join(dir, "src", "stack")).templates.at(-1)).toMatchObject({ id: "reaches-table", origin: "project" });
  });

  it("an entry marked chant in the project file is still the project's", () => {
    const { templates } = templateCatalog(project(file({ ...reachesTable(), origin: "chant" })));
    expect(templates.at(-1)).toMatchObject({ id: "reaches-table", origin: "project" });
  });

  it("refuses a malformed entry alone, naming the file and the field, and loads the rest", () => {
    const cases: [Record<string, unknown>, string, RegExp][] = [
      [{ id: "Bad Id" }, "templates[0].id", /needs an id/],
      [{ title: "" }, "templates[0].title", /needs a title/],
      [{ question: 3 }, "templates[0].question", /needs the question/],
      [{ reads: "everything" }, "templates[0].reads", /reads is one of source, live, snapshots, session/],
      [{ kinds: [] }, "templates[0].kinds", /kinds is a list of node kinds/],
      [{ kinds: "AWS::S3::Bucket" }, "templates[0].kinds", /kinds is a list of node kinds/],
      [{ sources: [1] }, "templates[0].sources", /sources is a list/],
      [{ note: "" }, "templates[0].note", /a note is text/],
      [{ inputs: "node" }, "templates[0].inputs", /needs its inputs/],
      [{ inputs: [{ name: "node", kind: "resource" }] }, "templates[0].inputs[0].description", /needs a description/],
      [{ inputs: [{ name: "node", kind: "thing", description: "d" }] }, "templates[0].inputs[0].kind", /kind is one of resource, scope, term/],
      [{ inputs: [{ name: "env", kind: "scope", description: "e" }, ...reachesTable().inputs] }, "templates[0].inputs", /one resource input, first/],
      [{ query: { kind: "sql", text: "SELECT 1" } }, "templates[0].query.kind", /query is/],
      [{ query: { kind: "path" } }, "templates[0].query.text", /query is/],
      [{ query: { kind: "path", text: "{{node}} ->*kind:{{kind}}" } }, "templates[0].query.text", /\{\{kind\}\} names no input/],
    ];
    for (const [patch, field, message] of cases) {
      const { templates, refused } = templateCatalog(project(file({ ...reachesTable(), ...patch }, bucketReaders())));
      expect(refused, field).toHaveLength(1);
      expect(refused[0].file).toBe(PROJECT_TEMPLATES_FILE);
      expect(refused[0].field).toBe(field);
      expect(refused[0].message).toMatch(message);
      expect(refused[0].message.startsWith(`${PROJECT_TEMPLATES_FILE} ${field}: `), refused[0].message).toBe(true);
      expect(templates.map((t) => t.id), field).toEqual([...chantIds(), "bucket-readers"]);
    }
  });

  it("keeps a project template read-only, and allows any reads chant's own use, live included", () => {
    const writes = templateCatalog(
      project(file({ ...bucketReaders(), query: { kind: "cypher", text: "MATCH (r:Resource {key: $key}) SET r.owner = 'me' RETURN r" } })),
    );
    expect(writes.refused).toMatchObject([{ id: "bucket-readers", field: "templates[0].query.text", message: expect.stringMatching(/only reads/) }]);
    expect(writes.templates.some((t) => t.origin === "project")).toBe(false);

    const reads = [...new Set(investigationTemplates().map((t) => t.reads))];
    expect(reads).toContain("live");
    const own = reads.map((r, i) => ({ ...reachesTable(), id: `reads-${i}`, reads: r }));
    const { templates, refused } = templateCatalog(project(file(...own)));
    expect(refused).toEqual([]);
    expect(templates.filter((t) => t.origin === "project").map((t) => t.reads)).toEqual(reads);
  });

  it("refuses a project template with one of chant's ids, naming both files", () => {
    const { templates, refused } = templateCatalog(project(file(reachesTable(), { ...bucketReaders(), id: "dependents" })));
    expect(refused).toEqual([
      {
        id: "dependents",
        file: PROJECT_TEMPLATES_FILE,
        field: "templates[1].id",
        message: expect.stringContaining(CHANT_TEMPLATES_FILE),
      },
    ]);
    expect(refused[0].message).toMatch(/^\.chant\/templates\.json templates\[1\]\.id: template dependents: .*rename this one$/);
    expect(templates.filter((t) => t.id === "dependents")).toEqual([{ ...investigationTemplates().find((t) => t.id === "dependents"), origin: "chant" }]);
    expect(templates.at(-1)?.id).toBe("reaches-table");
  });

  it("keeps the first of two project entries with one id and refuses the second", () => {
    const { templates, refused } = templateCatalog(project(file(reachesTable(), { ...reachesTable(), title: "Again" })));
    expect(refused).toMatchObject([{ id: "reaches-table", field: "templates[1].id", message: expect.stringMatching(/is defined twice/) }]);
    expect(templates.filter((t) => t.id === "reaches-table")).toMatchObject([{ title: "Reaches a table" }]);
  });

  it("refuses a file that is not a templates file whole, as one entry, and keeps chant's", () => {
    const cases: [unknown, string | undefined, RegExp][] = [
      ["{ not json", undefined, /^\.chant\/templates\.json: is not JSON/],
      [[], undefined, /a templates file is an object/],
      [{ version: 2, templates: [] }, "version", /^\.chant\/templates\.json version: templates file version 2 is not 1/],
      [{ version: 1, templates: {} }, "templates", /templates is a list/],
    ];
    for (const [doc, field, message] of cases) {
      const { templates, refused } = templateCatalog(project(doc));
      expect(refused).toHaveLength(1);
      expect(refused[0].file).toBe(PROJECT_TEMPLATES_FILE);
      expect(refused[0].field).toBe(field);
      expect(refused[0].message).toMatch(message);
      expect(templates.map((t) => t.id)).toEqual(chantIds());
    }
  });

  it("in a workspace reads the root's file, from the root and from a member, and never a member's own", () => {
    const root = mkdtempSync(join(tmpdir(), "chant-workspace-templates-"));
    dirs.push(root);
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ members: [{ dir: "infra" }] }));
    writeTemplates(root, file(reachesTable()));
    const member = join(root, "infra");
    mkdirSync(member);
    writeFileSync(join(member, "package.json"), "{}");
    writeFileSync(join(member, "chant.config.ts"), "export default {};");
    writeTemplates(member, file(bucketReaders()));

    for (const dir of [root, member, join(member, ".chant")]) {
      expect(templatesRoot(dir)).toBe(root);
      const own = templateCatalog(dir).templates.filter((t) => t.origin === "project").map((t) => t.id);
      expect(own, dir).toEqual(["reaches-table"]);
    }
  });
});

describe("parseTemplates with a file", () => {
  it("names the file and the field in the error it throws", () => {
    try {
      parseTemplates(file({ ...reachesTable(), reads: "all" }), PROJECT_TEMPLATES_FILE);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateCatalogError);
      expect((e as TemplateCatalogError).file).toBe(PROJECT_TEMPLATES_FILE);
      expect((e as TemplateCatalogError).field).toBe("templates[0].reads");
      expect((e as Error).message).toBe(".chant/templates.json templates[0].reads: template reaches-table: reads is one of source, live, snapshots, session");
    }
  });

  it("without a file keeps the message it had, with the field set", () => {
    try {
      parseTemplates(file(reachesTable(), reachesTable()));
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("template reaches-table: is defined twice");
      expect((e as TemplateCatalogError).field).toBe("templates[1].id");
    }
  });

  it("ships its floor as the next release", () => {
    expect(PROJECT_TEMPLATES_FLOOR).toBe(NEXT_RELEASE);
  });
});
