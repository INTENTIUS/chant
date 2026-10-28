/**
 * #4632: drift attribution and the unrecorded writer audit in CI core, over
 * recorded CloudTrail output (`./__fixtures__`). No test reaches a cloud:
 * the `aws` CLI is a function that prints the recorded file.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { driftDocument, driftRecord, type DriftRecord } from "../drift-record";
import type { OpRunRecord } from "../op/runtime";
import {
  applyWindowsFromRuns,
  attributeDrift,
  awsAuditLog,
  classifyEvent,
  judgeWrites,
  knownWrite,
  parseAuditLogSetting,
  renderUnrecorded,
  routeAttributions,
  unrecordedWrites,
  type AuditLog,
  type AwsRun,
} from "./index";

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf-8");

/** An `aws` that prints the recorded output and keeps the arguments it was run with. */
function recordedAws(file: string): { run: AwsRun; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, run: (args) => (calls.push(args), { status: 0, stdout: fixture(file), stderr: "" }) };
}

function drifted(over: Partial<DriftRecord>): DriftRecord {
  return driftRecord({
    member: "app",
    engine: "terraform",
    address: "aws_s3_bucket.logs",
    resourceType: "aws_s3_bucket",
    node: null,
    observedAt: "2026-10-28T00:00:00Z",
    read: "refresh",
    status: "drifted",
    attributes: [{ path: "versioning", before: false, after: true }],
    evidence: { tool: "terraform" },
    ...over,
  } as DriftRecord);
}

describe("the audit log reader (#4632)", () => {
  test("--audit-log takes aws with an optional region", () => {
    expect(parseAuditLogSetting("aws:us-east-1")).toEqual({ cloud: "aws", region: "us-east-1" });
    expect(parseAuditLogSetting("gcp")).toEqual({ error: expect.stringContaining("CloudTrail") });
  });

  test("a person, a controller, and a machine role that says neither", () => {
    expect(classifyEvent({ userIdentity: { type: "IAMUser", userName: "lee" } })).toEqual({ actor: "human", who: "lee" });
    expect(classifyEvent({ userIdentity: { type: "AWSService", invokedBy: "autoscaling.amazonaws.com" } })).toEqual({ actor: "controller", who: "autoscaling.amazonaws.com" });
    expect(classifyEvent({ userIdentity: { type: "AssumedRole", arn: "arn:aws:sts::1:assumed-role/ci/runner" } })).toBeUndefined();
  });

  test("a lookup names the newest write outside the engine, from recorded CloudTrail", async () => {
    const aws = recordedAws("cloudtrail-lookup-bucket.json");
    const log = awsAuditLog({ run: aws.run, region: "us-east-1", now: () => new Date("2026-10-28T00:00:00Z") });
    expect(await log.lookup({ type: "aws_s3_bucket", address: "aws_s3_bucket.logs", ref: "acme-logs" })).toEqual({
      status: "found",
      actor: "human",
      who: "lee@example.com",
      event: "PutBucketVersioning",
      at: "2026-10-21T14:30:00Z",
    });
    expect(aws.calls[0]).toEqual(expect.arrayContaining(["lookup-events", "AttributeKey=ResourceName,AttributeValue=acme-logs", "--region", "us-east-1", "--start-time", "2026-10-14T00:00:00.000Z"]));
    expect(await log.lookup({ type: "google_storage_bucket", address: "x", ref: "x" })).toMatchObject({ status: "unavailable" });
  });

  test("a CLI that is missing or fails reads as unavailable, with why", async () => {
    const missing: AwsRun = () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn aws ENOENT"), { code: "ENOENT" }) });
    expect(await awsAuditLog({ run: missing }).writes({ since: "a", until: "b" })).toEqual({ status: "unavailable", reason: "the aws CLI is not installed" });
    const denied: AwsRun = () => ({ status: 254, stdout: "", stderr: "An error occurred (AccessDeniedException)\nmore" });
    expect(await awsAuditLog({ run: denied }).lookup({ type: "aws_s3_bucket", address: "a", ref: "b" })).toEqual({ status: "unavailable", reason: "An error occurred (AccessDeniedException)" });
  });
});

