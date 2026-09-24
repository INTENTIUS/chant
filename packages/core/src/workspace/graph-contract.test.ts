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

import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, commitAll, contract, declaration, declaration as declaration_, FAKE_GRAPH_CHANT, git, REPO, repo, scratchDir, validSchema } from "./__fixtures__/contract-repo";
import type { GraphIR } from "../graph-ir";
import { composeWorkspaceGraph, MEMBER_RUN_REASON_CODES } from "./compose-graph";
import { parseDeclaration, WORKSPACE_ERROR_CODES } from "./declaration";
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
    expect(GRAPH_ERROR_CODES).toEqual(WORKSPACE_ERROR_CODES);
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
    const member = (name: string) => ({ name, dir: name, kind: "chant", status: "composed" as const, reason: null, chant: "0.81.0", irVersion: 1 });
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
    expect(doc.links.map((r) => `${r.consumer} ${r.origin} ${r.status}`)).toEqual(["app declared resolved", "app declared missing", "jobs inferred:joinKey ambiguous"]);
  });
});

describe("chant workspace graph on the chant repo (#2557)", () => {
  test("validates, and lists every member as skipped: none is kind chant", async () => {
    const { doc, failed } = await workspaceGraph({ cwd: join(REPO, "packages", "core") });
    const g = result(doc);
    expectValid(g);
    expect(failed).toBe(false);
    expect(g.workspace).toEqual({ name: "chant", root: "." });
    expect(g.at).toBeNull();
    expect(g.members.every((m) => m.status === "skipped" && m.reason?.code === "kind-not-run")).toBe(true);
  });

  test("--at HEAD reads from git objects and exports nothing when no member runs", async () => {
    const head = git(REPO, "rev-parse", "HEAD");
    const { doc } = await workspaceGraph({ cwd: REPO, at: "HEAD" });
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
