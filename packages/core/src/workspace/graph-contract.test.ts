/**
 * The read contract for `chant workspace graph` (#2536, #2524 D15): the
 * output schema is a valid draft 2020-12 document, its closed code lists match
 * the code, and real output validates against it, for the chant repo's own
 * declaration (#2557), for failures, and for `--at <rev>`, which runs each
 * member's source as it was at the revision.
 *
 * Members here run under a fake chant (`FAKE_GRAPH_CHANT`), installed in the
 * workspace's `node_modules/.bin`, so the tests exercise the toolchain lookup
 * and `--at`'s export without starting a real chant per member. The
 * reference workspace runs a real one (`read-contract.test.ts`).
 */

import { existsSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, declaration, declaration as declaration_, FAKE_FILE_GRAPH_CHANT, FAKE_GRAPH_CHANT, git, REPO, repo, scratchDir, validSchema } from "./__fixtures__/contract-repo";
import type { GraphIR } from "../graph-ir";
import { composeWorkspaceGraph, MEMBER_RUN_REASON_CODES } from "./compose-graph";
import { parseDeclaration, WORKSPACE_ERROR_CODES } from "./declaration";
import type { LinkTableRow } from "./links";
import { GRAPH_CONTRACT_VERSION, GRAPH_ERROR_CODES, GRAPH_OUTPUT_SCHEMA_ID, workspaceGraph, type GraphDocument } from "./graph-cli";
import schema from "./graph.schema.json";

afterAll(cleanScratch);

const { expectValid } = contract(schema);

function result(doc: GraphDocument): Extract<GraphDocument, { nodes: unknown }> {
  if ("error" in doc) throw new Error(`${doc.error.code}: ${doc.error.message}`);
  return doc;
}

/** A workspace whose chant members answer through the fake chant. */
function fakeWorkspace(): string {
  return repo({
    "chant.workspace.json": declaration([
      { name: "api", dir: "services/api", kind: "chant" },
      { name: "web", dir: "apps/web", kind: "chant" },
      { name: "docs", dir: "docs", kind: "other", because: "prose" },
    ]),
    "services/api/chant.config.ts": "export default {};\n",
    "services/api/ids.txt": "Queue\nTopic\n",
    "apps/web/chant.config.ts": "export default {};\n",
    "apps/web/ids.txt": "Site\n",
    "docs/README.md": "",
    ".gitignore": "node_modules\n",
    "node_modules/.bin/chant": { text: FAKE_GRAPH_CHANT, mode: 0o755 },
  });
}

describe("graph output schema", () => {
  test("is a valid draft 2020-12 document with the published $id", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(GRAPH_OUTPUT_SCHEMA_ID);
    expect(GRAPH_CONTRACT_VERSION).toBe(1);
  });

  test("lists exactly the reason and error codes the code can return", () => {
    expect(schema.$defs.member.properties.reason.oneOf[1].properties!.code.enum).toEqual([...MEMBER_RUN_REASON_CODES]);
    expect(schema.$defs.failure.properties.error.properties.code.enum).toEqual([...GRAPH_ERROR_CODES]);
    expect(GRAPH_ERROR_CODES).toEqual([...WORKSPACE_ERROR_CODES, "live-at-revision"]);
  });
});

describe("the links section (#2539)", () => {
  test("declared, missing and ambiguous link rows validate", () => {
    const producer = (output: string): GraphIR => ({
      version: 1,
      nodes: [{ id: "Bucket", kind: "S3Bucket", lexicon: "aws", attrs: {} }],
      edges: [],
      groups: {},
      exports: [{ name: output, node: "Bucket", attr: "Arn" }],
    });
    const consumer: GraphIR = {
      version: 1,
      nodes: [{ id: "bucketArn", kind: "Parameter", lexicon: "aws", attrs: {} }],
      edges: [],
      groups: {},
      imports: [{ name: "bucketArn", node: "bucketArn" }],
    };
    const declaration = parseDeclaration(
      declaration_([
        { name: "web", dir: "web", kind: "chant" },
        { name: "api", dir: "api", kind: "chant" },
        { name: "jobs", dir: "jobs", kind: "chant" },
        { name: "app", dir: "app", kind: "chant", links: [{ member: "web", output: "BucketArn" }, { member: "web", output: "Nope" }] },
      ]),
      "chant.workspace.json",
    );
    const member = (name: string) => ({ name, dir: name, kind: "chant", status: "composed" as const, reason: null, chant: "0.81.0", irVersion: 1, live: false });
    const graph = composeWorkspaceGraph(
      { name: "acme", root: "." },
      [
        { member: member("web"), ir: producer("BucketArn") },
        { member: member("api"), ir: producer("BucketArn") },
        { member: member("jobs"), ir: structuredClone(consumer) },
        { member: member("app"), ir: structuredClone(consumer) },
      ],
      { declaration },
    );
    const doc = { $schema: GRAPH_OUTPUT_SCHEMA_ID, contract: 1, chant: "0.81.0", at: null, ...graph };
    expectValid(doc);
    expect((doc.links as LinkTableRow[]).map((r) => `${r.consumer} ${r.origin} ${r.status}`)).toEqual(["app declared resolved", "app declared missing", "jobs inferred:joinKey ambiguous"]);
  });
});