describe("drift attribution over chant's drift document (#4632)", () => {
  test("the known-writes table answers first, for Terraform and Pulumi types alike", () => {
    expect(knownWrite("aws_ecs_service", "desired_count", { before: 2, live: 5 })?.actor).toBe("controller");
    expect(knownWrite("aws:ecs/service:Service", "desiredCount", { before: 2, live: 5 })?.actor).toBe("controller");
    expect(knownWrite("aws_s3_bucket", "tags", { before: { a: "1" }, live: { a: "1", "aws:cloudformation:stack-name": "x" } })?.actor).toBe("controller");
    expect(knownWrite("aws_s3_bucket", "tags", { before: { a: "1" }, live: { a: "2" } })).toBeUndefined();
  });

  test("the table, then the member's log, then unattributed; an unreadable log is noted once", async () => {
    const doc = driftDocument([
      drifted({}),
      drifted({ member: "web", address: "aws_ecs_service.web", resourceType: "aws_ecs_service", attributes: [{ path: "desired_count", before: 2, after: 6 }] }),
      drifted({ member: "edge", engine: "pulumi", address: "urn:pulumi:dev::edge::aws:s3/bucketV2:BucketV2::assets", resourceType: "aws:s3/bucketV2:BucketV2", attributes: [{ path: "forceDestroy", before: false, after: true }, { path: "acl", before: "private", after: "public-read" }] }),
    ]);
    const bucketLog = awsAuditLog({ run: recordedAws("cloudtrail-lookup-bucket.json").run, now: () => new Date("2026-10-28T00:00:00Z") });
    const down: AuditLog = { lookup: async () => ({ status: "unavailable", reason: "AccessDenied" }), writes: async () => ({ status: "unavailable", reason: "AccessDenied" }) };
    const { attributions, notes } = await attributeDrift(doc, {
      logFor: (m) => (m === "app" ? bucketLog : m === "edge" ? down : undefined),
      refOf: (r) => (r.member === "app" ? "acme-logs" : "assets"),
    });
    expect(attributions.map((a) => [a.member, a.path, a.source, a.actor])).toEqual([
      ["app", "versioning", "audit", "human"],
      ["edge", "acl", "unattributed", undefined],
      ["edge", "forceDestroy", "unattributed", undefined],
      ["web", "desired_count", "table", "controller"],
    ]);
    expect(notes).toEqual(["edge: the audit log is unavailable: AccessDenied"]);
  });

  test("a model answers only what the table and the log left, at or above its threshold", async () => {
    const doc = driftDocument([drifted({ attributes: [{ path: "a", before: 1, after: 2 }, { path: "b", before: "x", after: "y" }] })]);
    const asked: unknown[] = [];
    const { attributions, notes } = await attributeDrift(doc, {
      ask: async (state) => {
        asked.push(state);
        return state.attribute === "a" ? { actor: "provider-default", probability: 0.91, model: "m1" } : { actor: "human", probability: 0.4, model: "m1" };
      },
    });
    expect(attributions.map((a) => a.source)).toEqual(["model", "unattributed"]);
    expect(asked[1]).toEqual({ resource_type: "aws_s3_bucket", attribute: "b", value_in_code: "(a string of 1 characters)", live_value: "(a string of 1 characters)" });
    expect(notes[0]).toContain("below the threshold");
  });

  test("the route speaks each engine's way of ignoring an attribute", () => {
    const routed = routeAttributions([
      { member: "web", engine: "terraform", address: "aws_ecs_service.web", path: "desired_count", actor: "controller", source: "table", detail: "d" },
      { member: "edge", engine: "pulumi", address: "urn:x", path: "desiredCount", actor: "controller", source: "table", detail: "d" },
      { member: "app", engine: "terraform", address: "aws_s3_bucket.logs", path: "versioning", actor: "human", source: "audit", detail: "PutBucketVersioning by lee" },
    ]);
    expect(routed.lines[0]).toContain("lifecycle { ignore_changes = [desired_count] }");
    expect(routed.lines[1]).toContain('ignoreChanges: ["desiredCount"]');
    expect(routed.lines[2]).toContain("human edit");
    expect([...routed.leave.keys()]).toEqual(["aws_ecs_service.web", "urn:x"]);
  });
});

describe("the unrecorded writer audit against the ledger's applies (#4632)", () => {
  const runs = [
    { version: 1, id: "plywood-up-1", op: "plywood-up", env: "prod", started: "2026-10-25T10:00:00Z", ended: "2026-10-25T10:02:00Z", status: "ok", labels: { Principal: "plywood-up" }, outcomes: {}, phases: [], wave: { spec: "plywood-up", number: 1, name: "prod", job: "wave", exitCode: 0, applied: ["app"], failed: [], moved: [] } },
    { version: 1, id: "drift-1", op: "plywood-drift", env: "prod", started: "2026-10-25T12:59:00Z", ended: "2026-10-25T13:01:00Z", status: "ok", labels: {}, outcomes: {}, phases: [] },
  ] as unknown as OpRunRecord[];

  test("only applies make windows: a wave job that applied, not a drift read", () => {
    expect(applyWindowsFromRuns(runs)).toEqual([{ run: "plywood-up-1", op: "plywood-up", started: "2026-10-25T10:00:00Z", ended: "2026-10-25T10:02:00Z", principals: ["plywood-up"] }]);
  });

  test("over recorded CloudTrail: the apply's own write is recorded, a person's is not, a controller's is apart, a recent one waits", async () => {
    const aws = recordedAws("cloudtrail-writes-window.json");
    const report = await unrecordedWrites(awsAuditLog({ run: aws.run }), applyWindowsFromRuns(runs), {
      since: "2026-10-25T00:00:00Z",
      until: "2026-10-28T12:00:00Z",
      now: new Date("2026-10-28T12:00:00Z"),
    });
    expect(aws.calls[0]).toEqual(expect.arrayContaining(["AttributeKey=ReadOnly,AttributeValue=false", "--start-time", "2026-10-25T00:00:00Z"]));
    expect(report.recorded).toBe(1);
    expect(report.controller.map((w) => w.event)).toEqual(["SetDesiredCapacity"]);
    expect(report.pending).toBe(1);
    expect(report.unrecorded.map((w) => [w.event, w.who, w.why])).toEqual([
      ["PutBucketAcl", "lee@example.com", "plywood-up-1 ran then as plywood-up, not lee@example.com"],
      ["PutBucketVersioning", "lee@example.com", "no recorded apply ran then"],
    ]);
    expect(renderUnrecorded(report)).toContain("2 writes no recorded apply made, 1 recorded, 1 by a controller, 1 too recent to judge");
  });

  test("resources narrow the writes to what the member manages; an unreadable log judges nothing", async () => {
    const writes = [{ at: "2026-10-25T13:00:00Z", event: "PutBucketVersioning", who: "lee", resources: ["arn:aws:s3:::other"] }];
    expect(judgeWrites(writes, [], { since: "a", until: "b", now: new Date("2026-10-28T00:00:00Z"), resources: ["acme-logs"] }).unrecorded).toEqual([]);
    const down: AuditLog = { lookup: async () => ({ status: "silent" }), writes: async () => ({ status: "unavailable", reason: "no trail" }) };
    expect(await unrecordedWrites(down, [], { since: "a", until: "b" })).toMatchObject({ unavailable: "no trail", unrecorded: [] });
  });
});
