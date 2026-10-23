/**
 * The capability catalog over CloudFormation kinds (#4375).
 *
 * `testdata/capabilities-ledger/estate.ts` is the CloudFormation form of the
 * estate chant#4361 measured the rule language on. Its hand-checked answers
 * are identity reach 13, exfiltration 3 and blast radius 15, the same as the
 * Terraform form's (lexicons/terraform/src/capabilities.test.ts).
 *
 * Three of those pairs are proved only by a reference inside a `Sub`
 * (``Sub`${assets.Arn}/*` ``), which the graph carries as `{ $sub }` since
 * chant#4373.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discover } from "@intentius/chant/discovery/index";
import { buildGraphIr, type GraphIR } from "@intentius/chant/graph-ir";
import { enrichEffectiveTopology } from "@intentius/chant/graph-effective";
import { CapabilityEngine } from "@intentius/chant/capabilities/matcher";
import { buildView, displayName } from "@intentius/chant/capabilities/view";
import { lexiconSupport, resolvePacks, shippedRules, isPublic } from "@intentius/chant/capabilities/catalog";
import { awsCapabilityPack } from "./capabilities/pack";

const LEDGER = join(import.meta.dirname, "testdata", "capabilities-ledger");

const engineFor = (g: GraphIR) => new CapabilityEngine(buildView(g, resolvePacks([awsCapabilityPack])), shippedRules().rules);

const ir: GraphIR = buildGraphIr((await discover(LEDGER)).entities, LEDGER);
const engine = engineFor(ir);

const set = (e: CapabilityEngine, name: string, args: unknown[] = []) =>
  [...e.set(name, e.bind(name, args as never)).keys()].map(displayName).sort();
const pairs = (e: CapabilityEngine, name: string, args: unknown[] = []) =>
  [...e.relation(name, e.bind(name, args as never)).out].flatMap(([a, m]) => [...m.keys()].map((b) => `${displayName(a)} ${displayName(b)}`)).sort();

const REACH = [
  "auditRole ordersTable",
  "batchRole auditRole",
  "batchRole ordersTable",
  "deployRole customerData",
  "deployRole dbSecret",
  "reporterRole customerData",
  "webRole assets",
  "webRole customerData",
  "webRole dbSecret",
  "webRole deployRole",
  "workerRole assets",
  "workerRole dbSecret",
  "workerRole ordersTable",
];
const EXFIL = ["reporter customerData", "webServer customerData", "webServer dbSecret"];
const BLAST_STARTS = ["webServer", "reporter", "batch"];
const BLAST = [
  ...["webRole", "assets", "deployRole", "customerData", "dbSecret", "worker", "adminBox", "workerRole", "ordersTable", "customersDb"].map((x) => `webServer ${x}`),
  "reporter reporterRole",
  "reporter customerData",
  "batch batchRole",
  "batch auditRole",
  "batch ordersTable",
].sort();
/** The pairs only a `Sub` reference proves (chant#4373). */
const NEEDS_SUB = {
  reach: ["reporterRole customerData", "webRole assets", "workerRole assets"],
  exfil: ["reporter customerData"],
  blast: ["reporter customerData", "webServer assets"],
};
const blastOf = (e: CapabilityEngine) => pairs(e, "blast").filter((p) => BLAST_STARTS.includes(p.split(" ")[0]));

describe("the ledger's hand-checked answers on the CloudFormation form", () => {
  it("identity reach 13, exfiltration 3, blast radius 15, three of them proved only by a Sub reference (chant#4373)", () => {
    expect(pairs(engine, "reaches")).toEqual(REACH);
    expect(pairs(engine, "exfiltrates")).toEqual(EXFIL);
    expect(blastOf(engine)).toEqual(BLAST);
  });

  it("leaves no statement's resource unresolved", () => {
    const unresolved = [...engine.view.nodes.values()].filter((n) => n.label === "Statement" && n.attrs.unresolved);
    expect(unresolved.map((n) => n.id)).toEqual([]);
  });

  it("finds the Sub-only pairs through the Sub's own reference", () => {
    for (const p of NEEDS_SUB.reach) expect(pairs(engine, "reaches")).toContain(p);
    const ev = engine.relation("reaches").out.get("reporterRole")!.get("customerData")!;
    expect(ev.hops.at(-1)).toMatchObject({ to: "customerData", toAttr: "Arn", edge: "resource" });
  });
});