describe("the collectors section (#2559)", () => {
  const topology = {
    pipelines: [{ id: "traces", signal: "traces", receivers: ["otlp"], processors: [], exporters: ["otlphttp"] }],
    components: [{ id: "otlphttp", kind: "exporter", type: "otlphttp", endpoints: ["https://collector.example:4318"], pipelines: ["traces"] }],
    exporters: [{ id: "otlphttp", type: "otlphttp", endpoints: ["https://collector.example:4318"], pipelines: ["traces"], signals: ["traces"] }],
  };
  /** A member whose chant answers from ir.json, as one whose project declares a collector does. */
  const collectorWorkspace = () =>
    repo({
      "chant.workspace.json": declaration([{ name: "ops", dir: "ops", kind: "chant" }, { name: "web", dir: "web", kind: "chant" }]),
      "ops/chant.config.ts": "export default {};\n",
      "ops/ir.json": JSON.stringify({ version: 1, nodes: [], edges: [], groups: {}, meta: { collector: topology } }),
      "web/chant.config.ts": "export default {};\n",
      "web/ir.json": JSON.stringify({ version: 1, nodes: [], edges: [], groups: {} }),
      ".gitignore": "node_modules\n",
      "node_modules/.bin/chant": { text: FAKE_FILE_GRAPH_CHANT, mode: 0o755 },
    });

  test("the schema requires collectors and describes each entry", () => {
    const required = (schema.$defs.result as { required: string[] }).required;
    expect(required).toContain("collectors");
    expect((schema.$defs.collector as { required: string[] }).required).toEqual(["member", "pipelines", "components", "exporters"]);
  });

  test("a workspace whose member declares a collector lists its pipelines and exporters, and validates", async () => {
    const { doc } = await workspaceGraph({ cwd: collectorWorkspace() });
    const g = result(doc);
    expectValid(g);
    expect(g.collectors.map((c) => c.member)).toEqual(["ops"]);
    expect(g.collectors[0]!.pipelines.map((p) => p.id)).toEqual(["traces"]);
    expect(g.collectors[0]!.exporters).toEqual(topology.exporters);
    expect(g.members.find((m) => m.name === "ops")!.meta).toBeUndefined();
  });

  test("telemetry links resolve against the collectors and validate (#2558)", async () => {
    const withProtocols = {
      pipelines: topology.pipelines,
      components: [
        { id: "otlp", kind: "receiver", type: "otlp", endpoints: ["0.0.0.0:4318"], protocols: ["http/protobuf", "http/json"], pipelines: ["traces"] },
        { id: "otlphttp", kind: "exporter", type: "otlphttp", endpoints: ["https://collector.example:4318"], protocols: ["http/protobuf"], pipelines: ["traces"] },
      ],
      exporters: topology.exporters,
    };
    const cwd = repo({
      "chant.workspace.json": declaration([
        { name: "ops", dir: "ops", kind: "chant" },
        {
          name: "web",
          dir: "web",
          kind: "chant",
          links: [
            { member: "ops", output: "traces", kind: "telemetry", protocol: "http/protobuf" },
            { member: "ops", output: "traces", kind: "telemetry", protocol: "grpc" },
            { member: "ops", output: "logs", kind: "telemetry" },
          ],
        },
      ]),
      "ops/chant.config.ts": "export default {};\n",
      "ops/ir.json": JSON.stringify({ version: 1, nodes: [], edges: [], groups: {}, meta: { collector: withProtocols } }),
      "web/chant.config.ts": "export default {};\n",
      "web/ir.json": JSON.stringify({ version: 1, nodes: [], edges: [], groups: {} }),
      ".gitignore": "node_modules\n",
      "node_modules/.bin/chant": { text: FAKE_FILE_GRAPH_CHANT, mode: 0o755 },
    });
    const { doc } = await workspaceGraph({ cwd });
    const g = result(doc);
    expectValid(g);
    const rows = (g.links as LinkTableRow[]).filter((r) => r.kind === "telemetry").map((r) => (r.status === "ambiguous" ? "" : `${r.output} ${r.protocol ?? "-"} ${r.status} ${r.target ?? "-"}`));
    expect(rows).toEqual(["traces http/protobuf resolved pipeline", "traces grpc invalid pipeline", "logs - missing -"]);
  });

  test("a workspace with no collector prints an empty list", async () => {
    const { doc } = await workspaceGraph({ cwd: fakeWorkspace() });
    const g = result(doc);
    expectValid(g);
    expect(g.collectors).toEqual([]);
  });

  test("a collector with no exporters list does not validate", () => {
    const bad = { member: "ops", pipelines: [], components: [] };
    expect(() => expectValid({ $schema: GRAPH_OUTPUT_SCHEMA_ID, contract: 1, chant: "0.81.0", at: null, ...composeWorkspaceGraph({ name: "x", root: "." }, []), collectors: [bad] })).toThrow();
  });
});

