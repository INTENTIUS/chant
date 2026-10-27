/**
 * #4536: the adoption file (`adopt: v1`). Refusals on its own and against
 * the index version it is read with, and the file an index import report
 * gives. Pure; nothing reaches a cloud.
 */
import { describe, expect, test } from "vitest";
import {
  adoptionFileFromImportReport,
  adoptionFileProblems,
  adoptionFileProblemsAgainst,
  validateAdoptionFile,
  type AdoptionFile,
} from "./adoption-file";
import { indexDocumentDigest, indexScopeKey, indexVersionName, type CloudIndexScope, type IndexDocument } from "./index-document";
import type { IndexImportReport } from "./index-import";

const SCOPE: CloudIndexScope = { kind: "cloud", substrate: "aws", scopeId: "111", locations: ["us-east-1"], types: "*" };
const BUCKET = "aws/111/us-east-1/AWS::S3::Bucket/logs";
const QUEUE = "aws/111/us-east-1/AWS::SQS::Queue/jobs";
const graph = {
  version: 1 as const,
  nodes: [
    { id: BUCKET, kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {}, listedType: "AWS::S3::Bucket", location: "us-east-1", nativeId: "logs" },
    { id: QUEUE, kind: "AWS::SQS::Queue", lexicon: "aws", attrs: {}, listedType: "AWS::SQS::Queue", location: "us-east-1", nativeId: "jobs" },
  ],
  edges: [],
  groups: {},
};
const DOC: IndexDocument = {
  index: "v1",
  stamp: { source: { kind: "cloud", name: "behold-lister" }, scope: SCOPE, scopeKey: indexScopeKey(SCOPE), observedAt: "2026-10-26T09:00:00Z", digest: indexDocumentDigest({ graph, coverage: [] }) },
  coverage: [],
  graph,
};
const file = (over: Partial<AdoptionFile> = {}): AdoptionFile => ({
  adopt: "v1",
  index: { scopeKey: DOC.stamp.scopeKey, version: indexVersionName(DOC.stamp.observedAt, DOC.stamp.digest), digest: DOC.stamp.digest },
  select: [{ node: BUCKET, as: "aws_s3_bucket.logs", type: "aws_s3_bucket" }],
  ...over,
});

describe("adoption file (#4536)", () => {
  test("a file naming the version it is read with is accepted, with or without a sha256: prefix", () => {
    expect(adoptionFileProblemsAgainst(file(), DOC)).toEqual([]);
    const prefixed = file();
    prefixed.index = { ...prefixed.index, digest: `sha256:${prefixed.index.digest}` };
    expect(adoptionFileProblemsAgainst(prefixed, DOC)).toEqual([]);
  });

  test("a digest, version or scope key that is not the version's is refused", () => {
    const other = "0".repeat(64);
    const wrongDigest = file();
    wrongDigest.index = { ...wrongDigest.index, digest: other, version: indexVersionName(DOC.stamp.observedAt, other) };
    expect(adoptionFileProblemsAgainst(wrongDigest, DOC).join("\n")).toMatch(/digest does not match/);
    const wrongScope = file();
    wrongScope.index = { ...wrongScope.index, scopeKey: "cloud/aws/222/abcdefabcdef" };
    expect(adoptionFileProblemsAgainst(wrongScope, DOC).join("\n")).toMatch(/scopeKey/);
    const wrongVersion = file();
    wrongVersion.index = { ...wrongVersion.index, version: indexVersionName("2026-10-25T09:00:00Z", DOC.stamp.digest) };
    expect(adoptionFileProblemsAgainst(wrongVersion, DOC).join("\n")).toMatch(/is not the version read/);
  });

  test("a version name that does not carry the digest is refused on its own", () => {
    const f = file();
    f.index = { ...f.index, version: "20261026T090000Z-000000000000.json" };
    expect(adoptionFileProblems(f).join("\n")).toMatch(/does not name the digest/);
  });

  test("a node the version does not hold is refused by name", () => {
    const f = file({ select: [{ node: "aws/111/us-east-1/AWS::S3::Bucket/gone", as: "aws_s3_bucket.gone" }] });
    expect(() => validateAdoptionFile(f, DOC)).toThrow(/AWS::S3::Bucket\/gone is not in index version/);
  });

  test("no select, a node selected twice and two nodes at one address are refused", () => {
    expect(adoptionFileProblems(file({ select: [] }))).toContain("select names no node");
    const twice = adoptionFileProblems(file({ select: [{ node: BUCKET, as: "a" }, { node: BUCKET, as: "b" }] }));
    expect(twice.join("\n")).toMatch(/selected twice/);
    const oneAddress = adoptionFileProblems(file({ select: [{ node: BUCKET, as: "a" }, { node: QUEUE, as: "a" }] }));
    expect(oneAddress.join("\n")).toMatch(/two nodes are adopted as a/);
  });

  test("an import report gives a file with each imported resource as its logical id; declared and unsupported ones are left out", () => {
    const report: IndexImportReport = {
      report: "chant-index-import/v1",
      index: [{ scopeKey: DOC.stamp.scopeKey, observedAt: DOC.stamp.observedAt, digest: DOC.stamp.digest, source: "behold-lister" }],
      selection: { all: true },
      resources: [
        { node: QUEUE, identity: { substrate: "aws", scopeId: "111", listedType: "AWS::SQS::Queue", location: "us-east-1", nativeId: "jobs" }, cloudIds: [], lexicon: "aws", kind: "AWS::SQS::Queue", status: "imported", logicalId: "QueueJobs", group: "" },
        { node: BUCKET, identity: { substrate: "aws", scopeId: "111", listedType: "AWS::S3::Bucket", location: "us-east-1", nativeId: "logs" }, cloudIds: [], lexicon: "aws", kind: "AWS::S3::Bucket", status: "declared", entity: "logs" },
      ],
      parameters: [],
      groups: [],
    };
    const f = adoptionFileFromImportReport(report);
    expect(f.select).toEqual([{ node: QUEUE, as: "QueueJobs", type: "AWS::SQS::Queue" }]);
    expect(adoptionFileProblemsAgainst(f, DOC)).toEqual([]);
    expect(() => adoptionFileFromImportReport({ ...report, index: [...report.index, { ...report.index[0], scopeKey: "cloud/aws/111/x" }] })).toThrow(/names one index version/);
    expect(() => adoptionFileFromImportReport({ ...report, resources: [report.resources[1]] })).toThrow(/nothing to adopt/);
  });
});
