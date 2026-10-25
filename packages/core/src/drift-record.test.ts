/**
 * The drift record (#4451): the constructor's rules, redaction, the
 * document and its digest, the block rollup, the NDJSON stream, and the
 * chant adapters over `__fixtures__/drift-record/`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  attributePathKeys,
  componentStatusDriftRecords,
  decodeDriftLine,
  decodeDriftLines,
  deepDiffDriftRecords,
  DRIFT_READS,
  DRIFT_SCHEMA_ID,
  DRIFT_STATUSES,
  driftDocument,
  driftDocumentDigest,
  DriftRecordError,
  driftRecord,
  driftSettle,
  driftRecordLine,
  driftStart,
  encodeDriftLine,
  encodeDriftLines,
  foldDriftLines,
  liveDiffDriftRecords,
  mapDriftToGraph,
  mergeDeepDrift,
  parseDriftDocument,
  DRIFT_INSTANCE_ROLLUP,
  rollupDriftByBlock,
  STATE_READ_STATUSES,
  type DriftLine,
  type DriftRecord,
  type DriftSettleLine,
  type DriftStatus,
} from "./drift-record";
import type { DeepDiffResult } from "./lifecycle/deep-diff";
import type { LiveDiffResult } from "./lifecycle/live-diff";
import type { ComponentStatusResult } from "./lifecycle/status";
import { UNOBSERVED_REASONS } from "./observation";
import { contract, validSchema } from "./workspace/__fixtures__/contract-repo";
import schema from "./workspace/drift.schema.json";

const DIR = join(import.meta.dirname, "__fixtures__", "drift-record");
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(DIR, name), "utf-8")) as T;
const AT = "2026-10-25T12:00:00Z";
const { expectValid } = contract(schema);
/** One `$defs` entry of the schema as its own schema, without the `$id` the whole schema already registered. */
const part = (def: keyof typeof schema.$defs) => contract({ $schema: schema.$schema, $defs: schema.$defs, $ref: `#/$defs/${def}` });
const recordSchema = part("record");
const lineSchema = part("line");

function rec(over: Partial<DriftRecord> = {}): DriftRecord {
  return {
    member: "estate",
    engine: "terraform",
    address: "aws_eip.pool[0]",
    node: null,
    observedAt: AT,
    read: "plan",
    status: "in-sync",
    evidence: { tool: "terraform" },
    ...over,
  } as DriftRecord;
}

/** JSON out and back through the document reader: what a consumer in another process sees. */
function roundTrip(records: DriftRecord[]) {
  const doc = driftDocument(records, { chant: "0.124.34" });
  expectValid(doc);
  const back = parseDriftDocument(JSON.parse(JSON.stringify(doc)));
  expect(back).toEqual(doc);
  return doc;
}

const statusOf = (records: DriftRecord[]) => Object.fromEntries(records.map((r) => [r.address, r.status]));

describe("the schema", () => {
  test("is a valid schema and names the module's id", () => {
    expect(validSchema(schema)).toBe(true);
    expect(schema.$id).toBe(DRIFT_SCHEMA_ID);
    expect(schema.$defs.record.properties.status.enum).toEqual([...DRIFT_STATUSES]);
    expect(schema.$defs.record.properties.read.enum).toEqual([...DRIFT_READS]);
    expect([...schema.$defs.unobserved.properties.reason.enum].sort()).toEqual([...UNOBSERVED_REASONS].sort());
  });
});