describe("chant workspace graph on the chant repo (#2557)", () => {
  // The one terraform member runs through the terraform lexicon (#2874), a
  // real chant per read; kind-readers.e2e.test.ts covers that. Here it is
  // left out, so nothing runs.
  const notRun = (JSON.parse(readFileSync(join(REPO, "chant.workspace.json"), "utf-8")) as { members: { name: string; kind: string }[] }).members
    .filter((m) => m.kind !== "terraform" && m.kind !== "choudoufu")
    .map((m) => m.name);

  test("validates, and lists every member but the terraform one as skipped: none is kind chant", async () => {
    const { doc, failed } = await workspaceGraph({ cwd: join(REPO, "packages", "core"), members: notRun });
    const g = result(doc);
    expectValid(g);
    expect(failed).toBe(false);
    expect(g.workspace).toEqual({ name: "chant", root: "." });
    expect(g.at).toBeNull();
    expect(g.members.every((m) => m.status === "skipped" && m.reason?.code === "kind-not-run")).toBe(true);
  });

  test("--at HEAD reads from git objects and exports nothing when no member runs", async () => {
    const head = git(REPO, "rev-parse", "HEAD");
    const { doc } = await workspaceGraph({ cwd: REPO, at: "HEAD", members: notRun });
    const g = result(doc);
    expectValid(g);
    expect(g.at).toBe(head);
  });
});

