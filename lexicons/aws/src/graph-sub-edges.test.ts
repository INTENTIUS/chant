/**
 * A reference inside a CloudFormation `Sub` is a graph edge (chant #4373).
 *
 * The estate is the shape #4361 measured on: an IAM policy granting
 * `${bucket.Arn}/*` and a database whose password is a
 * `{{resolve:secretsmanager:${Ref(secret)}}}` reference. Before #4373 both
 * were `{ "$intrinsic": true }` with no edge, so a search walking from the
 * policy to a bucket found nothing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Declarable } from "@intentius/chant/declarable";
import { resolveAttrRefs } from "@intentius/chant/discovery/resolve";
import { buildGraphIr, type GraphIR } from "@intentius/chant/graph-ir";
import { applyDetail } from "@intentius/chant/graph-detail";
import { __searchInternals, resolveKindTerms } from "@intentius/chant/cli/handlers/search";
import { Bucket, DbInstance, Policy, Ref, Role, Secret, Sub, AWS } from "./index";

const { parseQuery, matchTerm, explain } = __searchInternals;

function estate(): GraphIR {
  const assets = new Bucket({});
  const webRole = new Role({ AssumeRolePolicyDocument: { Statement: [] } });
  const dbSecret = new Secret({});
  const webPolicy = new Policy({
    PolicyName: "web",
    Roles: [Ref(webRole)],
    PolicyDocument: {
      Statement: [
        { Effect: "Allow", Action: "s3:GetObject", Resource: Sub`${assets.Arn}/*` },
        { Effect: "Allow", Action: "logs:PutLogEvents", Resource: Sub`arn:aws:logs:${AWS.Region}:${AWS.AccountId}:*` },
      ],
    },
  });
  const customersDb = new DbInstance({
    Engine: "postgres",
    DBInstanceClass: "db.t3.micro",
    MasterUserPassword: Sub`{{resolve:secretsmanager:${Ref(dbSecret)}}}`,
  });
  const entities = new Map<string, Declarable>([
    ["assets", assets],
    ["webRole", webRole],
    ["dbSecret", dbSecret],
    ["webPolicy", webPolicy],
    ["customersDb", customersDb],
  ] as Array<[string, Declarable]>);
  resolveAttrRefs(entities);
  return buildGraphIr(entities);
}

function search(ir: GraphIR, query: string): string[] {
  const terms = parseQuery(query);
  resolveKindTerms(terms, ir.nodes);
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  return ir.nodes.filter((n) => terms.every((t) => matchTerm(n, t, ir, byId))).map((n) => n.id).sort();
}

describe("a Sub reference in an aws project (#4373)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is an edge from the holder through its top-level attribute, at tiers 1 to 3", () => {
    const ir = estate();
    for (const tier of [1, 2, 3] as const) {
      const edges = applyDetail(ir, tier).edges.map((e) => `${e.from} -${e.viaAttr}-> ${e.to}`);
      expect(edges).toContain("webPolicy -PolicyDocument-> assets");
      expect(edges).toContain("customersDb -MasterUserPassword-> dbSecret");
    }
    const t3 = applyDetail(ir, 3).edges.find((e) => e.from === "webPolicy" && e.to === "assets");
    expect(t3).toEqual({ from: "webPolicy", to: "assets", kind: "ref", viaAttr: "PolicyDocument", toAttr: "Arn" });
  });

  it("carries the template in a $sub envelope at --detail 3", () => {
    const ir = applyDetail(estate(), 3);
    const policy = ir.nodes.find((n) => n.id === "webPolicy")!;
    const statements = (policy.attrs.PolicyDocument as { Statement: Array<{ Resource: unknown }> }).Statement;
    expect(statements[0].Resource).toEqual({ $sub: "${assets.Arn}/*" });
    expect(statements[1].Resource).toEqual({ $sub: "arn:aws:logs:${AWS::Region}:${AWS::AccountId}:*" });
    const db = ir.nodes.find((n) => n.id === "customersDb")!;
    expect(db.attrs.MasterUserPassword).toEqual({ $sub: "{{resolve:secretsmanager:${dbSecret}}}" });
  });

  it("a pseudo-parameter-only Sub adds no edge", () => {
    const fromPolicy = estate().edges.filter((e) => e.from === "webPolicy").map((e) => e.to).sort();
    expect(fromPolicy).toEqual(["assets", "webRole"]);
  });

  it('search "->*kind:AWS::S3::Bucket" follows the edge, and --explain prints it', () => {
    const ir = estate();
    expect(search(ir, "->*kind:AWS::S3::Bucket")).toEqual(["webPolicy"]);

    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    const query = "->*kind:AWS::S3::Bucket";
    const terms = parseQuery(query);
    resolveKindTerms(terms, ir.nodes);
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    const matches = ir.nodes.filter((n) => terms.every((t) => matchTerm(n, t, ir, byId)));
    explain(terms, matches, ir, byId, query);
    expect(lines.join("\n")).toContain("path webPolicy.PolicyDocument -> assets");
  });
});
