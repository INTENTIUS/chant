/**
 * Investigation templates (#4531): the catalog's second kind of entry. Every
 * shipped template holds to the entry kind, every path template parses as a
 * chant search query and runs against a fixture graph, and the data file is
 * exported for behold and choudoufu.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GraphIR } from "../graph-ir";
import { __searchInternals, resolveKindTerms } from "../cli/handlers/search";
import {
  CAPABILITY_TEMPLATES_FLOOR,
  TemplateCatalogError,
  expandTemplate,
  investigationTemplates,
  parseTemplates,
  type TemplateEntry,
} from "./templates";
import data from "./templates.json" with { type: "json" };

const { parseQuery, matchTerm } = __searchInternals;

/**
 * A CloudFormation project's graph: an instance in a subnet in a VPC, and a
 * security group nothing uses. Edges point from the consumer to what it
 * references. The ids share no substring, since a bare word matches by
 * substring.
 */
const node = (id: string, kind: string) => ({ id, kind, lexicon: "aws", attrs: {} });
const fixture = (): GraphIR =>
  ({
    nodes: [
      node("AppVpc", "AWS::EC2::VPC"),
      node("AppSubnet", "AWS::EC2::Subnet"),
      node("WebHost", "AWS::EC2::Instance"),
      node("SpareGroup", "AWS::EC2::SecurityGroup"),
    ],
    edges: [
      { from: "AppSubnet", to: "AppVpc", kind: "ref", viaAttr: "VpcId", toAttr: "id" },
      { from: "WebHost", to: "AppSubnet", kind: "ref", viaAttr: "SubnetId", toAttr: "id" },
    ],
    groups: {},
  }) as unknown as GraphIR;

/** Run a chant search query over a graph as runSearch matches it, returning the matched ids. */
function search(ir: GraphIR, query: string): string[] {
  const terms = parseQuery(query);
  resolveKindTerms(terms, ir.nodes);
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  return ir.nodes.filter((n) => terms.every((t) => matchTerm(n, t, ir, byId))).map((n) => n.id).sort();
}

/**
 * Each path template's run against the fixture: the inputs, and the ids the
 * query must match. A path template missing here fails the test below.
 */
const PATH_CASES: Record<string, { inputs: Record<string, string>; matches: string[] }[]> = {
  dependents: [
    { inputs: { node: "AppVpc" }, matches: ["AppSubnet", "WebHost"] },
    { inputs: { node: "WebHost" }, matches: [] },
  ],
  dependencies: [
    { inputs: { node: "WebHost" }, matches: ["AppSubnet", "AppVpc"] },
    { inputs: { node: "AppVpc" }, matches: [] },
  ],
  "paths-to-kind": [
    { inputs: { node: "WebHost", kind: "AWS::EC2::VPC" }, matches: ["WebHost"] },
    { inputs: { node: "SpareGroup", kind: "AWS::EC2::VPC" }, matches: [] },
  ],
  capability: [
    { inputs: { node: "SpareGroup", capability: "attached-to-nothing" }, matches: ["SpareGroup"] },
    { inputs: { node: "WebHost", capability: "attached-to-nothing" }, matches: [] },
  ],
  drift: [{ inputs: { node: "WebHost", env: "prod" }, matches: ["WebHost"] }],
};

/** The set behold#1027 stubbed in behold's src/graph-db/templates.ts. */
const BEHOLD_STUB = [
  "dependents",
  "dependencies",
  "paths-to-kind",
  "capability",
  "drift",
  "dependents-all",
  "dependencies-all",
  "ownership",
  "same-object",
  "readers",
  "history",
];