describe("chant workspace graph on built workspaces", () => {
  test("composes members run under the workspace's toolchain, and validates", async () => {
    const root = fakeWorkspace();
    const { doc, failed } = await workspaceGraph({ cwd: root });
    const g = result(doc);
    expectValid(g);
    expect(failed).toBe(false);
    expect(g.nodes.map((n) => n.id)).toEqual(["api/Queue", "api/Topic", "web/Site"]);
    expect(g.members.map((m) => [m.name, m.status, m.reason?.code ?? null])).toEqual([
      ["api", "composed", null],
      ["web", "composed", null],
      ["docs", "skipped", "kind-not-run"],
    ]);
  });

  test("--at <rev> runs each member's source as it was at the revision, offline", async () => {
    const root = fakeWorkspace();
    const first = commitAll(root, "one");
    // After the commit: a new node, a new member and a deleted one. --at must see none of it.
    writeFileSync(join(root, "services", "api", "ids.txt"), "Queue\nTopic\nBucket\n");
    rmSync(join(root, "apps"), { recursive: true });
    commitAll(root, "two");
    writeFileSync(join(root, "services", "api", "ids.txt"), "Changed\n");

    const at = result((await workspaceGraph({ cwd: join(root, "services"), at: first })).doc);
    expectValid(at);
    expect(at.at).toBe(first);
    expect(at.workspace.root).toBe(".");
    expect(at.nodes.map((n) => n.id)).toEqual(["api/Queue", "api/Topic", "web/Site"]);

    const head = result((await workspaceGraph({ cwd: root, at: "HEAD" })).doc);
    expect(head.nodes.map((n) => n.id)).toEqual(["api/Bucket", "api/Queue", "api/Topic"]);
    expect(head.members.find((m) => m.name === "web")).toMatchObject({ status: "failed", reason: { code: "dir-missing" } });

    const now = result((await workspaceGraph({ cwd: root })).doc);
    expect(now.nodes.map((n) => n.id)).toEqual(["api/Changed"]);
  });

  test("a workspace below the git root reports its root relative to it", async () => {
    const top = repo({
      "infra/chant.workspace.json": declaration([{ name: "api", dir: "api", kind: "chant" }]),
      "infra/api/chant.config.ts": "",
      "infra/api/ids.txt": "Queue\n",
      ".gitignore": "node_modules\n",
      "infra/node_modules/.bin/chant": { text: FAKE_GRAPH_CHANT, mode: 0o755 },
    });
    const sha = commitAll(top);
    for (const at of [undefined, sha]) {
      const g = result((await workspaceGraph({ cwd: join(top, "infra", "api"), at })).doc);
      expectValid(g);
      expect(g.workspace).toEqual({ name: "acme", root: "infra" });
      expect(g.nodes.map((n) => n.id)).toEqual(["api/Queue"]);
    }
  });

  test("every failure is a document with a code from the closed list", async () => {
    const empty = repo({});
    const outside = scratchDir("chant-graph-nogit-");
    const pinned = repo({ "chant.workspace.json": declaration([], { pins: [{ package: "@intentius/chant", version: "0.0.1" }] }) });
    const unknownMember = fakeWorkspace();
    const docs = [
      (await workspaceGraph({ cwd: empty })).doc,
      (await workspaceGraph({ cwd: outside, at: "HEAD" })).doc,
      (await workspaceGraph({ cwd: empty, at: "no-such-rev" })).doc,
      (await workspaceGraph({ cwd: pinned })).doc,
      (await workspaceGraph({ cwd: unknownMember, members: ["nope"] })).doc,
    ];
    for (const d of docs) expectValid(d);
    expect(docs.map((d) => ("error" in d ? d.error.code : "ok"))).toEqual([
      "declaration-missing",
      "not-a-git-repository",
      "revision-unknown",
      "root-chant-required",
      "declaration-invalid",
    ]);
  });
});

/**
 * A chant older than member-run that records its command line in argv.txt
 * beside the member, outside its directory so the member cache's stamp holds,
 * and prints ir.json, or live.json when asked for --live (#2875).
 */
const FAKE_LIVE_CHANT = `#!/bin/sh
[ "$1" = graph ] || { echo "Error: Unknown command: $1" >&2; exit 1; }
printf '%s\\n' "$*" > ../argv.txt
case " $* " in
  *" --live "*) cat live.json ;;
  *) cat ir.json ;;
esac
`;

/** Every file under `dir` an hour old, past the member cache's freshness window. */
function age(dir: string): void {
  const then = new Date(Date.now() - 3_600_000);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) age(path);
    else if (e.isFile()) utimesSync(path, then, then);
  }
}