describe("each capability on CloudFormation kinds", () => {
  it("internet-facing, open-ingress and internet-reachable, the open group reached only through a launch template", () => {
    expect(set(engine, "internet-facing")).toEqual(["adminBox", "webServer"]);
    expect(set(engine, "open-ingress", [22])).toEqual(["webServer"]);
    expect(set(engine, "internet-reachable")).toEqual(["reporter", "webServer"]);
  });

  it("network reads the standalone SecurityGroupIngress resource as well as inline rules", () => {
    expect(pairs(engine, "network")).toEqual([
      "adminBox customersDb",
      "webServer adminBox",
      "webServer worker",
      "worker customersDb",
    ]);
  });

  it("stores-data, holds-secret (by data-classification tag) and encrypted-at-rest", () => {
    expect(set(engine, "stores-data")).toEqual(["assets", "customerData", "customersDb", "dbSecret", "ordersTable"]);
    expect(set(engine, "holds-secret")).toEqual(["customerData", "customersDb", "dbSecret"]);
    expect(set(engine, "encrypted-at-rest")).toEqual(["assets", "customerData", "customersDb", "dbSecret", "ordersTable"]);
  });

  it("runs-as, can-assume (by reference and by ARN naming a declared role) and grants", () => {
    expect(pairs(engine, "runs-as")).toEqual([
      "adminBox workerRole",
      "batch batchRole",
      "reporter reporterRole",
      "webServer webRole",
      "worker workerRole",
    ]);
    expect(pairs(engine, "can-assume")).toEqual(["batchRole auditRole", "webRole deployRole"]);
    expect(pairs(engine, "grants", ["dynamodb:Scan"])).toEqual(["auditRole ordersTable"]);
  });

  it("attached-to-nothing and publicly-readable hold for nothing in the ledger, and for what a small graph declares", () => {
    expect(set(engine, "attached-to-nothing")).toEqual([]);
    expect(set(engine, "publicly-readable")).toEqual([]);
    const g: GraphIR = {
      nodes: [
        { id: "sg", kind: "AWS::EC2::SecurityGroup", lexicon: "aws", attrs: {} },
        { id: "open", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {} },
        { id: "openPolicy", kind: "AWS::S3::BucketPolicy", lexicon: "aws", attrs: { Bucket: { $ref: "open" }, PolicyDocument: { Statement: [{ Effect: "Allow", Principal: "*", Action: "s3:GetObject" }] } } },
        { id: "blocked", kind: "AWS::S3::Bucket", lexicon: "aws", attrs: { PublicAccessBlockConfiguration: { BlockPublicPolicy: true } } },
        { id: "blockedPolicy", kind: "AWS::S3::BucketPolicy", lexicon: "aws", attrs: { Bucket: { $ref: "blocked" }, PolicyDocument: { Statement: [{ Effect: "Allow", Principal: { AWS: "*" }, Action: "s3:GetObject" }] } } },
      ] as never,
      edges: [
        { from: "openPolicy", to: "open", viaAttr: "Bucket" },
        { from: "blockedPolicy", to: "blocked", viaAttr: "Bucket" },
      ] as never,
      groups: {},
    };
    const e = engineFor(g);
    expect(set(e, "attached-to-nothing")).toEqual(["sg"]);
    expect(set(e, "publicly-readable")).toEqual(["open"]);
  });

  it("in-default-vpc reads a live VPC's IsDefault, through the instance's VpcId or its subnet", () => {
    const g: GraphIR = {
      nodes: [
        { id: "east::vpc-default", kind: "AWS::EC2::VPC", lexicon: "aws", attrs: { IsDefault: true } },
        { id: "east::vpc-main", kind: "AWS::EC2::VPC", lexicon: "aws", attrs: { IsDefault: false } },
        { id: "east::subnet-a", kind: "AWS::EC2::Subnet", lexicon: "aws", attrs: {} },
        { id: "east::i-old", kind: "AWS::EC2::Instance", lexicon: "aws", attrs: {} },
        { id: "east::i-new", kind: "AWS::EC2::Instance", lexicon: "aws", attrs: {} },
        { id: "east::i-sub", kind: "AWS::EC2::Instance", lexicon: "aws", attrs: {} },
      ] as never,
      edges: [
        { from: "east::i-old", to: "east::vpc-default", viaAttr: "VpcId" },
        { from: "east::i-new", to: "east::vpc-main", viaAttr: "VpcId" },
        { from: "east::i-sub", to: "east::subnet-a", viaAttr: "SubnetId" },
        { from: "east::subnet-a", to: "east::vpc-default", viaAttr: "VpcId" },
      ] as never,
      groups: {},
    };
    expect(set(engineFor(g), "in-default-vpc")).toEqual(["i-old", "i-sub", "subnet-a"]);
  });

  it("the aws mapping supplies every capability", () => {
    for (const rule of shippedRules().rules.filter(isPublic)) {
      expect(lexiconSupport(rule, awsCapabilityPack.mapping, "aws"), rule.name).toBe("supported");
    }
  });
});

describe("the effective-topology fold over the same graph", () => {
  it("reads the standalone ingress resource too, naming its source group", () => {
    const enriched = enrichEffectiveTopology(ir);
    const attrs = (id: string) => enriched.nodes.find((n) => n.id === id)!.attrs as Record<string, unknown>;
    expect(attrs("webServer").effectiveIngress).toEqual(["tcp:443:0.0.0.0/0", "tcp:22:0.0.0.0/0"]);
    expect(attrs("webServer").internetFacing).toBe(true);
    expect(attrs("webServer").internetFacingVia).toBe("publicRt → igw");
    expect(attrs("worker").effectiveIngress).toEqual(["tcp:8080:sg:webSg"]);
    expect(attrs("worker").internetFacing).toBe(false);
  });
});
