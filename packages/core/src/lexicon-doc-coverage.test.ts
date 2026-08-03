/**
 * Every optional `LexiconPlugin` member is documented (#1347).
 *
 * The authoring overview's member table had drifted to 16 of roughly 30. The
 * whole observation family beyond `describeResources` and
 * `observeResourcesDeep` was absent, along with `auditCatalog` (10 adopters),
 * `upstreamPin` (4), `generateComponentPipeline` (3) and `emulator` — so the
 * page a lexicon author reads to learn what they *can* implement omitted half
 * of it, silently, in the direction that loses capabilities rather than
 * inventing them.
 *
 * A table maintained by hand beside an interface drifts. This reads the members
 * out of `lexicon.ts` and requires a row for each, the same shape as the
 * completeness checklist's guard (#1343).
 */

import { describe, test, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import * as ts from "typescript";

const LEXICON_TS = join(__dirname, "lexicon.ts");
const OVERVIEW = join(
  __dirname,
  "../../../docs/src/content/docs/lexicon-authoring/overview.mdx",
);

/** The required members, which the page documents in its own two tables. */
const REQUIRED = new Set(["name", "serializer", "generate", "validate", "coverage", "package"]);

/** Optional member names declared on the `LexiconPlugin` interface. */
function optionalMembers(): string[] {
  const source = ts.createSourceFile(
    "lexicon.ts",
    readFileSync(LEXICON_TS, "utf-8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === "LexiconPlugin") {
      for (const member of node.members) {
        const name = member.name && ts.isIdentifier(member.name) ? member.name.text : undefined;
        if (!name || REQUIRED.has(name)) continue;
        const optional =
          (ts.isPropertySignature(member) || ts.isMethodSignature(member)) &&
          member.questionToken !== undefined;
        if (optional) names.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** Member names appearing in a table row's first cell. */
function documentedMembers(markdown: string): Set<string> {
  const found = new Set<string>();
  for (const line of markdown.split("\n")) {
    const match = /^\|\s*`([A-Za-z]+)(\(|`)/.exec(line);
    if (match) found.add(match[1]);
  }
  return found;
}

describe("the authoring overview documents every optional member (#1347)", () => {
  const members = optionalMembers();
  const documented = documentedMembers(readFileSync(OVERVIEW, "utf-8"));

  test("the interface is being parsed at all", () => {
    // A parsing regression would make the coverage assertion vacuously true.
    expect(members.length).toBeGreaterThan(20);
    expect(members).toContain("describeResources");
    expect(members).toContain("emulator");
  });

  test("no optional member is missing a row", () => {
    expect(members.filter((m) => !documented.has(m))).toEqual([]);
  });

  test("the members the audit found undocumented are now covered", () => {
    // Named explicitly: these were the eight with zero authoring-doc hits, and
    // a regression on any of them should say which.
    for (const member of [
      "auditCatalog",
      "upstreamPin",
      "generateComponentPipeline",
      "observeDependencies",
      "ambientKinds",
      "observeAmbient",
      "describeStackStatus",
      "codeActionProvider",
    ]) {
      expect(documented.has(member), `${member} has no row`).toBe(true);
    }
  });
});

describe("no member's docblock documents a different member (#1347)", () => {
  const source = readFileSync(LEXICON_TS, "utf-8");

  test("observeResourcesDeep carries the deep-read docblock", () => {
    // It sat above `observeDependencies`, leaving the deep reader undocumented
    // in the file that defines it.
    const index = source.indexOf("observeResourcesDeep?(options: {");
    const preceding = source.slice(Math.max(0, index - 2000), index);
    expect(preceding).toContain("Read the full live *property tree*");
  });

  test("observeAmbient carries the ambient docblock", () => {
    const index = source.indexOf("observeAmbient?(options: {");
    const preceding = source.slice(Math.max(0, index - 2000), index);
    expect(preceding).toContain("Report resources of a kind this estate manages");
  });

  test("observeDependencies carries its own", () => {
    const index = source.indexOf("observeDependencies?(options: {");
    const preceding = source.slice(Math.max(0, index - 2000), index);
    expect(preceding).toContain("Report the undeclared resources this estate");
  });

  test("ambientKinds carries its own", () => {
    const index = source.indexOf("ambientKinds?(): string[];");
    const preceding = source.slice(Math.max(0, index - 1200), index);
    expect(preceding).toContain("Kinds this lexicon can enumerate");
  });
});
