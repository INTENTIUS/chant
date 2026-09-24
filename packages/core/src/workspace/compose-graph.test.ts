/**
 * The composed workspace IR (#2537, #2524 D8): `<member>/<id>` ids,
 * `groups.byMember`, and v1 output from old chants upgraded in place.
 */

import { describe, expect, test } from "vitest";
import { GRAPH_IR_VERSION, type GraphIR } from "../graph-ir";
import { parseDeclaration } from "./declaration";
import { composeWorkspaceGraph, readMemberIr, WORKSPACE_GRAPH_VERSION, type ComposedMember } from "./compose-graph";
import type { LinkTableRow } from "./links";

const member = (name: string, dir: string): ComposedMember => ({
  name,
  dir,
  kind: "chant",
  status: "composed",
  reason: null,
  chant: "0.80.0",
  irVersion: 1,
});

const web: GraphIR = {
  version: 1,
  nodes: [
    { id: "Bucket", kind: "S3Bucket", lexicon: "aws", attrs: { name: "b" } },
    { id: "web::Fn", kind: "LambdaFunction", lexicon: "aws", compositeInstance: "api", attrs: { env: { BUCKET: { $ref: "Bucket.Arn" } } } },
  ],
  edges: [{ from: "web::Fn", to: "Bucket", kind: "ref", viaAttr: "env" }],
  groups: { byLexicon: { aws: ["Bucket", "web::Fn"] }, byStack: { web: ["web::Fn"], aws: ["Bucket"] }, byComposite: { Api: ["web::Fn"] } },
  exports: [{ name: "BucketArn", node: "Bucket", attr: "Arn" }],
};

const db: GraphIR = {
  nodes: [{ id: "Bucket", kind: "GcsBucket", lexicon: "gcp", attrs: {} }],
  edges: [],
  groups: { byLexicon: { gcp: ["Bucket"] }, byStack: { gcp: ["Bucket"] } },
};

describe("readMemberIr", () => {
  test("stamps version 1 on output from a chant older than the version field", () => {
    const read = readMemberIr(JSON.stringify(db));
    expect("ir" in read && read.ir.version).toBe(1);
    expect("ir" in read && read.irVersion).toBe(null);
  });

  test("keeps a versioned IR as it is", () => {
    const read = readMemberIr(JSON.stringify(web));
    expect("ir" in read && read.irVersion).toBe(GRAPH_IR_VERSION);
  });

  test("refuses an IR newer than this chant reads, with a reason code", () => {
    const read = readMemberIr(JSON.stringify({ ...web, version: GRAPH_IR_VERSION + 1 }));
    expect("reason" in read && read.reason.code).toBe("ir-version-unsupported");
  });

  test("gives output-unreadable for anything that is not an IR", () => {
    for (const text of ["not json", "{}", '{"nodes": []}', "null"]) {
      const read = readMemberIr(text);
      expect("reason" in read && read.reason.code, text).toBe("output-unreadable");
    }
  });
});

describe("composeWorkspaceGraph", () => {
  const doc = composeWorkspaceGraph({ name: "acme", root: "/w" }, [
    { member: member("web", "apps/web"), ir: web },
    { member: member("db", "db"), ir: (readMemberIr(JSON.stringify(db)) as { ir: GraphIR }).ir },
    { member: { ...member("docs", "docs"), kind: "other", status: "skipped", reason: { code: "kind-not-run", message: "other" }, chant: null, irVersion: null } },
  ]);

  test("prefixes every id with its member, keeping :: for stacks", () => {
    expect(doc.version).toBe(WORKSPACE_GRAPH_VERSION);
    expect(doc.nodes.map((n) => n.id)).toEqual(["db/Bucket", "web/Bucket", "web/web::Fn"]);
    expect(doc.nodes.find((n) => n.id === "web/web::Fn")).toMatchObject({
      member: "web",
      compositeInstance: "web/api",
      attrs: { env: { BUCKET: { $ref: "web/Bucket.Arn" } } },
    });
    expect(doc.edges).toEqual([{ from: "web/web::Fn", to: "web/Bucket", kind: "ref", viaAttr: "env", member: "web" }]);
    expect(doc.exports).toEqual([{ name: "BucketArn", node: "web/Bucket", attr: "Arn", member: "web" }]);
  });

  test("groups nodes by member, merges shared groups and prefixes member-scoped ones", () => {
    expect(doc.groups.byMember).toEqual({ web: ["web/Bucket", "web/web::Fn"], db: ["db/Bucket"] });
    expect(doc.groups.byLexicon).toEqual({ aws: ["web/Bucket", "web/web::Fn"], gcp: ["db/Bucket"] });
    expect(doc.groups.byComposite).toEqual({ Api: ["web/web::Fn"] });
    expect(doc.groups.byStack).toEqual({ "db/gcp": ["db/Bucket"], "web/aws": ["web/Bucket"], "web/web": ["web/web::Fn"] });
  });

  test("lists every member with its status, and leaves the link and record sections empty", () => {
    expect(doc.members.map((m) => [m.name, m.status])).toEqual([
      ["web", "composed"],
      ["db", "composed"],
      ["docs", "skipped"],
    ]);
    expect(doc.links).toEqual([]);
    expect(doc.records).toEqual([]);
  });

  test("does not change the members' own IRs", () => {
    expect(web.nodes[0].id).toBe("Bucket");
    expect(web.edges[0].from).toBe("web::Fn");
  });
});

describe("the links section (#2539)", () => {
  test("inferred joins carry their label, and a declared link suppresses the inferred edge it covers", () => {
    const consumer: GraphIR = {
      version: 1,
      nodes: [
        { id: "bucketArn", kind: "Parameter", lexicon: "aws", attrs: {} },
        { id: "BUCKET_ARN", kind: "Parameter", lexicon: "aws", attrs: {} },
      ],
      edges: [],
      groups: {},
      imports: [
        { name: "bucketArn", node: "bucketArn" },
        { name: "BUCKET_ARN", node: "BUCKET_ARN" },
      ],
    };
    const declaration = parseDeclaration(
      JSON.stringify({
        name: "acme",
        schema: 1,
        members: [
          { name: "web", dir: "web", kind: "chant" },
          { name: "jobs", dir: "jobs", kind: "chant" },
          { name: "app", dir: "app", kind: "chant", links: [{ member: "web", output: "BucketArn" }] },
        ],
      }),
      "chant.workspace.json",
    );
    const inputs = [
      { member: member("web", "web"), ir: structuredClone(web) },
      { member: member("jobs", "jobs"), ir: structuredClone(consumer) },
      { member: member("app", "app"), ir: structuredClone(consumer) },
    ];
    const doc = composeWorkspaceGraph({ name: "acme", root: "/w" }, inputs, { declaration });
    expect(
      (doc.links as LinkTableRow[]).map((r) => (r.status === "ambiguous" ? "" : `${r.origin} ${r.label} ${r.from ?? r.consumer} -> ${r.to}`)),
    ).toEqual([
      "declared exact app -> web/Bucket",
      "inferred:joinKey folded jobs/BUCKET_ARN -> web/Bucket",
      "inferred:joinKey folded jobs/bucketArn -> web/Bucket",
    ]);
  });
});
