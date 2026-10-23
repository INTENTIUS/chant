import { describe, test, expect } from "vitest";
import { applyLexiconOutputs, buildGraphIr } from "./graph-ir";
import { DECLARABLE_MARKER, type Declarable } from "./declarable";
import { AttrRef } from "./attrref";
import { LexiconOutput } from "./lexicon-output";
import { resolveAttrRefs } from "./discovery/resolve";
import { setProvenance } from "./provenance";
import { INTRINSIC_MARKER } from "./intrinsic";
import { applyDetail } from "./graph-detail";
import { buildInterpolatedString, defaultInterpolationSerializer } from "./intrinsic-interpolation";

function decl<T extends object>(base: T): Declarable & T {
  return { [DECLARABLE_MARKER]: true, ...base } as Declarable & T;
}

/** A `Ref`-style intrinsic (CloudFormation `{ Ref: name }` shape). */
function ref(targetName: string): object {
  return { [INTRINSIC_MARKER]: true, toJSON: () => ({ Ref: targetName }) };
}

describe("buildGraphIr", () => {
  test("emits a node per resource with kind, lexicon, and scrubbed attrs", () => {
    const vpc = decl({ lexicon: "gcp", entityType: "Vpc", props: { autoCreateSubnetworks: false } });
    const entities = new Map<string, Declarable>([["vpc", vpc]]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.nodes).toHaveLength(1);
    expect(ir.nodes[0]).toMatchObject({ id: "vpc", kind: "Vpc", lexicon: "gcp" });
    // `props` is flattened into attrs (field reads as the property, not props.x).
    expect(ir.nodes[0].attrs).toEqual({ autoCreateSubnetworks: false });
    // Framework fields are scrubbed out of attrs.
    expect(ir.nodes[0].attrs).not.toHaveProperty("lexicon");
    expect(ir.nodes[0].attrs).not.toHaveProperty("entityType");
  });

  test("resolves a Ref-to-node intrinsic into an edge + $ref, and lists parameter imports (#513)", () => {
    const cluster = decl({ lexicon: "aws", entityType: "AWS::CloudFormation::Parameter" });
    const service = decl({ lexicon: "aws", entityType: "AWS::ECS::Service", props: { Cluster: ref("clusterArn") } });
    const entities = new Map<string, Declarable>([
      ["clusterArn", cluster],
      ["service", service],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    // The Ref becomes a real dependency edge, not a dropped intrinsic.
    expect(ir.edges).toContainEqual({ from: "service", to: "clusterArn", kind: "ref", viaAttr: "Cluster" });
    // attrs mirror the edge as a $ref envelope, not {$intrinsic}.
    expect(ir.nodes.find((n) => n.id === "service")!.attrs.Cluster).toEqual({ $ref: "clusterArn" });
    // Parameter nodes are surfaced as import handles.
    expect(ir.imports).toEqual([{ name: "clusterArn", node: "clusterArn" }]);
  });

  test("a Ref to a non-node (pseudo-parameter) stays an opaque intrinsic — no phantom edge (#513)", () => {
    const service = decl({ lexicon: "aws", entityType: "AWS::ECS::Service", props: { Region: ref("AWS::Region") } });
    const entities = new Map<string, Declarable>([["service", service]]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.edges).toEqual([]);
    expect(ir.nodes[0].attrs.Region).toEqual({ $intrinsic: true });
    expect(ir.imports).toBeUndefined();
  });

  test("derives ref edges labelled with the consumer property", () => {
    const vpc = decl({ lexicon: "gcp", entityType: "Vpc" });
    const subnet = decl({ lexicon: "gcp", entityType: "Subnet", props: { network: new AttrRef(vpc, "id") } });
    const entities = new Map<string, Declarable>([
      ["vpc", vpc],
      ["subnet", subnet],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.edges).toEqual([{ from: "subnet", to: "vpc", kind: "ref", viaAttr: "network" }]);
    // The ref also appears in the consumer's attrs as an auditable envelope.
    expect(ir.nodes.find((n) => n.id === "subnet")!.attrs).toEqual({
      network: { $ref: "vpc.id" },
    });
  });

  test("follows a ref nested inside a property-kind declarable (a listener's forward action)", () => {
    // Regression: an inlined property-kind declarable (e.g. a Listener Action)
    // keeps its config in the NON-enumerable `props` bag. collectEdges used to
    // recurse with Object.values(), which skips `props`, so a ref buried in
    // `DefaultActions: [Action{ TargetGroupArn: tg.TargetGroupArn }]` produced
    // NO edge — the target group floated even though it deploys wired.
    const tg = decl({ lexicon: "aws", entityType: "AWS::ElasticLoadBalancingV2::TargetGroup" });
    const action = decl({
      lexicon: "aws",
      entityType: "AWS::ElasticLoadBalancingV2::Listener.Action",
      props: { Type: "forward", TargetGroupArn: new AttrRef(tg, "TargetGroupArn") },
    });
    const listener = decl({
      lexicon: "aws",
      entityType: "AWS::ElasticLoadBalancingV2::Listener",
      props: { DefaultActions: [action] },
    });
    const entities = new Map<string, Declarable>([
      ["tg", tg],
      ["listener", listener],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.edges).toContainEqual({ from: "listener", to: "tg", kind: "ref", viaAttr: "DefaultActions" });
  });

  test("treats a foreign AttrRef (different @intentius/chant copy) as a ref, not an opaque intrinsic (#511)", () => {
    // A lexicon built against a *separate* copy of chant produces AttrRefs that
    // fail `instanceof AttrRef` here but carry the global-symbol brand + shape.
    // (This is the pinhole install scenario; before #511 it flattened to
    // `{$intrinsic}` with no edge.)
    const vpc = decl({ lexicon: "aws", entityType: "Vpc" });
    const foreignRef = {
      [Symbol.for("chant.intrinsic")]: true,
      parent: new WeakRef(vpc),
      attribute: "VpcId",
      _setLogicalName() {}, // shape utils.isAttrRefLike duck-types on
      getLogicalName: () => undefined, // resolves via object identity in the reverse map
    };
    const sg = decl({ lexicon: "aws", entityType: "SecurityGroup", props: { VpcId: foreignRef } });
    const entities = new Map<string, Declarable>([
      ["vpc", vpc],
      ["sg", sg],
    ]);

    const ir = buildGraphIr(entities);
    expect(ir.edges).toEqual([{ from: "sg", to: "vpc", kind: "ref", viaAttr: "VpcId" }]);
    expect(ir.nodes.find((n) => n.id === "sg")!.attrs).toEqual({ VpcId: { $ref: "vpc.VpcId" } });
  });

  test("surfaces cross-stack exports with the producing node, not as nodes (#513)", () => {
    const cluster = decl({ lexicon: "aws", entityType: "AWS::ECS::Cluster" });
    const out = new LexiconOutput(new AttrRef(cluster, "Arn"), "ClusterArn");
    const entities = new Map<string, Declarable>([
      ["cluster", cluster],
      ["clusterArn", out as unknown as Declarable],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.nodes.map((n) => n.id)).toEqual(["cluster"]); // the output itself is not a node
    expect(ir.exports).toEqual([{ name: "ClusterArn", node: "cluster", attr: "Arn" }]);
  });

  test("excludes property-kind declarables and keeps resources", () => {
    const resource = decl({ lexicon: "k8s", entityType: "Deployment" });
    const prop = decl({ lexicon: "k8s", entityType: "Probe", kind: "property" as const });
    const entities = new Map<string, Declarable>([
      ["dep", resource],
      ["probe", prop],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.nodes.map((n) => n.id)).toEqual(["dep"]);
  });

  test("populates compositeParent and byComposite from provenance", () => {
    const sts = decl({ lexicon: "k8s", entityType: "StatefulSet" });
    const svc = decl({ lexicon: "k8s", entityType: "Service" });
    setProvenance(sts, { composite: "CockroachDbCluster", sourceFile: "/proj/src/db.ts" });
    setProvenance(svc, { composite: "CockroachDbCluster", sourceFile: "/proj/src/db.ts" });
    const entities = new Map<string, Declarable>([
      ["dbSts", sts],
      ["dbSvc", svc],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities, "/proj");
    expect(ir.nodes.every((n) => n.compositeParent === "CockroachDbCluster")).toBe(true);
    expect(ir.groups.byComposite).toEqual({ CockroachDbCluster: ["dbSts", "dbSvc"] });
    // Source file is relativized to the project root.
    expect(ir.nodes[0].sourceLoc).toEqual({ file: "src/db.ts" });
  });

  test("reads non-enumerable props like real lexicon entities", () => {
    // Real lexicon resources define lexicon/entityType/props as non-enumerable,
    // so Object.entries(entity) is empty — attrs and edges must come from props.
    const vpc = decl({ lexicon: "gcp", entityType: "Vpc" });
    const subnet = { [DECLARABLE_MARKER]: true } as Declarable & { props: unknown };
    Object.defineProperties(subnet, {
      lexicon: { value: "gcp", enumerable: false },
      entityType: { value: "Subnet", enumerable: false },
      props: { value: { cidr: "10.0.0.0/16", network: new AttrRef(vpc, "id") }, enumerable: false },
    });
    const entities = new Map<string, Declarable>([
      ["vpc", vpc],
      ["subnet", subnet],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    const subnetNode = ir.nodes.find((n) => n.id === "subnet")!;
    expect(subnetNode.attrs).toEqual({ cidr: "10.0.0.0/16", network: { $ref: "vpc.id" } });
    expect(ir.edges).toEqual([{ from: "subnet", to: "vpc", kind: "ref", viaAttr: "network" }]);
  });

  test("groups nodes by lexicon and is deterministic", () => {
    const a = decl({ lexicon: "gcp", entityType: "Vpc" });
    const b = decl({ lexicon: "k8s", entityType: "Namespace" });
    const c = decl({ lexicon: "gcp", entityType: "Subnet" });
    const entities = new Map<string, Declarable>([
      ["zeta", c],
      ["alpha", a],
      ["mid", b],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.nodes.map((n) => n.id)).toEqual(["alpha", "mid", "zeta"]); // sorted
    expect(ir.groups.byLexicon).toEqual({ gcp: ["alpha", "zeta"], k8s: ["mid"] });
    // byStack mirrors the lexicon partition today (each lexicon → one deployable
    // stack); emitted as its own axis so consumers read stacks, not lexicons (#513).
    expect(ir.groups.byStack).toEqual({ gcp: ["alpha", "zeta"], k8s: ["mid"] });

    // Same input (different insertion order) yields identical IR.
    const reordered = new Map<string, Declarable>([
      ["alpha", a],
      ["mid", b],
      ["zeta", c],
    ]);
    resolveAttrRefs(reordered);
    expect(JSON.stringify(buildGraphIr(reordered))).toEqual(JSON.stringify(ir));
  });
});

/**
 * The two duck-typed channels an entity may carry beside its `props` (#2265,
 * #2266), for a lexicon whose references are strings in someone else's syntax
 * rather than `AttrRef` objects. Asserted here with a made-up lexicon rather
 * than terraform's, because what is being checked is that this module reads
 * the channels without knowing anything about who filled them.
 */
describe("entity-declared references and stacks", () => {
  test("turns a declared reference into an edge, with both attribute names", () => {
    const vpc = decl({ lexicon: "hcl", entityType: "Vpc" });
    const subnet = decl({
      lexicon: "hcl",
      entityType: "Subnet",
      props: { vpc_id: "${aws_vpc.main.id}" },
      references: [{ to: "vpc", viaAttr: "vpc_id", toAttr: "id" }],
    });
    const entities = new Map<string, Declarable>([
      ["vpc", vpc],
      ["subnet", subnet],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.edges).toEqual([{ from: "subnet", to: "vpc", kind: "ref", viaAttr: "vpc_id", toAttr: "id" }]);
    // The reference channel is metadata about the graph, not declared config,
    // so it never lands in attrs; the string it was resolved from still does.
    expect(ir.nodes.find((n) => n.id === "subnet")!.attrs).toEqual({ vpc_id: "${aws_vpc.main.id}" });
  });

  test("drops a declared reference to a self or to something that is not a node", () => {
    const a = decl({
      lexicon: "hcl",
      entityType: "Vpc",
      references: [
        { to: "a", viaAttr: "self" },
        { to: "nowhere", viaAttr: "gone" },
      ],
    });
    const entities = new Map<string, Declarable>([["a", a]]);
    resolveAttrRefs(entities);
    expect(buildGraphIr(entities).edges).toEqual([]);
  });

  test("keys byStack by the unit an entity names, and leaves byLexicon alone", () => {
    const app = decl({ lexicon: "hcl", entityType: "Vpc", stack: "app" });
    const net = decl({ lexicon: "hcl", entityType: "Vpc", stack: "network" });
    // An entity that names no unit still falls back to the lexicon partition,
    // which is every other lexicon's behaviour and stays unchanged.
    const plain = decl({ lexicon: "gcp", entityType: "Vpc" });
    const entities = new Map<string, Declarable>([
      ["app/vpc", app],
      ["network/vpc", net],
      ["plain", plain],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.groups.byStack).toEqual({ app: ["app/vpc"], gcp: ["plain"], network: ["network/vpc"] });
    expect(ir.groups.byLexicon).toEqual({ gcp: ["plain"], hcl: ["app/vpc", "network/vpc"] });
    expect(ir.nodes.find((n) => n.id === "app/vpc")!.attrs).not.toHaveProperty("stack");
  });
});

describe("whole declarables held in an entity's fields (#3257)", () => {
  /** An entity shaped like the sql lexicon's: props non-enumerable, `dependsOn` enumerable. */
  function holder(dependsOn: unknown[], extra: object = {}) {
    const e = decl({ lexicon: "sql", entityType: "ClickHouse::Table", ...extra });
    Object.defineProperty(e, "dependsOn", { value: dependsOn, enumerable: true });
    return e;
  }

  test("draws an edge to each node named directly in an enumerable array", () => {
    const db = decl({ lexicon: "sql", entityType: "ClickHouse::Database" });
    const target = holder([db]);
    const events = holder([db]);
    const mv = holder([db, target, events]);
    const entities = new Map<string, Declarable>([
      ["analytics", db],
      ["dailyActive", target],
      ["events", events],
      ["dailyActiveMv", mv],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    const dep = (from: string, to: string) => ({ from, to, kind: "ref", viaAttr: "dependsOn" });
    expect(ir.edges).toEqual([
      dep("dailyActive", "analytics"),
      dep("dailyActiveMv", "analytics"),
      dep("dailyActiveMv", "dailyActive"),
      dep("dailyActiveMv", "events"),
      dep("events", "analytics"),
    ]);
  });

  test("does not walk into the referenced node, and projects it as a $ref", () => {
    const db = decl({ lexicon: "sql", entityType: "ClickHouse::Database", props: { name: "analytics" } });
    const events = holder([db]);
    const entities = new Map<string, Declarable>([
      ["analytics", db],
      ["events", events],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.nodes.find((n) => n.id === "events")!.attrs.dependsOn).toEqual([{ $ref: "analytics" }]);
  });

  test("an AttrRef and the whole node to the same target collapse to one edge", () => {
    const db = decl({ lexicon: "sql", entityType: "ClickHouse::Database" });
    const events = decl({ lexicon: "sql", entityType: "ClickHouse::Table" });
    const mv = holder([events, new AttrRef(events, "user_id")]);
    const entities = new Map<string, Declarable>([
      ["analytics", db],
      ["events", events],
      ["mv", mv],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.edges).toEqual([{ from: "mv", to: "events", kind: "ref", viaAttr: "dependsOn" }]);
  });

  test("ignores a self reference, and still descends into an inlined property-kind resource", () => {
    const self: Declarable = holder([]);
    (self as unknown as { dependsOn: unknown[] }).dependsOn.push(self);
    const vpc = decl({ lexicon: "aws", entityType: "Vpc" });
    const inline = decl({
      lexicon: "aws",
      entityType: "Listener_Action",
      kind: "property",
      props: { vpc: new AttrRef(vpc, "Id") },
    });
    const lb = decl({ lexicon: "aws", entityType: "Lb", props: { actions: [inline] } });
    const entities = new Map<string, Declarable>([
      ["self", self],
      ["vpc", vpc],
      ["lb", lb],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    expect(ir.edges).toEqual([{ from: "lb", to: "vpc", kind: "ref", viaAttr: "actions" }]);
  });
});

describe("applyLexiconOutputs (#3931)", () => {
  test("adds each reported output to exports on the node that declares it, keeping a hand-written export", () => {
    const orders = decl({ lexicon: "sql", entityType: "Postgres::Table", props: {} });
    const ir = buildGraphIr(new Map<string, Declarable>([["orders", orders]]));
    const withOutputs = applyLexiconOutputs({ ...ir, exports: [{ name: "public.orders", node: "orders", attr: "name" }] }, [
      {
        outputs: [
          { name: "public.orders", entity: "orders" },
          { name: "public.orders.buyer_id", entity: "orders", previously: ["public.orders.customer_id"] },
          { name: "other.thing", entity: "notANode" },
        ],
      },
    ]);
    expect(withOutputs.exports).toEqual([
      { name: "other.thing" },
      { name: "public.orders", node: "orders", attr: "name" },
      { name: "public.orders.buyer_id", node: "orders", previously: ["public.orders.customer_id"] },
    ]);
    expect(applyLexiconOutputs(ir, [{ outputs: [] }])).toBe(ir);
  });
});

/**
 * A `Sub`-tagged intrinsic shaped like the aws lexicon's `SubIntrinsic`: the
 * template parts and live values it was written with, serialized the same way.
 */
function sub(parts: TemplateStringsArray, ...values: unknown[]): object {
  const serialize = defaultInterpolationSerializer((name, attr) => `\${${name}.${attr}}`, (r) => `\${${r}}`);
  return {
    [INTRINSIC_MARKER]: true,
    values,
    toJSON: () => ({ "Fn::Sub": buildInterpolatedString([...parts], values, serialize) }),
  };
}

/** An attribute AttrRef held on its producer, as a typed lexicon's resources hold theirs, so `resolveAttrRefs` names it. */
function attr(entity: Declarable, name: string): AttrRef {
  const r = new AttrRef(entity, name);
  (entity as unknown as Record<string, unknown>)[name] = r;
  return r;
}

/** A two-argument `Sub`, as an intrinsic serializes it. */
function subWithVars(template: string, vars: Record<string, unknown>): object {
  return { [INTRINSIC_MARKER]: true, toJSON: () => ({ "Fn::Sub": [template, vars] }) };
}

describe("a reference inside a CloudFormation Sub (#4373)", () => {
  function estate(policyResource: unknown, extra: Array<[string, Declarable]> = []) {
    const assets = decl({ lexicon: "aws", entityType: "AWS::S3::Bucket" });
    const secret = decl({ lexicon: "aws", entityType: "AWS::SecretsManager::Secret" });
    const policy = decl({
      lexicon: "aws",
      entityType: "AWS::IAM::Policy",
      props: { PolicyName: "web", PolicyDocument: { Statement: [{ Effect: "Allow", Resource: policyResource }] } },
    });
    const entities = new Map<string, Declarable>([["assets", assets], ["secret", secret], ["policy", policy], ...extra]);
    resolveAttrRefs(entities);
    return { ir: buildGraphIr(entities), assets, secret };
  }

  test("${Res.Attr} is an edge through the top-level attribute, and attrs keep the template", () => {
    const assets = decl({ lexicon: "aws", entityType: "AWS::S3::Bucket" });
    const policy = decl({
      lexicon: "aws",
      entityType: "AWS::IAM::Policy",
      props: { PolicyDocument: { Statement: [{ Resource: sub`${attr(assets, "Arn")}/*` }] } },
    });
    const entities = new Map<string, Declarable>([["assets", assets], ["policy", policy]]);
    resolveAttrRefs(entities);
    const ir = buildGraphIr(entities);

    expect(ir.edges).toEqual([{ from: "policy", to: "assets", kind: "ref", viaAttr: "PolicyDocument" }]);
    const attrs = ir.nodes.find((n) => n.id === "policy")!.attrs;
    expect(attrs.PolicyDocument).toEqual({ Statement: [{ Resource: { $sub: "${assets.Arn}/*" } }] });
  });

  test("the edge is on every detail tier that carries edges; T3 names the producer attribute", () => {
    const assets = decl({ lexicon: "aws", entityType: "AWS::S3::Bucket" });
    const secret = decl({ lexicon: "aws", entityType: "AWS::SecretsManager::Secret" });
    const db = decl({
      lexicon: "aws",
      entityType: "AWS::RDS::DBInstance",
      props: {
        MasterUserPassword: sub`{{resolve:secretsmanager:${ref("secret")}}}`,
        Policy: { Resource: sub`${attr(assets, "Arn")}/*` },
      },
    });
    const entities = new Map<string, Declarable>([["assets", assets], ["secret", secret], ["db", db]]);
    resolveAttrRefs(entities);
    const ir = buildGraphIr(entities);

    const t2 = applyDetail(ir, 2);
    expect(t2.edges).toEqual([
      { from: "db", to: "assets", kind: "ref", viaAttr: "Policy" },
      { from: "db", to: "secret", kind: "ref", viaAttr: "MasterUserPassword" },
    ]);
    // A top-level Sub is a reference envelope, kept at T2 like a $ref.
    expect(t2.nodes.find((n) => n.id === "db")!.attrs.MasterUserPassword).toEqual({
      $sub: "{{resolve:secretsmanager:${secret}}}",
    });
    // T3: the producer attribute when the template names one; none for a bare ${Name}.
    expect(applyDetail(ir, 3).edges).toEqual([
      { from: "db", to: "assets", kind: "ref", viaAttr: "Policy", toAttr: "Arn" },
      { from: "db", to: "secret", kind: "ref", viaAttr: "MasterUserPassword" },
    ]);
    // T1 keeps a composite-free graph's edges.
    expect(applyDetail(ir, 1).edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["db->assets", "db->secret"]);
  });

  test("${Res} written by name in the template text is an edge too", () => {
    const { ir } = estate(sub`arn:aws:s3:::\${assets}/*`);
    expect(ir.edges).toEqual([{ from: "policy", to: "assets", kind: "ref", viaAttr: "PolicyDocument" }]);
  });

  test("a Sub with only pseudo-parameters adds no edge", () => {
    const { ir } = estate(sub`arn:aws:s3:::logs-\${AWS::Region}-\${AWS::AccountId}/*`);
    expect(ir.edges).toEqual([]);
    const statement = (ir.nodes.find((n) => n.id === "policy")!.attrs.PolicyDocument as { Statement: unknown[] }).Statement[0];
    expect(statement).toEqual({ Effect: "Allow", Resource: { $sub: "arn:aws:s3:::logs-${AWS::Region}-${AWS::AccountId}/*" } });
  });

  test("${!Escaped} is literal text, not a reference", () => {
    const { ir } = estate(sub`\${!assets}/*`);
    expect(ir.edges).toEqual([]);
  });

  test("two-argument form: the variable map's references are edges, the names it binds are not", () => {
    const { ir } = estate(
      subWithVars("${Bucket}/${assets}/${Region}", {
        Bucket: { "Fn::GetAtt": ["secret", "Arn"] },
        Region: { Ref: "AWS::Region" },
      }),
    );
    // `${assets}` is unbound, so a resource name; `${Bucket}` is the map's own.
    expect(ir.edges).toEqual([
      { from: "policy", to: "assets", kind: "ref", viaAttr: "PolicyDocument" },
      { from: "policy", to: "secret", kind: "ref", viaAttr: "PolicyDocument" },
    ]);
    const statement = (ir.nodes.find((n) => n.id === "policy")!.attrs.PolicyDocument as { Statement: unknown[] }).Statement[0];
    expect(statement).toMatchObject({
      Resource: { $sub: "${Bucket}/${assets}/${Region}", $vars: { Bucket: { "Fn::GetAtt": ["secret", "Arn"] } } },
    });
  });

  test("a Sub written as plain CloudFormation JSON, with live values in its map", () => {
    const assets = decl({ lexicon: "aws", entityType: "AWS::S3::Bucket" });
    const secret = decl({ lexicon: "aws", entityType: "AWS::SecretsManager::Secret" });
    const policy = decl({
      lexicon: "aws",
      entityType: "AWS::IAM::Policy",
      props: { Resource: { "Fn::Sub": ["${assets.Arn}/${Key}", { Key: attr(secret, "Id") }] } },
    });
    const entities = new Map<string, Declarable>([["assets", assets], ["secret", secret], ["policy", policy]]);
    resolveAttrRefs(entities);
    const ir = buildGraphIr(entities);
    expect(ir.edges).toEqual([
      { from: "policy", to: "assets", kind: "ref", viaAttr: "Resource" },
      { from: "policy", to: "secret", kind: "ref", viaAttr: "Resource" },
    ]);
    expect(ir.nodes.find((n) => n.id === "policy")!.attrs.Resource).toEqual({
      $sub: "${assets.Arn}/${Key}",
      $vars: { Key: { $ref: "secret.Id" } },
    });
    expect(applyDetail(ir, 3).edges.find((e) => e.to === "assets")!.toAttr).toBe("Arn");
  });

  test("a Sub whose AttrRef has no logical name still yields the edge from its live value", () => {
    const assets = decl({ lexicon: "aws", entityType: "AWS::S3::Bucket" });
    const unnamed = new AttrRef(assets, "Arn"); // never resolved: toJSON() throws
    const policy = decl({ lexicon: "aws", entityType: "AWS::IAM::Policy", props: { Resource: sub`${unnamed}/*` } });
    const ir = buildGraphIr(new Map<string, Declarable>([["assets", assets], ["policy", policy]]));
    expect(ir.edges).toEqual([{ from: "policy", to: "assets", kind: "ref", viaAttr: "Resource" }]);
    expect(ir.nodes.find((n) => n.id === "policy")!.attrs.Resource).toEqual({ $intrinsic: true });
  });

  test("an intrinsic that is not a Sub stays opaque", () => {
    const joinLike = { [INTRINSIC_MARKER]: true, values: [ref("assets")], toJSON: () => ({ "Fn::Join": ["", []] }) };
    const { ir } = estate(joinLike);
    expect(ir.edges).toEqual([]);
  });
});
