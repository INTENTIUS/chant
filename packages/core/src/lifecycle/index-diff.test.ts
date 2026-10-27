// #4533 (moved from INTENTIUS/behold#1028): the diff of two index versions. Two fixture
// versions of one aws scope (./__fixtures__/index-diff/), the scope-mismatch refusal, a type
// unobserved in one read never reported as removed, edges, and reading versions through a store.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  diffIndexVersionRefs,
  diffIndexVersions,
  indexAbsence,
  IndexScopeMismatch,
  NotAnIndexVersion,
  parseIndexVersionRef,
  readIndexVersionRef,
  type IndexDiffDocument,
} from "./index-diff";
import { indexCoverageFor, type IndexDocument } from "./index-document";
import { createSnapshotStore } from "./snapshot-store";

const DIR = join(import.meta.dirname, "__fixtures__", "index-diff");
const V1 = "20261026T120000Z-aaaaaaaaaaaa.json";
const V2 = "20261026T130000Z-bbbbbbbbbbbb.json";
const SCOPE = "cloud/aws/000000000000/5c1f0e2a9b7d";
const load = (name: string): IndexDiffDocument => JSON.parse(readFileSync(join(DIR, name), "utf8")) as IndexDiffDocument;
const B = (n: string) => `aws/000000000000/us-east-1/AWS::S3::Bucket/${n}`;
const ROLE = "aws/000000000000/us-east-1/AWS::IAM::Role/app-role";
const QUEUE = "aws/000000000000/us-east-1/AWS::SQS::Queue/jobs";

describe("diffIndexVersions over two fixture versions", () => {
  const d = diffIndexVersions(load(V1), load(V2), { fromVersion: V1, toVersion: V2 });

  it("shows both stamps and the scope", () => {
    expect(d.scopeKey).toBe(SCOPE);
    expect(d.from).toMatchObject({ version: V1, observedAt: "2026-10-26T12:00:00Z" });
    expect(d.to).toMatchObject({ version: V2, observedAt: "2026-10-26T13:00:00Z" });
    expect(d.unchanged).toBe(false);
  });

  it("one changed property on the edited bucket, and nothing for the tag that did not move", () => {
    expect(d.nodes.changed).toEqual([
      { key: B("web-logs"), kind: "AWS::S3::Bucket", listedType: "AWS::S3::Bucket", location: "us-east-1", properties: [{ path: "attrs.VersioningConfiguration.Status", before: "Suspended", after: "Enabled" }] },
    ]);
    expect(d.counts.properties).toBe(1);
  });

  it("adds and removes nodes only where both reads listed the type", () => {
    expect(d.nodes.added.map((n) => n.key)).toEqual([B("new-bucket")]);
    expect(d.nodes.removed.map((n) => n.key)).toEqual([B("old-bucket")]);
  });

  it("edges: added, removed, and not observed when an end's type was not listed", () => {
    expect(d.edges.added.map((e) => [e.from, e.to])).toEqual([[ROLE, B("new-bucket")]]);
    expect(d.edges.removed.map((e) => [e.from, e.to])).toEqual([[ROLE, B("old-bucket")]]);
    expect(d.edges.notObserved).toEqual([expect.objectContaining({ from: ROLE, to: QUEUE, side: "to", unobservedEnd: QUEUE, verdict: "read-failed" })]);
    expect(d.edges.removed.some((e) => e.to === QUEUE)).toBe(false);
  });

  it("names the coverage verdict that moved", () => {
    expect(d.coverage).toEqual([{ listedType: "AWS::SQS::Queue", location: "us-east-1", before: "listed", after: "read-failed" }]);
  });

  it("the reverse diff swaps added and removed, and the queue is first observed, never added", () => {
    const r = diffIndexVersions(load(V2), load(V1));
    expect(r.nodes.added.map((n) => n.key)).toEqual([B("old-bucket")]);
    expect(r.nodes.removed.map((n) => n.key)).toEqual([B("new-bucket")]);
    expect(r.nodes.notObserved).toEqual([expect.objectContaining({ key: QUEUE, side: "from", verdict: "read-failed" })]);
  });

  it("same digest: unchanged, nothing walked", () => {
    const a = load(V1);
    const u = diffIndexVersions(a, { ...a, graph: { nodes: [], edges: [] } });
    expect(u.unchanged).toBe(true);
    expect(u.counts.removed).toBe(0);
  });

  it("takes chant's own IndexDocument", () => {
    const doc = load(V1) as unknown as IndexDocument;
    expect(diffIndexVersions(doc, doc).unchanged).toBe(true);
  });
});

describe("a scope mismatch", () => {
  it("is refused by name, with both scope keys", () => {
    const a = load(V1);
    const b = load(V2);
    b.stamp = { ...b.stamp, scopeKey: "cloud/aws/000000000000/0123456789ab" };
    expect(() => diffIndexVersions(a, b)).toThrow(IndexScopeMismatch);
    try {
      diffIndexVersions(a, b);
    } catch (e) {
      expect((e as IndexScopeMismatch).code).toBe("index-scope-mismatch");
      expect((e as Error).message).toContain(SCOPE);
      expect((e as Error).message).toContain("cloud/aws/000000000000/0123456789ab");
    }
  });

  it("a document of another shape is not an index version", () => {
    expect(() => diffIndexVersions({ index: "v2" } as unknown as IndexDiffDocument, load(V1))).toThrow(NotAnIndexVersion);
  });
});

