/**
 * Ownership and cloud ids in `chant search` (#4534, behold#906 Q2 and Q3).
 *
 * `_ownership` is chant's marker verdict painted beside `_status`, so
 * `attr:_ownership=foreign`, `--show _ownership` and `--count-by
 * attr:_ownership` work with no grammar of their own. `id:<cloud id>` matches
 * a node's `physicalId` or one of its engine facts' `cloudIds`, exactly.
 *
 * Fixtures: a choudoufu live root read through the terraform lexicon, a k8s
 * root, and an indexed node made from a cloud listing.
 */
import { describe, expect, it } from "vitest";
import { buildLiveGraphIr, sourceOverlayGraphs, type GraphIR, type IRNode, type LiveObservation } from "../../graph-ir";
import { typeListedResource, type CloudScope, type ListedResource } from "../../lifecycle/type-listing";
import { __searchInternals, resolveKindTerms } from "./search";
import { countGroups, parseCountBy } from "./search-count";

const { parseQuery, matchTerm, termText } = __searchInternals;

/** Run a query over a graph as runSearch matches it, returning the matched ids. */
function search(ir: GraphIR, query: string): string[] {
  const terms = parseQuery(query);
  resolveKindTerms(terms, ir.nodes);
  const byId = new Map(ir.nodes.map((n) => [n.id, n]));
  return ir.nodes.filter((n) => terms.every((t) => matchTerm(n, t, ir, byId))).map((n) => n.id).sort();
}

const declaredNode = (id: string, kind: string, lexicon: string): IRNode => ({ id, kind, lexicon, attrs: {} });
const declaredGraph = (nodes: IRNode[]): GraphIR => ({ nodes, edges: [], groups: {} }) as unknown as GraphIR;

/**
 * A choudoufu live root as the terraform lexicon reads it: `bound` maps to
 * owned, `unowned` (another estate's marker) to foreign, adoptable to
 * unknown. The engine's own verdict rides on `facts`.
 */
const choudoufuRoot: LiveObservation = {
  lexicon: "terraform",
  resources: {
    "aws_s3_bucket.logs": {
      type: "aws_s3_bucket",
      status: "bound",
      physicalId: "acme-logs",
      ownership: "owned",
      attributes: { boundBy: "marker" },
      facts: { ownership: "bound", ownedBy: "marker", cloudIds: [{ kind: "import-id", value: "acme-logs" }, { kind: "arn", value: "arn:aws:s3:::acme-logs" }] },
    },
    "aws_sqs_queue.jobs": {
      type: "aws_sqs_queue",
      status: "unowned",
      physicalId: "https://sqs.us-east-1.amazonaws.com/123456789012/jobs",
      ownership: "foreign",
      attributes: { heldBy: "other-estate" },
      facts: { ownership: "unowned", cloudIds: [{ kind: "arn", value: "arn:aws:sqs:us-east-1:123456789012:jobs" }] },
    },
    "aws_iam_role.app": {
      type: "aws_iam_role",
      status: "adoptable",
      ownership: "unknown",
      attributes: { adoptTofuEstate: "acme" },
    },
  },
};

const choudoufuDeclared = declaredGraph([
  declaredNode("aws_s3_bucket.logs", "aws_s3_bucket", "terraform"),
  declaredNode("aws_sqs_queue.jobs", "aws_sqs_queue", "terraform"),
  declaredNode("aws_iam_role.app", "aws_iam_role", "terraform"),
  declaredNode("aws_eip.spare", "aws_eip", "terraform"),
]);

/** A k8s root: one declared Deployment chant labels, and an undeclared Service without chant's labels that the read still returned. */
const k8sRoot: LiveObservation = {
  lexicon: "k8s",
  resources: {
    web: { type: "K8s::Apps::Deployment", status: "Available", physicalId: "default/web", ownership: "owned", marker: { stack: "shop", env: "prod" } },
    "legacy-svc": { type: "K8s::Core::Service", status: "Active", physicalId: "default/legacy-svc", ownership: "foreign" },
  },
};
const k8sDeclared = declaredGraph([declaredNode("web", "K8s::Apps::Deployment", "k8s")]);

const awsScope: CloudScope = { substrate: "aws", scopeId: "123456789012", locations: ["us-east-1"], types: "*" };
const listedBucket: ListedResource = {
  listedType: "AWS::S3::Bucket",
  location: "us-east-1",
  nativeId: "acme-assets",
  cloudIds: [{ kind: "arn", value: "arn:aws:s3:::acme-assets" }],
  tags: {},
  properties: { BucketName: "acme-assets" },
  observedAt: "2026-10-26T00:00:00Z",
};

const overlay = (declared: GraphIR, obs: LiveObservation): GraphIR => sourceOverlayGraphs(declared, buildLiveGraphIr([obs]));

