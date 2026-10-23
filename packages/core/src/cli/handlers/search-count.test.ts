import { describe, it, expect } from "vitest";
import type { GraphIR, IRNode } from "../../graph-ir";
import {
  countGroups,
  formatCounts,
  groupMembers,
  groupOf,
  hasManyTerraformRoots,
  parseCountBy,
  terraformType,
  type CountBy,
} from "./search-count";

/** A Terraform block as `buildGraphIr` projects one: key `<root>/[module.x/]<address>`. */
function tf(root: string, address: string, kind: string, callers: string[] = [], extra: Record<string, unknown> = {}): IRNode {
  const id = [root, ...callers, address].join("/");
  return {
    id,
    kind,
    lexicon: "terraform",
    attrs: { address, root, ...(callers.length > 0 ? { callers } : {}), ...extra },
  } as IRNode;
}

const app = [
  tf("app", "aws_instance.web", "Terraform::Resource", [], { expansion: "count" }),
  tf("app", "aws_instance.worker", "Terraform::Resource"),
  tf("app", "aws_s3_bucket.assets", "Terraform::Resource"),
  tf("app", "data.aws_iam_policy.boundary", "Terraform::Data"),
  tf("app", "var.region", "Terraform::Variable"),
  tf("app", "aws_cloudfront_distribution.edge", "Terraform::Resource", ["module.cdn"]),
  tf("app", "aws_s3_bucket.logs", "Terraform::Resource", ["module.cdn", "module.bucket"]),
];

const sum = (groups: Array<{ count: number }>) => groups.reduce((s, g) => s + g.count, 0);

describe("--count-by parsing", () => {
  it("accepts kind, module and attr:<name>", () => {
    expect(parseCountBy("kind")).toEqual({ by: "kind" });
    expect(parseCountBy("module")).toEqual({ by: "module" });
    expect(parseCountBy("attr:region")).toEqual({ by: "attr", name: "region" });
  });

  it("refuses anything else and names the spellings", () => {
    for (const bad of ["type", "attr:", "attr", "Kind"]) {
      const r = parseCountBy(bad);
      expect("error" in r).toBe(true);
      if ("error" in r) expect(r.hint).toContain("--count-by attr:<name>");
    }
  });
});

describe("--count-by kind", () => {
  it("groups a Terraform resource by its resource type, not by Terraform::Resource", () => {
    expect(terraformType(app[0])).toBe("aws_instance");
    expect(terraformType(app[3])).toBe("data.aws_iam_policy");
    expect(terraformType(app[4])).toBeUndefined();
    const groups = countGroups(app, { by: "kind" });
    expect(groups).toEqual([
      { group: "aws_instance", count: 2 },
      { group: "aws_s3_bucket", count: 2 },
      { group: "Terraform::Variable", count: 1 },
      { group: "aws_cloudfront_distribution", count: 1 },
      { group: "data.aws_iam_policy", count: 1 },
    ]);
  });

  it("keeps the kind of every other lexicon", () => {
    const n = { id: "web", kind: "AWS::EC2::Instance", lexicon: "aws", attrs: {} } as IRNode;
    expect(groupOf(n, { by: "kind" })).toBe("AWS::EC2::Instance");
  });

  it("reads the type off the id when the address attribute is absent", () => {
    const n = { id: "app/module.cdn/aws_s3_bucket.logs~2", kind: "Terraform::Resource", lexicon: "terraform", attrs: {} } as IRNode;
    expect(terraformType(n)).toBe("aws_s3_bucket");
  });
});

describe("--count-by module", () => {
  it("takes the module from the address, and a root-module block is (root)", () => {
    expect(countGroups(app, { by: "module" })).toEqual([
      { group: "(root)", count: 5 },
      { group: "module.cdn", count: 1 },
      { group: "module.cdn.module.bucket", count: 1 },
    ]);
  });

  it("reads the call chain off the entity key when callers is not recorded", () => {
    const n = { id: "app/module.cdn/aws_s3_bucket.logs", kind: "Terraform::Resource", lexicon: "terraform", attrs: {} } as IRNode;
    expect(groupOf(n, { by: "module" })).toBe("module.cdn");
  });

  it("qualifies the module with its root when the graph holds more than one root", () => {
    const nodes = [...app, tf("network", "aws_vpc.main", "Terraform::Resource"), tf("network", "aws_subnet.a", "Terraform::Resource", ["module.cdn"])];
    const ir = { nodes, edges: [] } as unknown as GraphIR;
    expect(hasManyTerraformRoots(ir)).toBe(true);
    expect(hasManyTerraformRoots({ nodes: app, edges: [] } as unknown as GraphIR)).toBe(false);
    const groups = countGroups(nodes, { by: "module" }, true);
    expect(groups.map((g) => g.group)).toEqual([
      "app/(root)",
      "app/module.cdn",
      "app/module.cdn.module.bucket",
      "network/(root)",
      "network/module.cdn",
    ]);
  });

  it("groups a node of another lexicon by its composite, or (none)", () => {
    const inComposite = { id: "a", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {}, compositeParent: "Site" } as IRNode;
    const bare = { id: "b", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {} } as IRNode;
    expect(groupOf(inComposite, { by: "module" })).toBe("Site");
    expect(groupOf(bare, { by: "module" })).toBe("(none)");
  });
});