describe("the live read (#2875)", () => {
  const source = { version: 1, nodes: [{ id: "Queue", kind: "Thing", lexicon: "fake", attrs: {} }], edges: [], groups: {} };
  const live = {
    version: 1,
    nodes: [
      { id: "Queue", kind: "Thing", lexicon: "fake", attrs: { _status: "good", _drift: { fields: ["size"] }, _behaviour: { cost: { perHour: 1.5, currency: "USD" } } } },
      { id: "Stray", kind: "Thing", lexicon: "fake", attrs: { _status: "warn", _overlay: "foreign", peer: { $ref: "Queue" } } },
    ],
    edges: [],
    groups: {},
    meta: { _behaviour: { engine: "fixture", traffic: "100 rps" } },
  };
  const liveWorkspace = () =>
    repo({
      "chant.workspace.json": declaration([
        { name: "api", dir: "api", kind: "chant" },
        { name: "docs", dir: "docs", kind: "other", because: "prose" },
      ]),
      "api/chant.config.ts": "export default {};\n",
      "api/ir.json": JSON.stringify(source),
      "api/live.json": JSON.stringify(live),
      "docs/README.md": "",
      ".gitignore": "node_modules\n",
      "node_modules/.bin/chant": { text: FAKE_LIVE_CHANT, mode: 0o755 },
    });

  test("hands --live, --overlay and --traffic to every member, and marks each member read live", async () => {
    const root = liveWorkspace();
    const before = Date.now();
    const { doc, failed } = await workspaceGraph({ cwd: root, args: { env: "prod", live: true, overlay: true, traffic: "100 rps" } });
    const g = result(doc);
    expectValid(g);
    expect(failed).toBe(false);
    expect(readFileSync(join(root, "argv.txt"), "utf-8").trim()).toBe("graph . --format ir --env prod --live --overlay --traffic 100 rps");
    const api = g.members.find((m) => m.name === "api")!;
    expect(api).toMatchObject({ status: "composed", live: true });
    expect(Date.parse(api.readAt!)).toBeGreaterThanOrEqual(before - 1000);
    expect(g.members.find((m) => m.name === "docs")).toMatchObject({ status: "skipped", live: false });
    expect(g.members.find((m) => m.name === "docs")!.readAt).toBeUndefined();
  });

  test("the drift, overlay and behaviour a member's chant wrote pass through composition untouched", async () => {
    const { doc } = await workspaceGraph({ cwd: liveWorkspace(), args: { env: "prod", live: true, overlay: true } });
    const g = result(doc);
    expect(g.nodes.find((n) => n.id === "api/Queue")!.attrs).toEqual(live.nodes[0].attrs);
    // Only $ref values are prefixed; every other attribute is as the member printed it.
    expect(g.nodes.find((n) => n.id === "api/Stray")!.attrs).toEqual({ _status: "warn", _overlay: "foreign", peer: { $ref: "api/Queue" } });
    expect(g.members.find((m) => m.name === "api")!.meta).toEqual(live.meta);
  });

  test("a source read marks every member not live, with no read time", async () => {
    const { doc } = await workspaceGraph({ cwd: liveWorkspace() });
    const g = result(doc);
    expectValid(g);
    expect(g.members.map((m) => [m.name, m.live, m.readAt ?? null])).toEqual([["api", false, null], ["docs", false, null]]);
    expect(g.nodes.map((n) => n.id)).toEqual(["api/Queue"]);
  });

  test("a live read bypasses the member cache: it is never served from it and never stored (#2876)", async () => {
    const root = liveWorkspace();
    // Past the cache's freshness window, so a source read is stored.
    age(root);
    // A source read fills the cache; the live read after it still runs the member.
    await workspaceGraph({ cwd: root });
    const argv = join(root, "argv.txt");
    rmSync(argv);
    const live1 = result((await workspaceGraph({ cwd: root, args: { env: "prod", live: true, overlay: true } })).doc);
    expect(existsSync(argv)).toBe(true);
    expect(live1.members.find((m) => m.name === "api")).toMatchObject({ live: true, cached: false, stamp: null });
    expect(live1.nodes.map((n) => n.id)).toEqual(["api/Queue", "api/Stray"]);
    // A second live read runs again: nothing from the first was stored.
    rmSync(argv);
    const live2 = result((await workspaceGraph({ cwd: root, args: { env: "prod", live: true, overlay: true } })).doc);
    expect(existsSync(argv)).toBe(true);
    expect(live2.members.find((m) => m.name === "api")).toMatchObject({ live: true, cached: false });
    // And the source read is still served as before, with no live attributes.
    const again = result((await workspaceGraph({ cwd: root })).doc);
    expect(again.members.find((m) => m.name === "api")).toMatchObject({ live: false, cached: true });
    expect(again.nodes.map((n) => n.id)).toEqual(["api/Queue"]);
  });

  test("--live with --at is refused with live-at-revision, and runs no member", async () => {
    const root = liveWorkspace();
    commitAll(root);
    const { doc, failed } = await workspaceGraph({ cwd: root, at: "HEAD", args: { env: "prod", live: true } });
    expectValid(doc);
    expect(failed).toBe(true);
    expect("error" in doc && doc.error.code).toBe("live-at-revision");
    expect(existsSync(join(root, "argv.txt"))).toBe(false);
  });
});
