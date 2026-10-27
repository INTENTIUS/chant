/**
 * #4537: what `chant run --components <name> --adopt <file>` hands the
 * deploy step. The adoption file is read and checked against the index
 * version it names, the review prints each change set and is the gate
 * (`--yes`, a terminal's answer, or no), and the command refuses `all`, a
 * list, and another runtime. No cloud and no store: the index loader is a
 * fake.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { adoptionIndexRef, adoptionReview, loadDeployAdoption, renderAdoptionReview, type AdoptionReviewRequest } from "./adoption";
import { adoptRefusal } from "../cli/handlers/run";
import { parseArgs } from "../cli/parse-args";
import { indexDocumentDigest, indexScopeKey, indexVersionName, type CloudIndexScope, type IndexDocument } from "../lifecycle/index-document";
import type { AdoptionFile } from "../lifecycle/adoption-file";

const SCOPE: CloudIndexScope = { kind: "cloud", substrate: "aws", scopeId: "000000000000", locations: ["us-east-1"], types: "*" };
const BUCKET = "aws/000000000000/us-east-1/AWS::S3::Bucket/web-logs";
const graph = {
  version: 1 as const,
  nodes: [{ id: BUCKET, kind: "AWS::S3::Bucket", lexicon: "aws", attrs: {}, listedType: "AWS::S3::Bucket", location: "us-east-1", nativeId: "web-logs" }],
  edges: [],
  groups: {},
};
const INDEX: IndexDocument = {
  index: "v1",
  stamp: { source: { kind: "cloud", name: "behold-lister" }, scope: SCOPE, scopeKey: indexScopeKey(SCOPE), observedAt: "2026-10-26T12:00:00Z", digest: indexDocumentDigest({ graph, coverage: [] }) },
  coverage: [],
  graph,
};
const FILE: AdoptionFile = {
  adopt: "v1",
  index: { scopeKey: INDEX.stamp.scopeKey, version: indexVersionName(INDEX.stamp.observedAt, INDEX.stamp.digest), digest: INDEX.stamp.digest },
  select: [{ node: BUCKET, as: "BucketWebLogs", type: "AWS::S3::Bucket" }],
};

function write(content: unknown): { dir: string; name: string } {
  const dir = mkdtempSync(join(tmpdir(), "deploy-adoption-test-"));
  writeFileSync(join(dir, "adopt.json"), typeof content === "string" ? content : JSON.stringify(content));
  return { dir, name: "adopt.json" };
}

describe("loadDeployAdoption (#4537)", () => {
  test("reads the file and the index version it names, by scope key and version", async () => {
    const { dir, name } = write(FILE);
    const asked: string[] = [];
    const loaded = await loadDeployAdoption(name, {
      cwd: dir,
      loadIndex: async (ref) => {
        asked.push(ref);
        return [INDEX];
      },
    });
    expect(asked).toEqual([adoptionIndexRef(FILE)]);
    expect(asked[0]).toBe(`${INDEX.stamp.scopeKey}@${FILE.index.version}`);
    expect(loaded.adoption).toEqual(FILE);
    expect(loaded.index).toBe(INDEX);
  });

  test("refuses a missing file, a file that is not JSON, and one that is not an adoption file", async () => {
    const none = mkdtempSync(join(tmpdir(), "deploy-adoption-test-"));
    await expect(loadDeployAdoption("adopt.json", { cwd: none, loadIndex: async () => [INDEX] })).rejects.toThrow(/no such file/);
    const bad = write("{not json");
    await expect(loadDeployAdoption(bad.name, { cwd: bad.dir, loadIndex: async () => [INDEX] })).rejects.toThrow(/not JSON/);
    const empty = write({ ...FILE, select: [] });
    await expect(loadDeployAdoption(empty.name, { cwd: empty.dir, loadIndex: async () => [INDEX] })).rejects.toThrow(/select names no node/);
  });

  test("refuses a file that does not match the version read, and a node the version does not hold", async () => {
    const other = { ...FILE, select: [{ node: "aws/000000000000/us-east-1/AWS::S3::Bucket/elsewhere", as: "BucketElsewhere" }] };
    const { dir, name } = write(other);
    await expect(loadDeployAdoption(name, { cwd: dir, loadIndex: async () => [INDEX] })).rejects.toThrow(/is not in index version/);
    const stale = write({ ...FILE, index: { ...FILE.index, digest: "0".repeat(64), version: indexVersionName(INDEX.stamp.observedAt, "0".repeat(64)) } });
    await expect(loadDeployAdoption(stale.name, { cwd: stale.dir, loadIndex: async () => [INDEX] })).rejects.toThrow(/digest does not match/);
  });

  test("says which version it could not read", async () => {
    const { dir, name } = write(FILE);
    await expect(
      loadDeployAdoption(name, {
        cwd: dir,
        loadIndex: async () => {
          throw new Error("no index version is recorded");
        },
      }),
    ).rejects.toThrow(new RegExp(`could not read index version ${INDEX.stamp.scopeKey}@`));
  });
});

const REQUEST: AdoptionReviewRequest = {
  member: "web",
  step: "markers",
  changeSet: "cs-markers",
  entries: [{ member: "web", lexicon: "aws", planner: "chant", address: "BucketWebLogs", type: "AWS::S3::Bucket", name: "BucketWebLogs", attributes: [{ path: "Tags" }], action: "update", disruption: "in-place" }],
  lines: ["marker write, tags only: BucketWebLogs (AWS::S3::Bucket) Tags += chant:env=prod"],
};

describe("the adoption review (#4537)", () => {
  test("prints the change set, its changes and each marker write as tags only", () => {
    expect(renderAdoptionReview(REQUEST)).toEqual([
      "Marker change set cs-markers for web: writes chant's marker tags on the imported resources, tags only",
      "  update BucketWebLogs (AWS::S3::Bucket): Tags",
      "  marker write, tags only: BucketWebLogs (AWS::S3::Bucket) Tags += chant:env=prod",
    ]);
  });

  test("--yes approves after printing; a terminal is asked; with neither it declines and says how to approve", async () => {
    const out: string[] = [];
    expect(await adoptionReview({ yes: true, write: (l) => out.push(l) })(REQUEST)).toBe(true);
    expect(out.at(-1)).toMatch(/approved by --yes/);

    const questions: string[] = [];
    expect(await adoptionReview({ yes: false, write: () => {}, ask: async (q) => (questions.push(q), false) })(REQUEST)).toBe(false);
    expect(questions).toEqual(["Execute the marker change set cs-markers? [y/N] "]);

    const lines: string[] = [];
    expect(await adoptionReview({ yes: false, write: (l) => lines.push(l) })(REQUEST)).toBe(false);
    expect(lines.at(-1)).toMatch(/run again with --yes/);
  });
});

describe("--adopt <file> (#4537)", () => {
  test("parses its file, and refuses a missing one", () => {
    const parsed = parseArgs(["run", "--components", "web", "--env", "prod", "--adopt", "adopt.json", "--yes"]);
    expect(parsed.adopt).toBe("adopt.json");
    expect(parsed.yes).toBe(true);
    expect(() => parseArgs(["run", "--components", "web", "--adopt"])).toThrow(/--adopt needs an adoption file/);
  });
});

describe("adoptRefusal (#4537)", () => {
  test("one component on the local runtime only", () => {
    expect(adoptRefusal("web", "local")).toBeUndefined();
    expect(adoptRefusal("all", "local")?.message).toMatch(/name one component, not all/);
    expect(adoptRefusal("web,api", "local")?.message).toMatch(/not a list/);
    expect(adoptRefusal("web", "fountain")?.message).toMatch(/local runtime only/);
  });
});