describe("--count-by attr:<name>", () => {
  it("counts a node lacking the attribute under (none), and the groups add up to the total", () => {
    const by: CountBy = { by: "attr", name: "expansion" };
    const groups = countGroups(app, by);
    expect(groups).toEqual([
      { group: "(none)", count: 6 },
      { group: "count", count: 1 },
    ]);
    // Never dropped: every matched node is in exactly one group.
    expect(sum(groups)).toBe(app.length);
    const lines = formatCounts(groups, by);
    expect(lines.at(-1)).toBe(`— ${app.length} total · 2 groups by attr:expansion`);
  });

  it("adds up for every grouping, on a mixed graph with gaps", () => {
    const mixed = [
      ...app,
      { id: "web", kind: "AWS::EC2::Instance", lexicon: "aws", attrs: { region: "us-east-1" } } as IRNode,
      { id: "db", kind: "AWS::RDS::DBInstance", lexicon: "aws", attrs: { region: null } } as IRNode,
      { id: "odd", kind: "", lexicon: "aws", attrs: { region: "" } } as unknown as IRNode,
    ];
    for (const by of [{ by: "kind" }, { by: "module" }, { by: "attr", name: "region" }, { by: "attr", name: "nope" }] as CountBy[]) {
      expect(sum(countGroups(mixed, by))).toBe(mixed.length);
    }
    expect(countGroups(mixed, { by: "attr", name: "region" })).toEqual([
      { group: "(none)", count: 9 },
      { group: "us-east-1", count: 1 },
    ]);
  });

  it("matches the attribute name case-insensitively, as --show does", () => {
    const n = { id: "web", kind: "AWS::EC2::Instance", lexicon: "aws", attrs: { Region: "eu-west-1" } } as IRNode;
    expect(groupOf(n, { by: "attr", name: "region" })).toBe("eu-west-1");
  });
});

describe("grouped output", () => {
  it("prints one line per group, sorted by count then name, and a total line", () => {
    const groups = countGroups(
      [
        { id: "1", kind: "B", lexicon: "x", attrs: {} },
        { id: "2", kind: "A", lexicon: "x", attrs: {} },
        { id: "3", kind: "C", lexicon: "x", attrs: {} },
        { id: "4", kind: "C", lexicon: "x", attrs: {} },
      ] as IRNode[],
      { by: "kind" },
    );
    expect(formatCounts(groups, { by: "kind" })).toEqual(["2  C", "1  A", "1  B", "— 4 total · 3 groups by kind"]);
  });

  it("right-aligns the counts", () => {
    const nodes = Array.from({ length: 11 }, (_, i) => ({ id: `n${i}`, kind: i === 0 ? "Z" : "Y", lexicon: "x", attrs: {} })) as IRNode[];
    expect(formatCounts(countGroups(nodes, { by: "kind" }), { by: "kind" })).toEqual([
      "10  Y",
      " 1  Z",
      "— 11 total · 2 groups by kind",
    ]);
  });
});

describe("--count-by --json lists each group's ids (#4382)", () => {
  it("lists the matches of each group in match order, the count is their number, and the groups are countGroups'", () => {
    for (const by of [{ by: "kind" }, { by: "module" }, { by: "attr", name: "expansion" }] as CountBy[]) {
      const groups = groupMembers(app, by);
      expect(groups.map(({ group, count }) => ({ group, count }))).toEqual(countGroups(app, by));
      for (const g of groups) expect(g.ids).toHaveLength(g.count);
      // Every match is in exactly one group.
      expect(groups.flatMap((g) => g.ids).sort()).toEqual(app.map((n) => n.id).sort());
    }
    expect(groupMembers(app, { by: "module" })[0]).toEqual({
      group: "(root)",
      count: 5,
      ids: ["app/aws_instance.web", "app/aws_instance.worker", "app/aws_s3_bucket.assets", "app/data.aws_iam_policy.boundary", "app/var.region"],
    });
  });
});