describe("an unobserved type is never reported as removed", () => {
  it("a type with no coverage entry in the later read is not observed, not removed", () => {
    const b = load(V2);
    b.coverage = b.coverage.filter((c) => c.listedType !== "AWS::S3::Bucket");
    const d = diffIndexVersions(load(V1), b);
    expect(d.nodes.removed).toEqual([]);
    expect(d.nodes.notObserved.filter((n) => n.listedType === "AWS::S3::Bucket" && n.side === "to").map((n) => [n.key, n.verdict])).toEqual([[B("old-bucket"), "not-in-coverage"]]);
  });

  it("a wildcard entry speaks for every type and location; a wildcard read-failed does not", () => {
    const b = load(V2);
    b.coverage = [{ listedType: "*", location: "*", verdict: "listed" }];
    expect(diffIndexVersions(load(V1), b).nodes.removed.map((n) => n.key)).toEqual([B("old-bucket"), QUEUE]);
    b.coverage = [{ listedType: "*", location: "us-east-1", verdict: "read-failed" }];
    const d = diffIndexVersions(load(V1), b);
    expect(d.nodes.removed).toEqual([]);
    expect(d.edges.removed).toEqual([]);
  });

  it("indexAbsence is indexCoverageFor's rule: exact over wildcard, listed means removed", () => {
    const cov = [
      { listedType: "*", location: "*", verdict: "listed" },
      { listedType: "AWS::SQS::Queue", location: "*", verdict: "access-denied", detail: "no sqs:ListQueues" },
      { listedType: "AWS::SQS::Queue", location: "eu-west-1", verdict: "listed" },
    ];
    expect(indexAbsence(cov, "AWS::SQS::Queue", "eu-west-1")).toEqual({ kind: "removed" });
    expect(indexAbsence(cov, "AWS::SQS::Queue", "us-east-1")).toEqual({ kind: "not-observed", verdict: "access-denied", detail: "no sqs:ListQueues" });
    expect(indexAbsence(cov, "AWS::S3::Bucket", "us-east-1")).toEqual({ kind: "removed" });
    expect(indexAbsence([], "AWS::S3::Bucket", "us-east-1")).toEqual({ kind: "not-observed", verdict: "not-in-coverage" });
    expect(indexCoverageFor(cov, "AWS::SQS::Queue", "us-east-1")?.verdict).toBe("access-denied");
  });
});

describe("version references", () => {
  it("parses <scopeKey>/<version>, <scopeKey>, and a bare version in another's scope", () => {
    expect(parseIndexVersionRef(`${SCOPE}/${V1}`)).toEqual({ scopeKey: SCOPE, version: V1 });
    expect(parseIndexVersionRef(`${SCOPE}/`)).toEqual({ scopeKey: SCOPE });
    expect(parseIndexVersionRef(V2, SCOPE)).toEqual({ scopeKey: SCOPE, version: V2 });
    expect(() => parseIndexVersionRef(V2)).toThrow(/no scope/);
  });
});

/** A local store holding both fixture versions of one scope, and one version of another. */
function localStore() {
  const cwd = mkdtempSync(join(tmpdir(), "chant-index-diff-"));
  const scope = join(cwd, "store", "index", ...SCOPE.split("/"));
  mkdirSync(scope, { recursive: true });
  copyFileSync(join(DIR, V1), join(scope, V1));
  copyFileSync(join(DIR, V2), join(scope, V2));
  const other = join(cwd, "store", "index", "cloud", "aws", "000000000000", "0123456789ab");
  mkdirSync(other, { recursive: true });
  copyFileSync(join(DIR, V1), join(other, "20261026T140000Z-cccccccccccc.json"));
  return createSnapshotStore({ store: "local", dir: "store" }, { cwd });
}

describe("reading versions through the store (#4519)", () => {
  it("a scope alone diffs its last two versions", async () => {
    const d = await diffIndexVersionRefs(localStore(), { scopeKey: SCOPE });
    expect(d.from.version).toBe(V1);
    expect(d.to.version).toBe(V2);
    expect(d.counts.properties).toBe(1);
  });

  it("a scope's latest version, and a version the store lacks", async () => {
    const store = localStore();
    expect((await readIndexVersionRef(store, { scopeKey: SCOPE })).version).toBe(V2);
    await expect(readIndexVersionRef(store, { scopeKey: SCOPE, version: "20261026T150000Z-dddddddddddd.json" })).rejects.toThrow(NotAnIndexVersion);
  });

  it("refuses two references under different scope paths before reading either", async () => {
    await expect(
      diffIndexVersionRefs(localStore(), { scopeKey: SCOPE, version: V1 }, { scopeKey: "cloud/aws/000000000000/0123456789ab", version: "20261026T140000Z-cccccccccccc.json" }),
    ).rejects.toMatchObject({ code: "index-scope-mismatch" });
  });

  it("a stored version whose stamp names another scope than its path is refused", async () => {
    // The other scope path holds V1's document, whose stamp names SCOPE; its latest against
    // a version of that path compares the stamps and refuses.
    const store = localStore();
    const other = await readIndexVersionRef(store, { scopeKey: "cloud/aws/000000000000/0123456789ab" });
    const b = { ...load(V2), stamp: { ...load(V2).stamp, scopeKey: "cloud/aws/000000000000/0123456789ab" } };
    expect(() => diffIndexVersions(other.doc, b)).toThrow(/different scopes/);
  });

  it("one version in a scope has nothing before it", async () => {
    await expect(diffIndexVersionRefs(localStore(), { scopeKey: "cloud/aws/000000000000/0123456789ab" })).rejects.toThrow(/no version before/);
  });
});

describe("the module", () => {
  it("imports nothing outside chant core", () => {
    const src = readFileSync(join(import.meta.dirname, "index-diff.ts"), "utf8");
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    expect(imports.every((i) => i.startsWith("./") || i.startsWith("../"))).toBe(true);
  });
});
