/**
 * #3600: a box's factory written through chant, so a box planted from a
 * shared template gets its factory.publish target at planting.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, contract, git, repo } from "./__fixtures__/contract-repo";
import { boxFactorySet, type BoxFactoryWriteDocument, type BoxFactoryWriteRequest } from "./box-factory-write";
import schema from "./box-factory-write.schema.json";
import { workspaceStatus } from "./status";

afterAll(cleanScratch);

const { expectValid } = contract(schema);

/** The template's declaration: a box whose factory builds the app and names no publish target. */
const TEMPLATE = `{
  // planted from the studio template
  "name": "fern",
  "schema": 1,
  "members": [
    { "name": "app", "dir": "app", "kind": "other", "because": "the app" },
    {
      "name": "box",
      "dir": "box",
      "kind": "other",
      "because": "the box",
      "box": {
        "factory": { "builds": ["app"], "check": "npm test" }, // no publish: the template can't know the repo
        "publisher": "node box/publish.mjs",
      },
    },
  ],
}
`;

function run(root: string, req: Omit<BoxFactoryWriteRequest, "cwd" | "fields"> & { fields?: unknown }): BoxFactoryWriteDocument {
  const doc = boxFactorySet({ ...req, cwd: root, fields: req.fields === undefined ? undefined : JSON.stringify(req.fields) });
  expectValid(doc);
  return doc;
}

const code = (doc: BoxFactoryWriteDocument) => ("error" in doc ? doc.error.code : null);

describe("box factory set (#3600)", () => {
  test("a planter sets factory.publish, status reads it back, and the file keeps its comments", async () => {
    const root = repo({ "chant.workspace.jsonc": TEMPLATE, "app/a.txt": "", "box/b.txt": "" });
    const doc = run(root, { member: "box", fields: { publish: { repo: "alex/fern", base: "main" } } });
    expect(doc).toMatchObject({
      member: "box",
      changed: true,
      paths: ["chant.workspace.jsonc"],
      previous: { builds: ["app"], publish: null },
      factory: { builds: ["app"], check: { run: "npm test", kind: "test" }, publish: { forge: "github", repo: "alex/fern", base: "main", branchPrefix: "chant/work/", head: null } },
    });
    const text = readFileSync(join(root, "chant.workspace.jsonc"), "utf-8");
    expect(text).toContain("// no publish: the template can't know the repo");
    expect(text).toContain("// planted from the studio template");
    const status = await workspaceStatus({ cwd: root, env: "box" });
    if ("error" in status) throw new Error(status.error.message);
    expect(status.members.find((m) => m.name === "box")?.box?.factory?.publish?.repo).toBe("alex/fern");

    // The same again changes nothing; null takes a field out.
    expect(run(root, { member: "box", fields: { publish: { repo: "alex/fern", base: "main" } } })).toMatchObject({ changed: false, paths: [] });
    expect(run(root, { member: "box", fields: { publish: null } })).toMatchObject({ changed: true, factory: { publish: null } });
  });

  test("a dry run writes nothing, and a box with no factory gets one", () => {
    const root = repo({
      "chant.workspace.json": `${JSON.stringify({ name: "w", schema: 1, members: [{ name: "app", dir: "app", kind: "other", because: "b", box: {} }] }, null, 2)}\n`,
      "app/a.txt": "",
    });
    const before = readFileSync(join(root, "chant.workspace.json"), "utf-8");
    expect(run(root, { member: "app", fields: { builds: ["app"], publish: { repo: "o/r" } }, dryRun: true })).toMatchObject({ changed: true, dryRun: true, previous: null });
    expect(readFileSync(join(root, "chant.workspace.json"), "utf-8")).toBe(before);
    expect(run(root, { member: "app", fields: { builds: ["app"], publish: { repo: "o/r" } } })).toMatchObject({ factory: { builds: ["app"], publish: { repo: "o/r" } } });
  });

  test("refuses an unknown member, a member with no box, a field a factory doesn't take, and a repo that isn't owner/name", () => {
    const root = repo({ "chant.workspace.jsonc": TEMPLATE, "app/a.txt": "", "box/b.txt": "" });
    const before = readFileSync(join(root, "chant.workspace.jsonc"), "utf-8");
    expect(code(run(root, { member: "ghost", fields: { publish: { repo: "o/r" } } }))).toBe("factory-member-unknown");
    expect(code(run(root, { member: "app", fields: { publish: { repo: "o/r" } } }))).toBe("factory-box-missing");
    expect(code(run(root, { member: "box", fields: { listing: {} } }))).toBe("write-input-invalid");
    const bad = run(root, { member: "box", fields: { publish: { repo: "{{chant:repo}}" } } });
    expect(code(bad)).toBe("write-input-invalid");
    expect(code(run(root, { member: "box" }))).toBe("write-usage-invalid");
    expect(readFileSync(join(root, "chant.workspace.jsonc"), "utf-8")).toBe(before);
  });

  test("a protected declaration takes the write when its except names the publish target", () => {
    const decl = (except?: string[]) => ({
      name: "w",
      schema: 1,
      members: [{ name: "app", dir: ".", kind: "other", because: "b", box: { factory: { builds: ["app"] } } }],
      writeScope: { human: { protected: [except ? { path: "chant.workspace.json", except } : "chant.workspace.json"] } },
    });
    const root = repo({ "chant.workspace.json": `${JSON.stringify(decl(), null, 2)}\n` }, true);
    git(root, "branch", "-M", "main");
    expect(code(run(root, { member: "app", fields: { publish: { repo: "o/r" } } }))).toBe("write-scope-protected");
    writeFileSync(join(root, "chant.workspace.json"), `${JSON.stringify(decl(["/members/*/box/factory/publish"]), null, 2)}\n`);
    git(root, "commit", "-q", "-am", "planting may set the publish target");
    expect(run(root, { member: "app", fields: { publish: { repo: "o/r" } } })).toMatchObject({ changed: true });
    expect(code(run(root, { member: "app", fields: { "x-note": 1 } }))).toBe("write-scope-protected");
  });
});