describe("_ownership: chant's marker verdict beside _status (#4534)", () => {
  it("paints owned and foreign on a choudoufu live root, and leaves unknown and unobserved nodes without it", () => {
    const ir = overlay(choudoufuDeclared, choudoufuRoot);
    const attrs = (id: string) => ir.nodes.find((n) => n.id === id)!.attrs;
    expect(attrs("aws_s3_bucket.logs")._ownership).toBe("owned");
    expect(attrs("aws_sqs_queue.jobs")._ownership).toBe("foreign");
    // adoptable reads as unknown: no verdict, no attribute.
    expect(attrs("aws_iam_role.app")).not.toHaveProperty("_ownership");
    // declared, confirmed absent: nobody observed it.
    expect(attrs("aws_eip.spare")).toMatchObject({ _status: "accent" });
    expect(attrs("aws_eip.spare")).not.toHaveProperty("_ownership");
  });

  it("is searchable with attr:, with no grammar change", () => {
    const ir = overlay(choudoufuDeclared, choudoufuRoot);
    expect(search(ir, "attr:_ownership=foreign")).toEqual(["aws_sqs_queue.jobs"]);
    expect(search(ir, "attr:_ownership=owned")).toEqual(["aws_s3_bucket.logs"]);
    expect(search(ir, "attr:_ownership")).toEqual(["aws_s3_bucket.logs", "aws_sqs_queue.jobs"]);
    expect(search(ir, "!attr:_ownership")).toEqual(["aws_eip.spare", "aws_iam_role.app"]);
  });

  it("never reads the engine's verdict", () => {
    const ir = overlay(choudoufuDeclared, choudoufuRoot);
    // facts.ownership is `unowned` and `bound`; neither is the painted value.
    expect(search(ir, "attr:_ownership=unowned")).toEqual([]);
    expect(search(ir, "attr:_ownership=bound")).toEqual([]);
  });

  it("counts by --count-by attr:_ownership, unknown in the none group", () => {
    const ir = overlay(choudoufuDeclared, choudoufuRoot);
    const by = parseCountBy("attr:_ownership");
    if ("error" in by) throw new Error(by.error);
    const groups = Object.fromEntries(countGroups(ir.nodes, by).map((g) => [g.group, g.count]));
    expect(groups).toMatchObject({ owned: 1, foreign: 1 });
    expect(Object.values(groups).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("paints a k8s root's declared object owned and an unlabelled undeclared one foreign", () => {
    const ir = overlay(k8sDeclared, k8sRoot);
    const node = (id: string) => ir.nodes.find((n) => n.id === id)!;
    expect(node("web").attrs).toMatchObject({ _status: "good", _ownership: "owned" });
    expect(node("legacy-svc").attrs).toMatchObject({ _status: "warn", _ownership: "foreign" });
    expect(search(ir, "attr:_ownership=foreign")).toEqual(["legacy-svc"]);
  });

  it("is absent on an indexed node, which carries no chant verdict", () => {
    const n = typeListedResource(awsScope, listedBucket, []);
    const ir = sourceOverlayGraphs(declaredGraph([]), { nodes: [n], edges: [], groups: {} } as unknown as GraphIR);
    expect(ir.nodes[0]!.attrs).toMatchObject({ _status: "warn" });
    expect(ir.nodes[0]!.attrs).not.toHaveProperty("_ownership");
  });
});

describe("id:<cloud id> (#4534)", () => {
  it("parses the whole rest as the id, colons and = included", () => {
    expect(parseQuery("id:arn:aws:s3:::acme-logs")).toEqual([{ kind: "id", a: "arn:aws:s3:::acme-logs" }]);
    expect(parseQuery("id:a=b")).toEqual([{ kind: "id", a: "a=b" }]);
    expect(parseQuery("ID:i-0abc123")).toEqual([{ kind: "id", a: "i-0abc123" }]);
    expect(termText(parseQuery("!id:i-0abc123")[0]!)).toContain("id:i-0abc123");
  });

  it("refuses an empty id", () => {
    expect(() => parseQuery("id:")).toThrow(/needs a cloud id/);
  });

  it("matches physicalId and engine cloudIds on a choudoufu live root, exactly", () => {
    const ir = overlay(choudoufuDeclared, choudoufuRoot);
    expect(search(ir, "id:acme-logs")).toEqual(["aws_s3_bucket.logs"]);
    expect(search(ir, "id:arn:aws:s3:::acme-logs")).toEqual(["aws_s3_bucket.logs"]);
    expect(search(ir, "id:arn:aws:sqs:us-east-1:123456789012:jobs")).toEqual(["aws_sqs_queue.jobs"]);
    // exact: no substring, no case folding
    expect(search(ir, "id:acme")).toEqual([]);
    expect(search(ir, "id:ACME-LOGS")).toEqual([]);
    expect(search(ir, "!id:acme-logs")).not.toContain("aws_s3_bucket.logs");
  });

  it("matches a k8s root's physical id", () => {
    const ir = overlay(k8sDeclared, k8sRoot);
    expect(search(ir, "id:default/web")).toEqual(["web"]);
  });

  it("matches an indexed node by its native id and by an ARN from its cloud ids", () => {
    const n = typeListedResource(awsScope, listedBucket, []);
    const ir = { nodes: [n], edges: [], groups: {} } as unknown as GraphIR;
    expect(search(ir, "id:acme-assets")).toEqual([n.id]);
    expect(search(ir, "id:arn:aws:s3:::acme-assets")).toEqual([n.id]);
  });

  it("is not what a bare word reads", () => {
    const ir = overlay(choudoufuDeclared, choudoufuRoot);
    // The ARN is only in facts.cloudIds, which the bare-word haystack leaves
    // out. (A bare `arn:...` is refused as an unknown prefix, so take its tail.)
    expect(search(ir, "123456789012:jobs")).toEqual([]);
    expect(search(ir, "id:arn:aws:sqs:us-east-1:123456789012:jobs")).toEqual(["aws_sqs_queue.jobs"]);
  });

  it("combines with _ownership: who holds this id, and is it ours", () => {
    const ir = overlay(choudoufuDeclared, choudoufuRoot);
    expect(search(ir, "id:arn:aws:sqs:us-east-1:123456789012:jobs attr:_ownership=foreign")).toEqual(["aws_sqs_queue.jobs"]);
  });
});
