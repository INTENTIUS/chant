/**
 * Member views composed into one (#4378): each member's chant builds its own
 * view and prints it; the workspace's chant prefixes the ids, joins the
 * views and resolves the ARNs one member names in another.
 */
import { describe, expect, it } from "vitest";
import type { GraphIR } from "../graph-ir";
import { buildView, composeViews, isViewDocument, prefixView, serializeView, type CapabilityPack } from "./view";

const pack: CapabilityPack = {
  mapping: {
    lexicon: "test",
    labels: { "T::Policy": "Policy", "T::Bucket": "Bucket" },
    attrs: { Bucket: { name: "BucketName" } },
    documents: { Policy: { Doc: "permission" } },
  },
};

const ir = (nodes: { id: string; kind: string; attrs: Record<string, unknown> }[]): GraphIR =>
  ({ nodes: nodes.map((n) => ({ ...n, lexicon: "test" })), edges: [], groups: {} }) as unknown as GraphIR;

const policy = ir([
  {
    id: "pol",
    kind: "T::Policy",
    attrs: {
      Doc: {
        Statement: [
          { Effect: "Allow", Action: "s3:GetObject", Resource: ["arn:aws:s3:::shared/*", "arn:aws:s3:::nowhere"] },
        ],
      },
    },
  },
]);
const bucket = ir([{ id: "bkt", kind: "T::Bucket", attrs: { BucketName: "shared" } }]);

/** A member's view as it travels: serialized by the member's chant, read back as JSON. */
const printed = (g: GraphIR) => JSON.parse(JSON.stringify(serializeView(buildView(g, [pack])))) as unknown;

describe("member views", () => {
  it("keeps an ARN that names nothing in the member, and prints a view a reader recognizes", () => {
    const v = buildView(policy, [pack]);
    expect(v.edges.filter((e) => e.name === "resource")).toEqual([]);
    expect(v.unresolved).toEqual([
      { from: "pol#Doc[0].Statement[0]", fromAttr: "Resource[0]", edge: "resource", value: "arn:aws:s3:::shared/*" },
      { from: "pol#Doc[0].Statement[0]", fromAttr: "Resource[1]", edge: "resource", value: "arn:aws:s3:::nowhere" },
    ]);
    expect(isViewDocument(printed(policy))).toBe(true);
    expect(isViewDocument({ ...(printed(policy) as object), version: 2 })).toBe(false);
    expect(isViewDocument(undefined)).toBe(false);
  });

  it("resolves an ARN inside the member it names, leaving nothing for the composer", () => {
    const both = ir([...policy.nodes, ...bucket.nodes] as never);
    const v = buildView(both, [pack]);
    expect(v.edges.filter((e) => e.name === "resource").map((e) => [e.from, e.to])).toEqual([["pol#Doc[0].Statement[0]", "bkt"]]);
    expect(v.unresolved!.map((u) => u.value)).toEqual(["arn:aws:s3:::nowhere"]);
  });

  it("composes views under member ids and resolves an ARN across members", () => {
    const a = printed(policy);
    const b = printed(bucket);
    if (!isViewDocument(a) || !isViewDocument(b)) throw new Error("not a view document");
    const v = composeViews([prefixView(a, "platform/"), prefixView(b, "data/")]);
    expect([...v.nodes.keys()].sort()).toEqual(["data/bkt", "platform/pol", "platform/pol#Doc[0].Statement[0]"]);
    expect(v.nodes.get("platform/pol#Doc[0].Statement[0]")!.irId).toBe("platform/pol");
    expect(v.edges.find((e) => e.name === "resource")).toEqual({
      from: "platform/pol#Doc[0].Statement[0]",
      to: "data/bkt",
      name: "resource",
      hops: [{ from: "platform/pol#Doc[0].Statement[0]", fromAttr: "Resource[0]", to: "data/bkt", edge: "resource" }],
    });
    expect(v.edges.find((e) => e.name === "statement")!.hops[0]).toMatchObject({ from: "platform/pol", to: "platform/pol#Doc[0].Statement[0]" });
    expect(v.unresolved!.map((u) => [u.from, u.value])).toEqual([["platform/pol#Doc[0].Statement[0]", "arn:aws:s3:::nowhere"]]);
  });
});
