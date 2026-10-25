/**
 * The terraform-family drift adapters (#4451) over recorded and hand-written
 * fixtures: a stock root's state and plan, and a choudoufu live root's
 * live-plan, live-ls and plan. Every adapter's records round-trip through
 * the document reader, and no state read yields in-sync or drifted.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { driftDocument, parseDriftDocument, STATE_READ_STATUSES, type DriftRecord } from "@intentius/chant/drift-record";
import {
  choudoufuLiveDriftRecords,
  choudoufuLiveLsDriftRecords,
  choudoufuLivePlanDriftRecords,
  choudoufuLivePlusPlanDriftRecords,
  terraformPlanDriftRecords,
  terraformStateDriftRecords,
} from "./drift-record";

const FIX = join(import.meta.dirname, "__fixtures__");
const read = (...path: string[]): unknown => JSON.parse(readFileSync(join(FIX, ...path), "utf-8"));
const AT = "2026-10-25T12:00:00Z";
const statusOf = (records: DriftRecord[]) => Object.fromEntries(records.map((r) => [r.address, r.status]));
const at = (records: DriftRecord[], address: string) => records.find((r) => r.address === address)!;

function roundTrip(records: DriftRecord[]): void {
  const doc = driftDocument(records);
  expect(parseDriftDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
}

describe("a stock root's state", () => {
  const records = terraformStateDriftRecords({
    member: "app",
    observedAt: AT,
    state: read("show-state.json"),
    declared: ["null_resource.first", "null_resource.second", "module.cdn.null_resource.edge", "null_resource.never_applied"],
  });

  test("is recorded where state has it and pending where it does not", () => {
    expect(statusOf(records)).toEqual({
      "module.cdn.null_resource.edge": "recorded",
      "null_resource.first": "recorded",
      "null_resource.never_applied": "pending",
      "null_resource.second": "recorded",
    });
    expect(at(records, "null_resource.first").ownership).toEqual({ verdict: "owned", by: "state" });
    roundTrip(records);
  });

  test("never yields in-sync or drifted, a failed read included", () => {
    const failed = terraformStateDriftRecords({ member: "app", observedAt: AT, declared: ["null_resource.first"], failed: { reason: "read-failed", detail: "init failed" } });
    expect(statusOf(failed)).toEqual({ "null_resource.first": "not-observed" });
    for (const r of [...records, ...failed]) {
      expect(r.read).toBe("state");
      expect(STATE_READ_STATUSES).toContain(r.status);
      expect(r.status).not.toBe("in-sync");
      expect(r.status).not.toBe("drifted");
    }
    roundTrip(failed);
  });
});

describe("a stock root's plan", () => {
  const records = terraformPlanDriftRecords({ member: "app", observedAt: AT, plan: read("show-plan.json") });

  test("drift rows decide, and a configuration change is not drift", () => {
    expect(statusOf(records)).toEqual({
      "shell_script.conf": "drifted",
      "terraform_data.downstream": "in-sync",
      "terraform_data.reader": "in-sync",
      "terraform_data.replaced": "in-sync",
      "terraform_data.updated": "in-sync",
    });
    const conf = at(records, "shell_script.conf");
    expect(conf.read).toBe("plan");
    expect(conf.evidence).toMatchObject({ tool: "terraform", version: "1.15.8" });
    expect(conf.attributes).toContainEqual({ path: "dirty", before: false, after: true });
    roundTrip(records);
  });

  test("a drift delete is missing, a create with no prior row pending, a dropped block undeclared", () => {
    const plan = {
      terraform_version: "1.9.0",
      prior_state: { values: { root_module: { resources: [{ address: "aws_s3_bucket.gone", mode: "managed", type: "aws_s3_bucket" }, { address: "aws_s3_bucket.dropped", mode: "managed", type: "aws_s3_bucket" }] } } },
      resource_drift: [{ address: "aws_s3_bucket.gone", type: "aws_s3_bucket", change: { actions: ["delete"], before: { bucket: "gone" }, after: null } }],
      resource_changes: [
        { address: "aws_s3_bucket.gone", mode: "managed", type: "aws_s3_bucket", change: { actions: ["create"], before: null, after: { bucket: "gone" } } },
        { address: "aws_s3_bucket.new", mode: "managed", type: "aws_s3_bucket", change: { actions: ["create"], before: null, after: { bucket: "new" } } },
        { address: "aws_s3_bucket.dropped", mode: "managed", type: "aws_s3_bucket", change: { actions: ["delete"], before: { bucket: "dropped" }, after: null } },
        { address: "data.aws_caller_identity.me", mode: "data", type: "aws_caller_identity", change: { actions: ["read"] } },
      ],
    };
    const out = terraformPlanDriftRecords({ member: "app", engine: "tofu", observedAt: AT, plan });
    expect(statusOf(out)).toEqual({ "aws_s3_bucket.dropped": "undeclared", "aws_s3_bucket.gone": "missing", "aws_s3_bucket.new": "pending" });
    expect(out.every((r) => r.engine === "tofu" && r.resourceType === "aws_s3_bucket")).toBe(true);
    roundTrip(out);
  });
});

describe("choudoufu live-plan", () => {
  const records = choudoufuLivePlanDriftRecords({ member: "estate", observedAt: AT, livePlan: read("live-plan.json") });

  test("maps bound, unowned, adoptable and omissions", () => {
    expect(statusOf(records)).toEqual({
      "aws_cloudwatch_log_group.adoptable": "unclaimed",
      "aws_cloudwatch_log_group.app": "in-sync",
      "aws_cloudwatch_log_group.held_elsewhere": "unclaimed",
      "aws_cloudwatch_log_group.never_applied": "pending",
      "aws_eip.pool[0]": "in-sync",
      "aws_eip.pool[1]": "in-sync",
      "aws_security_group.main": "in-sync",
      "aws_security_group_rule.https": "pending",
      "aws_subnet.app": "in-sync",
      "aws_vpc.adoptable": "unclaimed",
      "aws_vpc.main": "in-sync",
    });
    expect(records.every((r) => r.read === "ownership" && r.engine === "choudoufu")).toBe(true);
    expect(at(records, "aws_eip.pool[0]").ownership).toEqual({ verdict: "owned", by: "marker", markerOnObject: true });
    expect(at(records, "aws_cloudwatch_log_group.app").ownership).toEqual({ verdict: "owned", by: "derived", markerOnObject: false });
    expect(at(records, "aws_cloudwatch_log_group.adoptable").ownership).toMatchObject({ verdict: "adoptable", adopt: "aws_cloudwatch_log_group.adoptable" });
    expect(at(records, "aws_cloudwatch_log_group.held_elsewhere").ownership).toEqual({ verdict: "foreign", by: "marker", markerOnObject: true, ownedBy: "other-estate" });
    expect(at(records, "aws_cloudwatch_log_group.held_elsewhere").evidence.engineCode).toBe("UNOWNED");
    expect(at(records, "aws_vpc.adoptable").evidence.engineCode).toBe("NEEDS_DISCOVERY");
    expect(at(records, "aws_cloudwatch_log_group.never_applied").evidence.engineCode).toBe("ABSENT");
    expect(at(records, "aws_eip.pool[0]").evidence.version).toBe("v0.15.0");
    roundTrip(records);
  });

  test("foreign, controller_held, the new omission reasons and an UNOWNED with no row", () => {
    const out = choudoufuLivePlanDriftRecords({ member: "estate", observedAt: AT, livePlan: read("drift-record", "live-plan-sections.json") });
    expect(statusOf(out)).toEqual({
      "arn:aws:s3:::ack-made": "runtime",
      "arn:aws:s3:::someone-elses": "undeclared",
      "aws_cloudwatch_log_group.orphan_unowned": "not-observed",
      "aws_iam_role.app": "in-sync",
      "aws_instance.verified": "not-observed",
      "aws_lambda_function.fn": "not-observed",
      "aws_s3_bucket.records": "in-sync",
      "aws_sqs_queue.later": "not-observed",
      "https://sqs.us-east-1.amazonaws.com/000000000000/loose": "undeclared",
      "kubernetes_deployment.legacy": "runtime",
      "kubernetes_manifest.issuer": "not-observed",
    });
    const reason = (a: string) => [at(out, a).unobserved?.reason, at(out, a).evidence.engineCode];
    expect(reason("aws_cloudwatch_log_group.orphan_unowned")).toEqual(["read-failed", "UNOWNED"]);
    expect(reason("aws_instance.verified")).toEqual(["read-failed", "VERIFIED_NOT_IMPORTABLE"]);
    expect(reason("kubernetes_manifest.issuer")).toEqual(["filtered", "OUT_OF_SCOPE"]);
    expect(reason("aws_lambda_function.fn")).toEqual(["no-credentials", "FAILED"]);
    expect(reason("aws_sqs_queue.later")).toEqual(["read-failed", "SOMETHING_NEW"]);
    expect(at(out, "arn:aws:s3:::someone-elses").ownership).toEqual({ verdict: "foreign", by: "marker", markerOnObject: true, ownedBy: "other-estate" });
    expect(at(out, "https://sqs.us-east-1.amazonaws.com/000000000000/loose").ownership).toEqual({ verdict: "foreign", markerOnObject: false });
    expect(at(out, "kubernetes_deployment.legacy").ownership).toEqual({ verdict: "foreign", by: "label", ownedBy: "Helm release web" });
    expect(at(out, "aws_s3_bucket.records").ownership).toEqual({ verdict: "owned", by: "record", markerOnObject: false });
    roundTrip(out);
  });

  test("a graph places instances on their instance nodes", () => {
    const placed = choudoufuLivePlanDriftRecords({
      member: "estate",
      observedAt: AT,
      livePlan: read("live-plan.json"),
      graph: { member: null, at: null, ids: ["estate/aws_eip.pool", "estate/aws_vpc.main"] },
    });
    expect(at(placed, "aws_eip.pool[1]")).toMatchObject({ node: "estate/aws_eip.pool[1]", instanceOf: "estate/aws_eip.pool" });
    expect(at(placed, "aws_vpc.main").node).toBe("estate/aws_vpc.main");
    expect(at(placed, "aws_subnet.app").node).toBeNull();
    roundTrip(placed);
  });
});

describe("choudoufu live-ls", () => {
  test("an undeclared item is undeclared, and a gap live-plan answered is left out", () => {
    const alone = choudoufuLiveLsDriftRecords({ member: "estate", observedAt: AT, liveLs: read("live-ls.json") });
    expect(statusOf(alone)).toEqual({ "aws_s3_bucket.data": "undeclared", "aws_security_group_rule.https": "not-observed" });
    expect(at(alone, "aws_s3_bucket.data").ownership).toEqual({ verdict: "owned", by: "marker", markerOnObject: true });
    expect(at(alone, "aws_security_group_rule.https").evidence.engineCode).toBe("declaration-carried");
    roundTrip(alone);

    const both = choudoufuLiveDriftRecords({ member: "estate", observedAt: AT, livePlan: read("live-plan.json"), liveLs: read("live-ls.json") });
    expect(at(both, "aws_s3_bucket.data").status).toBe("undeclared");
    expect(at(both, "aws_security_group_rule.https").status).toBe("pending");
    roundTrip(both);
  });
});

describe("choudoufu live+plan", () => {
  test("a bound instance with a planned update is drifted, declared before and live after", () => {
    const records = choudoufuLivePlusPlanDriftRecords({
      member: "estate",
      observedAt: AT,
      livePlan: read("live-plan-depth", "live-plan.json"),
      plan: read("live-plan-depth", "show-plan.json"),
    });
    const app = at(records, "aws_cloudwatch_log_group.app");
    expect(app.read).toBe("plan");
    expect(app.status).toBe("drifted");
    expect(app.attributes).toContainEqual({ path: "retention_in_days", before: 1, after: 3 });
    expect(app.ownership).toEqual({ verdict: "owned", by: "derived", markerOnObject: false });
    const vpc = at(records, "aws_vpc.main");
    expect(vpc.status).toBe("drifted");
    expect(vpc.attributes).toContainEqual({ path: "tags.drifted", after: "yes" });
    expect(at(records, "aws_eip.pool[0]")).toMatchObject({ read: "plan", status: "in-sync" });
    // Not bound: the plan does not say who holds it, so live-plan's record stands.
    expect(at(records, "aws_cloudwatch_log_group.never_applied")).toMatchObject({ read: "ownership", status: "pending" });
    roundTrip(records);
  });

  test("a sensitive value never leaves, on either side", () => {
    const records = choudoufuLivePlusPlanDriftRecords({
      member: "estate",
      observedAt: AT,
      livePlan: read("live-plan-depth", "live-plan.json"),
      plan: read("live-plan-depth", "show-plan-sensitive.json"),
    });
    const vpc = at(records, "aws_vpc.main");
    expect(vpc.attributes).toContainEqual({ path: "tags.token", sensitive: true });
    const text = JSON.stringify(driftDocument(records));
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("hunter3");
    roundTrip(records);
  });
});