describe("a state read", () => {
  test("never yields in-sync or drifted", () => {
    for (const status of ["in-sync", "drifted"] as const) {
      let err: unknown;
      try {
        driftRecord(rec({ read: "state", status, ...(status === "drifted" ? { attributes: [{ path: "tags.env" }] } : {}) }));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(DriftRecordError);
      expect((err as DriftRecordError).rule).toBe("state-read-status");
      expect((err as Error).message).toContain("aws_eip.pool[0]");
      expect((err as Error).message).toContain(status);
    }
  });

  test("yields only recorded, pending or not-observed, for every status", () => {
    for (const status of DRIFT_STATUSES) {
      const make = () =>
        driftRecord(rec({ read: "state", status, ...(status === "not-observed" ? { unobserved: { reason: "read-failed" } } : {}) }));
      if (STATE_READ_STATUSES.includes(status)) expect(make().status).toBe(status);
      else expect(make, status).toThrow(DriftRecordError);
    }
  });

  test("the schema refuses it too", () => {
    expect(recordSchema.validate(rec({ read: "state", status: "in-sync" }))).toBe(false);
    expect(recordSchema.validate(rec({ read: "state", status: "recorded" }))).toBe(true);
    expect(recordSchema.validate(rec({ status: "not-observed" }))).toBe(false);
  });
});

describe("the constructor", () => {
  test("not-observed always carries a legal reason", () => {
    expect(() => driftRecord(rec({ status: "not-observed" }))).toThrow(/not-observed needs unobserved.reason/);
    expect(() => driftRecord(rec({ status: "not-observed", unobserved: { reason: "gone" as never } }))).toThrow(DriftRecordError);
    for (const reason of UNOBSERVED_REASONS) {
      expect(driftRecord(rec({ status: "not-observed", unobserved: { reason } })).unobserved).toEqual({ reason });
    }
  });

  test("only not-observed carries unobserved, only drifted carries attributes", () => {
    expect(() => driftRecord(rec({ status: "in-sync", unobserved: { reason: "read-failed" } }))).toThrow(/only not-observed/);
    expect(() => driftRecord(rec({ status: "in-sync", attributes: [{ path: "a" }] }))).toThrow(/only drifted/);
    expect(() => driftRecord(rec({ status: "pending", attributesUnobserved: { reason: "read-failed" } }))).toThrow(/attributesUnobserved/);
  });

  test("refuses a record with no tool, a bad engine or a bad time, naming it", () => {
    expect(() => driftRecord(rec({ evidence: { tool: "" } }))).toThrow(/evidence.tool/);
    expect(() => driftRecord(rec({ engine: "cdk" as never }))).toThrow(/engine "cdk"/);
    expect(() => driftRecord(rec({ observedAt: "yesterday" }))).toThrow(/RFC 3339/);
  });
});

describe("redaction", () => {
  test("a planner's mark drops both values", () => {
    const r = driftRecord(rec({ status: "drifted", attributes: [{ path: "input.token_value", before: "a", after: "b", sensitive: true }] }));
    expect(r.attributes).toEqual([{ path: "input.token_value", sensitive: true }]);
  });

  test("a secret-bearing key name drops both values even unmarked", () => {
    const r = driftRecord(
      rec({
        status: "drifted",
        attributes: [
          { path: "tags.env", before: "prod", after: "dev" },
          { path: "settings[0].db_password", before: "x", after: "y" },
          { path: 'env["API_TOKEN"]', before: "x", after: "y" },
          { path: "Tags[0].Key", before: "k", after: "l" },
        ],
      }),
    );
    expect(r.attributes).toEqual([
      { path: "Tags[0].Key", before: "k", after: "l" },
      { path: 'env["API_TOKEN"]', sensitive: true },
      { path: "settings[0].db_password", sensitive: true },
      { path: "tags.env", before: "prod", after: "dev" },
    ]);
  });

  test("path keys skip indexes and read quoted keys", () => {
    expect(attributePathKeys('spec.env[0]["db.password"].value')).toEqual(["spec", "env", "db.password", "value"]);
    expect(attributePathKeys("a")).toEqual(["a"]);
  });
});

describe("the document", () => {
  test("keeps the later record for one (member, address, read), sorted, with counts", () => {
    const doc = driftDocument([
      rec({ address: "b", status: "pending" }),
      rec({ address: "a" }),
      rec({ address: "b", status: "in-sync" }),
      rec({ address: "b", read: "ownership", status: "unclaimed" }),
    ]);
    expect(doc.$schema).toBe(DRIFT_SCHEMA_ID);
    expect(doc.drift).toBe("v1");
    expect(doc.records.map((r) => [r.address, r.read, r.status])).toEqual([
      ["a", "plan", "in-sync"],
      ["b", "ownership", "unclaimed"],
      ["b", "plan", "in-sync"],
    ]);
    expect(doc.counts["in-sync"]).toBe(2);
    expect(doc.counts.unclaimed).toBe(1);
    expect(doc.counts.pending).toBe(0);
  });

  test("its digest leaves out observedAt and evidence and nothing else", () => {
    const a = driftDocument([rec()]);
    const later = driftDocument([rec({ observedAt: "2026-10-26T00:00:00Z", evidence: { tool: "tofu", version: "1.9" } })]);
    const other = driftDocument([rec({ status: "pending" })]);
    expect(driftDocumentDigest(later)).toBe(driftDocumentDigest(a));
    expect(driftDocumentDigest(other)).not.toBe(driftDocumentDigest(a));
    expect(driftDocumentDigest(a)).toMatch(/^jcs1-sha256:[0-9a-f]{64}$/);
  });

  test("a document read back refuses a state read painted green", () => {
    const doc = JSON.parse(JSON.stringify(driftDocument([rec({ read: "state", status: "recorded" })])));
    doc.records[0].status = "in-sync";
    expect(() => parseDriftDocument(doc)).toThrow(/state read/);
  });
});

describe("the block rollup", () => {
  const block = (...statuses: DriftStatus[]) =>
    rollupDriftByBlock(
      statuses.map((status, i) =>
        rec({
          address: `aws_eip.pool[${i}]`,
          node: `estate/aws_eip.pool[${i}]`,
          instanceOf: "estate/aws_eip.pool",
          status,
          ...(status === "not-observed" ? { unobserved: { reason: "read-failed" } } : {}),
        }),
      ),
    )[0]?.status;

  test("not-observed wins, then a difference, then an absence, then agreement", () => {
    expect(block("in-sync", "not-observed", "drifted")).toBe("not-observed");
    expect(block("in-sync", "drifted")).toBe("drifted");
    expect(block("in-sync", "pending")).toBe("pending");
    expect(block("in-sync", "runtime")).toBe("in-sync");
    expect(block()).toBeUndefined();
    expect([...DRIFT_INSTANCE_ROLLUP].sort()).toEqual([...DRIFT_STATUSES].sort());
  });

  test("groups instances under their block node and leaves out records on no node", () => {
    const rolled = rollupDriftByBlock([
      rec({ address: "aws_eip.pool[0]", node: "estate/aws_eip.pool[0]", instanceOf: "estate/aws_eip.pool" }),
      rec({ address: "aws_eip.pool[1]", node: "estate/aws_eip.pool[1]", instanceOf: "estate/aws_eip.pool", status: "drifted" }),
      rec({ address: "aws_vpc.main", node: "estate/aws_vpc.main" }),
      rec({ address: "aws_s3_bucket.x", node: null }),
    ]);
    expect(rolled.map((r) => [r.node, r.status, r.records.length])).toEqual([
      ["estate/aws_eip.pool", "drifted", 2],
      ["estate/aws_vpc.main", "in-sync", 1],
    ]);
  });
});

describe("mapping onto a graph", () => {
  test("uses graphNodeFor, the change set's rule, and leaves a Pulumi URN the graph lacks null", () => {
    const doc = driftDocument([
      rec({ address: "aws_eip.pool[0]" }),
      rec({ address: "module.app[0].aws_eip.pool[1]" }),
      rec({ engine: "chant", member: "dns", address: "zone", evidence: { tool: "chant" } }),
      rec({ engine: "pulumi", member: "site", address: "urn:pulumi:dev::site::aws:s3/bucket:Bucket::assets", evidence: { tool: "pulumi" } }),
    ]);
    const mapped = mapDriftToGraph(doc, { member: "infra", at: null, ids: ["estate/aws_eip.pool", "estate/module.app/aws_eip.pool", "zone"] });
    const at = (address: string) => mapped.records.find((r) => r.address === address)!;
    expect(at("aws_eip.pool[0]")).toMatchObject({ node: "infra/estate/aws_eip.pool[0]", instanceOf: "infra/estate/aws_eip.pool" });
    // Under an expanded module call the instance keeps the block node.
    expect(at("module.app[0].aws_eip.pool[1]").node).toBe("infra/estate/module.app/aws_eip.pool");
    expect(at("module.app[0].aws_eip.pool[1]").instanceOf).toBeUndefined();
    expect(at("zone").node).toBe("infra/zone");
    expect(at("urn:pulumi:dev::site::aws:s3/bucket:Bucket::assets").node).toBeNull();
    expect(mapDriftToGraph(doc, null).records.every((r) => r.node === null && r.instanceOf === undefined)).toBe(true);
    roundTrip(mapped.records);
  });

  test("puts a Pulumi URN on <member>/<key> by the URN rule (#4453, #4456), and a provider on none", () => {
    const doc = driftDocument([
      rec({ engine: "pulumi", member: "site", address: "urn:pulumi:dev::site::aws:s3/bucket:Bucket::assets", evidence: { tool: "pulumi" } }),
      rec({ engine: "pulumi", member: "site", address: "urn:pulumi:dev::site::pulumi:providers:aws::default", evidence: { tool: "pulumi" } }),
    ]);
    const mapped = mapDriftToGraph(doc, { member: null, at: null, ids: ["site/aws:s3/bucket:Bucket::assets"] });
    const at = (address: string) => mapped.records.find((r) => r.address === address)!;
    expect(at("urn:pulumi:dev::site::aws:s3/bucket:Bucket::assets").node).toBe("site/aws:s3/bucket:Bucket::assets");
    expect(at("urn:pulumi:dev::site::pulumi:providers:aws::default").node).toBeNull();
  });

  test("puts a plunge URN on the same node, by the pulumi rule (#4453)", () => {
    const doc = driftDocument([
      rec({ engine: "plunge", member: "site", address: "urn:pulumi:dev::site::aws:s3/bucket:Bucket::assets", read: "refresh", evidence: { tool: "plunge" } }),
    ]);
    const mapped = mapDriftToGraph(doc, { member: null, at: null, ids: ["site/aws:s3/bucket:Bucket::assets"] });
    expect(mapped.records[0].node).toBe("site/aws:s3/bucket:Bucket::assets");
  });
});

describe("the stream", () => {
  const start = driftStart({
    member: "estate",
    engine: "choudoufu",
    read: "ownership",
    at: AT,
    expected: [
      { address: "aws_vpc.main", node: "estate/aws_vpc.main" },
      { address: "aws_eip.pool[0]", node: "estate/aws_eip.pool[0]", instanceOf: "estate/aws_eip.pool", resourceType: "aws_eip" },
      { address: "aws_eip.pool[1]", node: "estate/aws_eip.pool[1]", instanceOf: "estate/aws_eip.pool", resourceType: "aws_eip" },
    ],
    evidence: { tool: "choudoufu", command: "choudoufu live-plan -json" },
  });
  const sent = [
    rec({ engine: "choudoufu", read: "ownership", address: "aws_vpc.main", status: "pending", evidence: { tool: "choudoufu" } }),
    rec({ engine: "choudoufu", read: "ownership", address: "aws_eip.pool[0]", evidence: { tool: "choudoufu" } }),
    rec({ engine: "choudoufu", read: "ownership", address: "aws_vpc.main", evidence: { tool: "choudoufu" } }),
  ];

  test("settle turns every unreported expected address into not-observed / not-reached", () => {
    const { line, records } = driftSettle(start, sent, "2026-10-25T12:00:05Z");
    expect(line.notReached).toEqual(["aws_eip.pool[1]"]);
    expect(line.counts["in-sync"]).toBe(2);
    expect(line.counts["not-observed"]).toBe(1);
    const missing = records.find((r) => r.address === "aws_eip.pool[1]")!;
    expect(missing.status).toBe("not-observed");
    expect(missing.unobserved?.reason).toBe("not-reached");
    expect(missing.node).toBe("estate/aws_eip.pool[1]");
    expect(missing.instanceOf).toBe("estate/aws_eip.pool");
    expect(missing.resourceType).toBe("aws_eip");
    // The later line for aws_vpc.main replaced the earlier one.
    expect(records.find((r) => r.address === "aws_vpc.main")!.status).toBe("in-sync");
  });

  test("round-trips through NDJSON and folds to the same document settle gives", () => {
    const { line: settle, records } = driftSettle(start, sent, "2026-10-25T12:00:05Z");
    const lines: DriftLine[] = [start, ...sent.map(driftRecordLine), settle];
    const text = encodeDriftLines(lines);
    expect(text.split("\n").filter(Boolean)).toHaveLength(lines.length);
    const decoded = decodeDriftLines(text);
    expect(decoded).toEqual(lines.map((l) => decodeDriftLine(encodeDriftLine(l))));
    const { document, reading } = foldDriftLines(decoded);
    expect(reading).toEqual([]);
    expect(document).toEqual(driftDocument(records));
    for (const l of decoded) lineSchema.expectValid(l);
  });

  test("a start with no settle leaves its unreported addresses reading, not a status", () => {
    const { document, reading } = foldDriftLines([start, driftRecordLine(sent[1])]);
    expect(document.records.map((r) => r.address)).toEqual(["aws_eip.pool[0]"]);
    expect(reading.map((r) => r.address)).toEqual(["aws_eip.pool[1]", "aws_vpc.main"]);
  });

  test("a malformed line is refused by name", () => {
    expect(() => decodeDriftLine('{"type":"drift-finish"}')).toThrow(/drift-finish/);
    expect(() => decodeDriftLine("not json")).toThrow(/not JSON/);
    expect(() => decodeDriftLine(JSON.stringify(driftRecordLine({ ...rec(), read: "state", status: "drifted" })))).toThrow(/state read/);
  });

  test("an answer under another read answers the expected address", () => {
    const { line } = driftSettle(start, [rec({ engine: "choudoufu", read: "plan", address: "aws_eip.pool[1]", evidence: { tool: "choudoufu" } })], AT);
    expect(line.notReached).toEqual(["aws_eip.pool[0]", "aws_vpc.main"]);
  });
});

describe("choudoufu's live-plan -resource stream, as it writes it", () => {
  const text = readFileSync(join(DIR, "choudoufu-resource.ndjson"), "utf-8");

  test("decodes line for line, the settle's reads carried as given", () => {
    const lines = decodeDriftLines(text);
    expect(lines.map((l) => l.type)).toEqual(["drift-start", "drift-record", "drift-record", "drift-record", "drift-settle"]);
    for (const l of lines) lineSchema.expectValid(JSON.parse(encodeDriftLine(l)));
    for (const raw of text.split("\n").filter(Boolean)) lineSchema.expectValid(JSON.parse(raw));
    const settle = lines[4] as DriftSettleLine;
    expect(settle.reads).toEqual({ recordsRead: 2, recordKeys: 2, recordListCalls: 0, sweepCalls: 0, scanTypes: [], scanListCalls: 0 });
    expect(settle.counts).toEqual({ drifted: 1, "not-observed": 1, unclaimed: 1 });
  });

  test("folds to one record per expected address, the unclaimed one under ownership", () => {
    const { document, reading } = foldDriftLines(decodeDriftLines(text));
    expect(reading).toEqual([]);
    expect(document.records.map((r) => [r.address, r.read, r.status])).toEqual([
      ["aws_eip.pool[0]", "plan", "drifted"],
      ["aws_eip.pool[1]", "ownership", "unclaimed"],
      ["aws_eip.pool[2]", "plan", "not-observed"],
    ]);
    expect(document.records[0].attributes).toEqual([{ path: "secret_value", sensitive: true }, { path: "tags" }]);
    roundTrip(document.records);
  });

  test("a settle with an expected address nobody answered folds it to not-reached", () => {
    const short = text.split("\n").filter(Boolean).filter((l) => !l.includes('"aws_eip.pool[2]","node"')).join("\n");
    const { document } = foldDriftLines(decodeDriftLines(short));
    const silent = document.records.find((r) => r.address === "aws_eip.pool[2]")!;
    expect(silent.status).toBe("not-observed");
    expect(silent.unobserved?.reason).toBe("not-reached");
    expect(silent.observedAt).toBe("2026-10-25T12:00:00Z");
  });
});

describe("lifecycle diff --live", () => {
  const records = liveDiffDriftRecords({ member: "app", observedAt: AT, diff: fixture<LiveDiffResult>("live-diff.json") });

  test("maps every bucket", () => {
    expect(statusOf(records)).toEqual({
      bucket: "drifted",
      cache: "missing",
      queue: "pending",
      role: "in-sync",
      "stray-bucket": "undeclared",
      topic: "in-sync",
      "web-7d9f-abcde": "runtime",
      widget: "not-observed",
    });
    expect(records.every((r) => r.read === "live-read" && r.engine === "chant")).toBe(true);
  });

  test("carries the paths, redacted, and the hole's reason and address", () => {
    const bucket = records.find((r) => r.address === "bucket")!;
    expect(bucket.attributes).toEqual([
      { path: "attributes.dbPassword", sensitive: true },
      { path: "attributes.tags.env", before: "prod", after: "staging" },
    ]);
    expect(records.find((r) => r.address === "widget")!.unobserved).toEqual({
      reason: "unsupported-kind",
      detail: "no reader for this CRD",
      queried: "/apis/x/v1/widgets/widget",
    });
    expect(records.find((r) => r.address === "web-7d9f-abcde")!.ownership).toEqual({ verdict: "foreign", ownedBy: "web" });
  });

  test("round-trips", () => {
    roundTrip(records);
  });
});

describe("deep observe", () => {
  const deep = deepDiffDriftRecords({ member: "app", observedAt: AT, diff: fixture<DeepDiffResult>("deep-diff.json") });

  test("drifted carries the paths, declared before and live after", () => {
    expect(deep.find((r) => r.address === "role")!.attributes).toEqual([
      { path: "MaxSessionDuration", before: 3600, after: 7200 },
      { path: "Policies[0].secretArn", sensitive: true },
      { path: "Tags[0].Value", before: "prod" },
    ]);
    expect(statusOf(deep)).toEqual({ bucket: "not-observed", role: "drifted", topic: "in-sync" });
    roundTrip(deep);
  });

  test("laid over the thin read, a deep hole stays on the attribute surface", () => {
    const thin = liveDiffDriftRecords({ member: "app", observedAt: AT, diff: fixture<LiveDiffResult>("live-diff.json") });
    const merged = mergeDeepDrift(thin, deep);
    const bucket = merged.find((r) => r.address === "bucket")!;
    expect(bucket.status).toBe("drifted");
    expect(bucket.attributesUnobserved).toEqual({ reason: "read-failed", detail: "GetBucketPolicy returned 500" });
    const role = merged.find((r) => r.address === "role")!;
    expect(role.status).toBe("drifted");
    expect(role.attributes?.map((a) => a.path)).toEqual(["MaxSessionDuration", "Policies[0].secretArn", "Tags[0].Value"]);
    expect(merged.find((r) => r.address === "topic")!.status).toBe("in-sync");
    roundTrip(merged);
  });
});

describe("component status", () => {
  const records = componentStatusDriftRecords({
    member: "app",
    observedAt: AT,
    rows: fixture<ComponentStatusResult>("component-status.json").rows,
  });

  test("maps every reconciliation verdict", () => {
    expect(statusOf(records)).toEqual({
      api: "in-sync",
      docs: "pending",
      edge: "drifted",
      jobs: "missing",
      mail: "not-observed",
      search: "not-observed",
      web: "drifted",
    });
    expect(records.find((r) => r.address === "search")!.unobserved).toEqual({ reason: "no-credentials", detail: "AWS_PROFILE unset" });
    expect(records.find((r) => r.address === "mail")!.unobserved?.reason).toBe("not-reached");
  });

  test("round-trips", () => {
    roundTrip(records);
  });
});
