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
  live: false,
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

describe("CI edges, pipelines and dangling references (#3922)", () => {
  /** A github member as `chant graph` reports it after #3910. */
  const ci = (workflow: string, job: string): GraphIR => ({
    version: 1,
    nodes: [
      { id: workflow, kind: "Workflow", lexicon: "github", attrs: {} },
      { id: job, kind: "Job", lexicon: "github", attrs: {} },
      { id: "deploy", kind: "Job", lexicon: "github", attrs: {} },
    ],
    edges: [
      { from: "deploy", to: job, kind: "needs", viaAttr: "needs" },
      { from: job, to: workflow, kind: "calls", viaAttr: "uses", crossPipeline: true },
    ],
    groups: { byLexicon: { github: [job, "deploy", workflow] }, byPipeline: { ci: [job, "deploy", workflow] } },
    dangling: [
      { from: "deploy", kind: "needs", path: "needs", value: "lint" },
      { from: job, kind: "calls", path: "uses", value: "other/repo/.github/workflows/x.yml@main", crossPipeline: true },
    ],
  });
  const doc = composeWorkspaceGraph({ name: "acme", root: "." }, [
    { member: member("svc", "svc"), ir: ci("ciWorkflow", "build") },
    { member: member("app", "app"), ir: ci("ciWorkflow", "test") },
    { member: member("db", "db"), ir: db },
  ]);

  test("edges keep their kind and crossPipeline", () => {
    expect(doc.edges.filter((e) => e.member === "svc")).toEqual([
      { from: "svc/build", to: "svc/ciWorkflow", kind: "calls", viaAttr: "uses", crossPipeline: true, member: "svc" },
      { from: "svc/deploy", to: "svc/build", kind: "needs", viaAttr: "needs", member: "svc" },
    ]);
  });

  test("byPipeline keys and ids are prefixed with the member", () => {
    expect(doc.groups.byPipeline).toEqual({
      "app/ci": ["app/ciWorkflow", "app/deploy", "app/test"],
      "svc/ci": ["svc/build", "svc/ciWorkflow", "svc/deploy"],
    });
  });

  test("dangling references keep their fields, with from prefixed and the member named, sorted", () => {
    expect(doc.dangling).toEqual([
      { from: "app/deploy", kind: "needs", path: "needs", value: "lint", member: "app" },
      { from: "app/test", kind: "calls", path: "uses", value: "other/repo/.github/workflows/x.yml@main", crossPipeline: true, member: "app" },
      { from: "svc/build", kind: "calls", path: "uses", value: "other/repo/.github/workflows/x.yml@main", crossPipeline: true, member: "svc" },
      { from: "svc/deploy", kind: "needs", path: "needs", value: "lint", member: "svc" },
    ]);
  });

  test("no dangling section and no byPipeline when no member reports either", () => {
    const plain = composeWorkspaceGraph({ name: "acme", root: "." }, [{ member: member("db", "db"), ir: db }]);
    expect("dangling" in plain).toBe(false);
    expect(plain.groups.byPipeline).toBeUndefined();
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

describe("collectors (#2559)", () => {
  const topology = {
    pipelines: [{ id: "traces", signal: "traces", receivers: ["otlp"], processors: ["batch"], exporters: ["otlphttp/honeycomb"] }],
    components: [
      { id: "otlp", kind: "receiver", type: "otlp", builtin: true, endpoints: ["0.0.0.0:4317"], protocols: ["grpc"], pipelines: ["traces"] },
      { id: "otlphttp/honeycomb", kind: "exporter", type: "otlphttp", builtin: true, endpoints: ["https://api.honeycomb.io"], protocols: ["http/protobuf"], pipelines: ["traces"] },
    ],
    exporters: [{ id: "otlphttp/honeycomb", type: "otlphttp", endpoints: ["https://api.honeycomb.io"], pipelines: ["traces"], signals: ["traces"] }],
    edges: [],
    semconv: [],
  };
  const withMeta = (meta: Record<string, unknown>): GraphIR => ({ ...structuredClone(db), meta });

  test("lifts a member's meta.collector into a section and keeps the rest of its meta", () => {
    const inputs = [
      { member: member("web", "web"), ir: structuredClone(web) },
      { member: member("ops", "ops"), ir: withMeta({ collector: topology, other: 1 }) },
    ];
    const doc = composeWorkspaceGraph({ name: "acme", root: "/w" }, inputs);
    expect(doc.collectors).toEqual([
      {
        member: "ops",
        pipelines: topology.pipelines,
        components: topology.components.map(({ builtin: _b, ...c }) => c),
        exporters: topology.exporters,
      },
    ]);
    expect(doc.members.find((m) => m.name === "ops")!.meta).toEqual({ other: 1 });
  });

  test("is empty when no member reports a collector, and leaves meta alone", () => {
    const doc = composeWorkspaceGraph({ name: "acme", root: "/w" }, [
      { member: member("web", "web"), ir: structuredClone(web) },
      { member: member("ops", "ops"), ir: withMeta({ _behaviour: { engine: "x" } }) },
    ]);
    expect(doc.collectors).toEqual([]);
    expect(doc.members.find((m) => m.name === "ops")!.meta).toEqual({ _behaviour: { engine: "x" } });
  });

  test("ignores a meta.collector that is not a topology", () => {
    for (const bad of ["x", 1, null, {}, { pipelines: "no" }]) {
      const doc = composeWorkspaceGraph({ name: "acme", root: "/w" }, [{ member: member("ops", "ops"), ir: withMeta({ collector: bad }) }]);
      expect(doc.collectors, JSON.stringify(bad)).toEqual([]);
    }
  });
});

describe("rootReads (#4452)", () => {
  test("a member's rootReads stay on its entry, keyed as its chant wrote them", () => {
    const rootReads = { "terraform.roots.app": { depth: "plan", fellBackTo: "state" as const, reason: "no-credentials" } };
    const doc = composeWorkspaceGraph({ name: "acme", root: "/w" }, [
      { member: member("web", "web"), ir: structuredClone(web) },
      { member: member("infra", "infra"), ir: { ...structuredClone(db), rootReads } },
    ]);
    expect(doc.members.find((m) => m.name === "infra")!.rootReads).toEqual(rootReads);
    expect(doc.members.find((m) => m.name === "web")).not.toHaveProperty("rootReads");
  });
});
