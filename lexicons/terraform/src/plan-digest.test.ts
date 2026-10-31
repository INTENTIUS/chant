/**
 * What a terraform or tofu plan's digest leaves out (plywood#56): the values
 * the plan says are known only after apply. A create of a resource with a
 * generated name (`name_prefix`, a random id, a computed output) has to give
 * the same digest in every plan of the same change.
 */
import { describe, expect, test } from "vitest";
import { terraformPlanDigest, terraformResourceDigests, withoutUnknown } from "./plan-digest";

function plan(after: Record<string, unknown>, unknown: Record<string, unknown> = { id: true, name: true }) {
  return {
    format_version: "1.2",
    terraform_version: "1.9.0",
    timestamp: "2026-10-31T00:00:00Z",
    resource_changes: [
      { address: "aws_sqs_queue.worker", mode: "managed", type: "aws_sqs_queue", name: "worker", provider_name: "registry.opentofu.org/hashicorp/aws", change: { actions: ["create"], before: null, after, after_unknown: unknown } },
      { address: "random_id.suffix", mode: "managed", type: "random_id", name: "suffix", provider_name: "registry.opentofu.org/hashicorp/random", change: { actions: ["create"], before: null, after: { byte_length: 4, keepers: null }, after_unknown: { id: true, hex: true } } },
    ],
    output_changes: {},
  };
}

describe("a create's digest leaves out values known only after apply", () => {
  test("the same create planned twice has one digest, whatever stood in for the unknowns", () => {
    const first = plan({ visibility_timeout_seconds: 30, tags: { team: "a" } });
    const second = plan({ visibility_timeout_seconds: 30, tags: { team: "a" }, name: "worker-20261031120000", id: "placeholder-1" });
    const third = plan({ visibility_timeout_seconds: 30, tags: { team: "a" }, name: null, id: null });
    expect(terraformPlanDigest(second)).toBe(terraformPlanDigest(first));
    expect(terraformPlanDigest(third)).toBe(terraformPlanDigest(first));
  });

  test("a changed input a reviewer saw still changes it", () => {
    const base = plan({ visibility_timeout_seconds: 30 });
    expect(terraformPlanDigest(plan({ visibility_timeout_seconds: 60 }))).not.toBe(terraformPlanDigest(base));
    expect(terraformPlanDigest(plan({ visibility_timeout_seconds: 30, delay_seconds: 5 }))).not.toBe(terraformPlanDigest(base));
  });

  test("a value turning from known to unknown changes it", () => {
    const known = plan({ visibility_timeout_seconds: 30, name: "worker" }, { id: true });
    const unknown = plan({ visibility_timeout_seconds: 30 }, { id: true, name: true });
    expect(terraformPlanDigest(known)).not.toBe(terraformPlanDigest(unknown));
  });

  test("nested and listed unknowns are left out, known neighbours are kept", () => {
    expect(withoutUnknown({ a: { b: "x", c: "gen" }, l: ["p", "gen", "q"] }, { a: { c: true }, l: [false, true, false] })).toEqual({ a: { b: "x" }, l: ["p", null, "q"] });
    expect(withoutUnknown({ a: 1 }, {})).toEqual({ a: 1 });
    expect(withoutUnknown(null, { id: true })).toBeNull();
  });
});

describe("the digest of each changed resource (plywood#55)", () => {
  const two = (queueAfter: Record<string, unknown>, bucketActions: string[]) => ({
    resource_changes: [
      { address: "aws_sqs_queue.worker", type: "aws_sqs_queue", name: "worker", change: { actions: ["create"], before: null, after: queueAfter, after_unknown: { id: true, name: true } } },
      { address: "aws_s3_bucket.logs", type: "aws_s3_bucket", name: "logs", change: { actions: bucketActions, before: { acl: "private" }, after: { acl: bucketActions[0] === "update" ? "public-read" : "private" }, after_unknown: {} } },
    ],
    action_invocations: [{ address: "action.aws_lambda_invoke.warm", type: "aws_lambda_invoke" }],
  });

  test("a no-op is not in it, and an create of unknown values has one digest across plans", () => {
    const a = terraformResourceDigests(two({ delay_seconds: 0 }, ["no-op"]));
    const b = terraformResourceDigests(two({ delay_seconds: 0, name: "placeholder", id: "x" }, ["no-op"]));
    expect(Object.keys(a)).toEqual(["action:action.aws_lambda_invoke.warm", "aws_sqs_queue.worker"]);
    expect(b).toEqual(a);
  });

  test("a change to another resource leaves this one's digest as it was", () => {
    const quiet = terraformResourceDigests(two({ delay_seconds: 0 }, ["no-op"]));
    const busy = terraformResourceDigests(two({ delay_seconds: 0 }, ["update"]));
    expect(busy["aws_sqs_queue.worker"]).toBe(quiet["aws_sqs_queue.worker"]);
    expect(Object.keys(busy)).toContain("aws_s3_bucket.logs");
  });

  test("a reviewed input changes it", () => {
    const a = terraformResourceDigests(two({ delay_seconds: 0 }, ["no-op"]));
    const b = terraformResourceDigests(two({ delay_seconds: 9 }, ["no-op"]));
    expect(b["aws_sqs_queue.worker"]).not.toBe(a["aws_sqs_queue.worker"]);
  });

  test("a deposed object is kept apart from the live one", () => {
    const doc = {
      resource_changes: [
        { address: "aws_x.a", change: { actions: ["create"], before: null, after: {}, after_unknown: {} } },
        { address: "aws_x.a", deposed: "abc", change: { actions: ["delete"], before: {}, after: null, after_unknown: {} } },
      ],
    };
    expect(Object.keys(terraformResourceDigests(doc))).toEqual(["aws_x.a", "aws_x.a#deposed:abc"]);
  });
});
