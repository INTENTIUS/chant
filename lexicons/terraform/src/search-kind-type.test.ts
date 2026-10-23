/**
 * `chant search "kind:<terraform type>"` (chant #4366).
 *
 * Every terraform resource is `Terraform::Resource` on the IR, so `kind:` used
 * to match nothing finer than that. The lexicon now carries each resource's
 * type and name as `attrs.type` and `attrs.name`, and `kind:` reads the type
 * with the `::`-boundary rule moved onto `_`. The fixture
 * (`src/__fixtures__/kind-type/`) holds two `aws_instance`, an `aws_iam_role`
 * and an `aws_iam_role_policy`, whose type begins with the role's, and one
 * `data "aws_ami"`. `--count-by kind` (#4360) groups by the same type, through
 * the same function, which the last test holds it to.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildGraphIr, type GraphIR, type IRNode } from "@intentius/chant/graph-ir";
import { enrichEffectiveTopology } from "@intentius/chant/graph-effective";
import { __searchInternals, resolveKindTerms, runSearch } from "@intentius/chant/cli/handlers/search";
import { countGroups } from "@intentius/chant/cli/handlers/search-count";
import { renderTerraformRoots } from "./hcl/roots";
import { terraformPlugin } from "./plugin";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "kind-type");
const { parseQuery, matchTerm, explain } = __searchInternals;

let ir: GraphIR;

beforeAll(async () => {
  const rendered = await renderTerraformRoots({ projectRoot: FIXTURE, roots: { app: { dir: "./app" } } });
  expect(rendered.warnings).toEqual([]);
  ir = enrichEffectiveTopology(buildGraphIr(rendered.entities));
});

function search(query: string, graph: GraphIR = ir): string[] {
  const terms = parseQuery(query);
  resolveKindTerms(terms, graph.nodes);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return graph.nodes.filter((n) => terms.every((t) => matchTerm(n, t, graph, byId))).map((n) => n.id).sort();
}

describe("the lexicon's resource labels", () => {
  it("carries type and name on a resource", () => {
    const web = ir.nodes.find((n) => n.id === "app/aws_instance.web")!;
    expect(web.kind).toBe("Terraform::Resource");
    expect(web.attrs.type).toBe("aws_instance");
    expect(web.attrs.name).toBe("web");
  });

  it("carries them on a data source, without the data. prefix", () => {
    const ami = ir.nodes.find((n) => n.id === "app/data.aws_ami.base")!;
    expect(ami.attrs.type).toBe("aws_ami");
    expect(ami.attrs.name).toBe("base");
  });

  it("carries neither on any other block", () => {
    const other = ir.nodes.filter((n) => n.kind !== "Terraform::Resource" && n.kind !== "Terraform::Data");
    expect(other.length).toBeGreaterThan(0);
    for (const n of other) expect(n.attrs.type).toBeUndefined();
  });
});

describe('search "kind:<terraform type>"', () => {
  afterEach(() => vi.restoreAllMocks());

  it("kind:aws_instance returns exactly the two instances", () => {
    expect(search("kind:aws_instance")).toEqual(["app/aws_instance.web", "app/aws_instance.worker"]);
  });

  it("kind:aws_iam_role stops at the type and leaves out aws_iam_role_policy", () => {
    expect(search("kind:aws_iam_role")).toEqual(["app/aws_iam_role.app"]);
  });

  it("kind:aws_iam_role matches nothing on a graph with a policy and no role", () => {
    const noRole = { ...ir, nodes: ir.nodes.filter((n) => n.id !== "app/aws_iam_role.app") };
    expect(search("kind:aws_iam_role", noRole)).toEqual([]);
  });

  it("a trailing _ or a bare provider name is a prefix, like kind:EC2", () => {
    expect(search("kind:aws_iam_")).toEqual(["app/aws_iam_role.app", "app/aws_iam_role_policy.app"]);
    expect(search("kind:aws")).toHaveLength(4);
  });

  it("a data source is data.<type>, and kind:<type> alone is only resources", () => {
    expect(search("kind:data.aws_ami")).toEqual(["app/data.aws_ami.base"]);
    expect(search("kind:aws_ami")).toEqual([]);
    expect(search("kind:Terraform::Data")).toEqual(["app/data.aws_ami.base"]);
  });

  it("kind:<group> returns exactly what --count-by kind counts in that group (#4360)", () => {
    const groups = countGroups(ir.nodes, { by: "kind" });
    expect(groups.map((g) => g.group)).toEqual(expect.arrayContaining(["aws_instance", "aws_iam_role", "aws_iam_role_policy", "data.aws_ami"]));
    for (const { group, count } of groups) expect(search(`kind:${group}`), group).toHaveLength(count);
  });

  it("kind:Terraform::Resource still returns every resource", () => {
    expect(search("kind:Terraform::Resource")).toHaveLength(4);
    expect(search("kind:Resource")).toHaveLength(4);
  });

  it("composes with negation and edges", () => {
    expect(search("kind:aws_iam_ !kind:aws_iam_role")).toEqual(["app/aws_iam_role_policy.app"]);
    expect(search("kind:aws_iam_role_policy ->kind:aws_iam_role")).toEqual(["app/aws_iam_role_policy.app"]);
  });

  it("reads a node with no attrs.type from its address, as a live or older node", () => {
    const bare: IRNode = { id: "app/aws_instance.legacy", kind: "Terraform::Resource", lexicon: "terraform", attrs: { address: "aws_instance.legacy" } };
    expect(search("kind:aws_instance", { ...ir, nodes: [...ir.nodes, bare] })).toContain("app/aws_instance.legacy");
  });

  it("--explain counts against the type", () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const terms = parseQuery("kind:aws_instance attr:name=web");
    resolveKindTerms(terms, ir.nodes);
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    const matches = ir.nodes.filter((n) => terms.every((t) => matchTerm(n, t, ir, byId)));
    explain(terms, matches, ir, byId, "kind:aws_instance attr:name=web");
    expect(lines[0]).toBe("— 1 of 2 aws_instance matched  (query: kind:aws_instance attr:name=web)");
    expect(lines).toContain("  · excluded app/aws_instance.worker — fails attr:name=web");
  });

  it("end to end: the row shows the type", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const cwd = process.cwd();
    process.chdir(FIXTURE);
    try {
      const exit = await runSearch({ args: { path: "kind:aws_instance" } as never, plugins: [terraformPlugin], serializers: [] });
      expect(exit).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(lines.filter((l) => l.startsWith("app/"))).toEqual(["app/aws_instance.web  aws_instance", "app/aws_instance.worker  aws_instance"]);
  });
});