describe("the shipped templates", () => {
  it("parse, and are behold's stubbed set", () => {
    const templates = investigationTemplates();
    expect(templates.map((t) => t.id)).toEqual(BEHOLD_STUB);
    for (const t of templates) {
      expect(t.inputs[0], t.id).toMatchObject({ name: "node", kind: "resource" });
      expect(t.question.length, t.id).toBeGreaterThan(0);
    }
  });

  it("say which language each expands to: the in-project questions are path patterns, the cross-source ones Cypher", () => {
    const byKind = (k: string) => investigationTemplates().filter((t) => t.query.kind === k).map((t) => t.id);
    expect(byKind("path")).toEqual(["dependents", "dependencies", "paths-to-kind", "capability", "drift"]);
    expect(byKind("cypher")).toEqual(["dependents-all", "dependencies-all", "ownership", "same-object", "readers", "history"]);
  });

  it("every path template parses as a chant search query and runs against the fixture", () => {
    const paths = investigationTemplates().filter((t) => t.query.kind === "path");
    expect(Object.keys(PATH_CASES).sort()).toEqual(paths.map((t) => t.id).sort());
    for (const t of paths) {
      for (const c of PATH_CASES[t.id]!) {
        const expanded = expandTemplate(t, c.inputs);
        expect(() => parseQuery(expanded.text), `${t.id}: ${expanded.text}`).not.toThrow();
        expect(search(fixture(), expanded.text), `${t.id}: ${expanded.text}`).toEqual(c.matches);
      }
    }
  });

  it("a scope input says where the query is read and stays out of its text", () => {
    const drift = investigationTemplates().find((t) => t.id === "drift")!;
    expect(expandTemplate(drift, { node: "WebHost", env: "prod" })).toEqual({
      template: "drift",
      kind: "path",
      reads: "live",
      text: "WebHost",
      scope: { env: "prod" },
    });
  });

  it("a Cypher template binds the node as $key and splices nothing into its text", () => {
    for (const t of investigationTemplates().filter((x) => x.query.kind === "cypher")) {
      const e = expandTemplate(t, { node: "chant:app/AppVpc" });
      expect(e.text, t.id).toBe(t.query.text);
      expect(e.params, t.id).toEqual({ key: "chant:app/AppVpc" });
      expect(e.text, t.id).not.toContain("chant:app/AppVpc");
    }
  });

  it("ownership returns chant's verdict and the engine's as two columns, as behold's stub does (behold#906 Q4, behold#1031)", () => {
    const t = investigationTemplates().find((x) => x.id === "ownership")!;
    expect(t.query.text).toContain("r.ownership AS ownership");
    expect(t.query.text).toContain("r.engineOwnership AS engineOwnership");
    expect(t.query.text).not.toMatch(/coalesce\(/i);
  });

  it("refuses a value that would add a second search term, a missing input and an unknown one", () => {
    const t = investigationTemplates().find((x) => x.id === "paths-to-kind")!;
    expect(() => expandTemplate(t, { node: "WebHost", kind: "aws_vpc cap:blast" })).toThrow(/not one search term/);
    expect(() => expandTemplate(t, { node: "WebHost" })).toThrow(/needs kind/);
    expect(() => expandTemplate(t, { node: "WebHost", kind: "aws_vpc", env: "prod" })).toThrow(/takes no input env/);
  });
});

describe("the entry kind", () => {
  const valid = (): TemplateEntry => ({
    id: "t",
    title: "T",
    question: "what is it",
    inputs: [{ name: "node", kind: "resource", description: "the resource" }],
    reads: "source",
    query: { kind: "path", text: "->*{{node}}" },
  });
  const parse = (...templates: unknown[]) => parseTemplates({ version: 1, templates });
  const refuses = (patch: Record<string, unknown>, message: RegExp) =>
    expect(() => parse({ ...valid(), ...patch })).toThrow(message);

  it("reads a valid entry", () => {
    expect(parse(valid())).toEqual([valid()]);
  });

  it("refuses an entry that does not hold to it, naming the template", () => {
    expect(() => parseTemplates({ version: 2, templates: [] })).toThrow(TemplateCatalogError);
    expect(() => parse(valid(), valid())).toThrow(/template t: is defined twice/);
    refuses({ id: "Bad Id" }, /needs an id/);
    refuses({ question: "" }, /needs the question/);
    refuses({ reads: "everything" }, /reads is one of/);
    refuses({ query: { kind: "sql", text: "SELECT 1" } }, /query is/);
    refuses({ inputs: [] }, /one resource input, first/);
    refuses({ inputs: [{ name: "env", kind: "scope", description: "e" }, ...valid().inputs] }, /one resource input, first/);
    refuses({ inputs: [...valid().inputs, { name: "kind", kind: "term", description: "k" }] }, /never uses kind/);
    refuses({ query: { kind: "path", text: "->*{{other}}" } }, /names no input/);
    refuses({ query: { kind: "path", text: "->*$key" } }, /not \$parameters/);
  });

  it("holds a Cypher query to reading, with the node as $key and its inputs as parameters", () => {
    const cypher = (text: string) => ({ query: { kind: "cypher", text } });
    expect(() => parse({ ...valid(), ...cypher("MATCH (r:Resource {key: $key}) RETURN r") })).not.toThrow();
    refuses(cypher("MATCH (r:Resource {key: '{{node}}'}) RETURN r"), /never spliced/);
    refuses(cypher("MATCH (r:Resource {key: $key}) DETACH DELETE r"), /only reads/);
    refuses(cypher("RETURN 1"), /reading clause/);
    refuses(cypher("MATCH (r:Resource {key: $key} RETURN r"), /do not balance/);
    refuses(cypher("MATCH (r:Resource {key: $id}) RETURN r"), /binds the resource as \$key/);
    refuses(cypher("MATCH (r:Resource {key: $key, kind: $kind}) RETURN r"), /\$kind names no input/);
  });
});

describe("the export", () => {
  it("ships templates.json as @intentius/chant/capabilities/templates.json, the data the catalog reads", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "package.json"), "utf-8")) as { exports: Record<string, unknown> };
    expect(pkg.exports["./capabilities/templates.json"]).toBe("./src/capabilities/templates.json");
    const onDisk = JSON.parse(readFileSync(join(import.meta.dirname, "templates.json"), "utf-8")) as unknown;
    expect(onDisk).toEqual(data);
    expect(parseTemplates(onDisk)).toEqual(investigationTemplates());
  });

  it("carries its floor at 0.124.54, where it shipped", () => {
    expect(CAPABILITY_TEMPLATES_FLOOR).toBe("0.124.54");
  });
});
