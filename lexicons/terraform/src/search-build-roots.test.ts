/**
 * `chant search` answers over the graph `chant graph` draws, on a project
 * whose only entities are a `terraform.roots` root (chant #4365, #4368).
 *
 * The fixture is `__fixtures__/search-roots/`: one root, `net`, with a VPC,
 * two subnets, three security groups, a rule and two instances. It is
 * lint-clean, because `chant graph --format ir` refuses lint-dirty source. Every assertion runs the real `runSearch` and the real
 * `runGraph --format ir` in that directory, so the node ids compared are the
 * ones each command prints.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { GraphIR } from "@intentius/chant/graph-ir";
import { runGraph } from "@intentius/chant/cli/handlers/graph";
import { runSearch, type SearchJson } from "@intentius/chant/cli/handlers/search";
import type { LexiconPlugin } from "@intentius/chant/lexicon";
import { terraformPlugin } from "./plugin";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "search-roots");

/** Run one command in the fixture with stdout and stderr captured. */
async function inFixture(
  run: () => Promise<number>,
): Promise<{ exit: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => void out.push(String(line)));
  vi.spyOn(console, "error").mockImplementation((line: unknown) => void err.push(String(line)));
  const cwd = process.cwd();
  process.chdir(FIXTURE);
  try {
    return { exit: await run(), out, err };
  } finally {
    process.chdir(cwd);
    vi.restoreAllMocks();
  }
}

async function search(query: string, plugins: LexiconPlugin[] = [terraformPlugin]): Promise<{ exit: number; json?: SearchJson; out: string[]; err: string[] }> {
  const r = await inFixture(() => runSearch({ args: { path: query, json: true } as never, plugins, serializers: [] }));
  return { ...r, ...(r.exit === 0 ? { json: JSON.parse(r.out.join("\n")) as SearchJson } : {}) };
}

const ids = (json: SearchJson | undefined): string[] => (json?.matches ?? []).map((m) => m.id).sort();

let graph: GraphIR;

beforeAll(async () => {
  const r = await inFixture(() =>
    runGraph({ args: { command: "graph", path: ".", format: "ir" } as never, plugins: [terraformPlugin], serializers: [] }),
  );
  expect(r.exit, r.err.join("\n")).toBe(0);
  graph = JSON.parse(r.out.join("\n")) as GraphIR;
});

afterEach(() => vi.restoreAllMocks());

describe("search over a terraform.roots project (#4365, #4368)", () => {
  it("kind:Terraform::Resource returns one row per resource graph --format ir lists, with the same ids", async () => {
    const { exit, json } = await search("kind:Terraform::Resource");
    expect(exit).toBe(0);
    const drawn = graph.nodes.filter((n) => n.kind === "Terraform::Resource").map((n) => n.id).sort();
    expect(drawn.length).toBe(9);
    expect(ids(json)).toEqual(drawn);
  });

  it("attr:address=aws_security_group. returns the root's three security groups under graph's ids", async () => {
    const { json } = await search("attr:address=aws_security_group.");
    expect(ids(json)).toEqual(["net/aws_security_group.batch", "net/aws_security_group.db", "net/aws_security_group.web"]);
    const drawn = new Set(graph.nodes.map((n) => n.id));
    for (const id of ids(json)) expect(drawn.has(id)).toBe(true);
  });

  it("-> and <- follow the edges graph draws", async () => {
    // Every group references the VPC through vpc_id.
    const out = await search("attr:address=aws_security_group. ->[via=vpc_id]attr:address=aws_vpc.main");
    expect(ids(out.json)).toEqual(["net/aws_security_group.batch", "net/aws_security_group.db", "net/aws_security_group.web"]);
    const edge = graph.edges.find((e) => e.from === "net/aws_security_group.db" && e.to === "net/aws_vpc.main");
    expect(edge?.viaAttr).toBe("vpc_id");

    // The rule names db as its group and web as its source; the qualifier
    // keeps only the first.
    const ruled = await search("attr:address=aws_security_group. <-attr:address=aws_security_group_rule.");
    expect(ids(ruled.json)).toEqual(["net/aws_security_group.db", "net/aws_security_group.web"]);
    const owned = await search("attr:address=aws_security_group. <-[via=security_group_id]attr:address=aws_security_group_rule.");
    expect(ids(owned.json)).toEqual(["net/aws_security_group.db"]);

    // Transitive (#4359): the instance reaches the VPC through its subnet.
    const deep = await search("attr:address=aws_instance.db ->{2}attr:address=aws_vpc.main");
    expect(ids(deep.json)).toEqual(["net/aws_instance.db"]);
    expect(deep.json!.matches[0].paths[0].hops.length).toBe(2);
  });

  it("a bare word searches the block, not the whole .tf file in its source attribute", async () => {
    // Every node in the fixture shares one main.tf, which mentions
    // aws_security_group, so searching `source` matched all nine.
    const { json } = await search("aws_security_group");
    expect(ids(json)).toEqual([
      // References to a group in the block's body still match.
      "net/aws_instance.db",
      "net/aws_instance.web",
      "net/aws_security_group.batch",
      "net/aws_security_group.db",
      "net/aws_security_group.web",
      "net/aws_security_group_rule.db_pg",
    ]);
    // The file is still searchable when that is what the caller asks for.
    const inFile = await search("attr:source=aws_security_group");
    expect(ids(inFile.json)).toContain("net/aws_vpc.main");
  });

  it("a contributor error fails the search with that error, not (no matches)", async () => {
    const broken: LexiconPlugin = {
      ...terraformPlugin,
      buildRoots: async () => {
        throw new Error("terraform.roots.net: hcl2json could not parse main.tf");
      },
    };
    const { exit, out, err } = await search("kind:Terraform::Resource", [broken]);
    expect(exit).toBe(1);
    expect(out.join("\n")).not.toContain("no matches");
    expect(err.join("\n")).toContain("hcl2json could not parse main.tf");
  });
});
