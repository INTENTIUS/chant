/**
 * What a terraform or tofu plan's digest leaves out (plywood#56): the values
 * the plan says are known only after apply. A create of a resource with a
 * generated name (`name_prefix`, a random id, a computed output) has to give
 * the same digest in every plan of the same change.
 */
import { describe, expect, test } from "vitest";
import { terraformPlanDigest, withoutUnknown } from "./plan-digest";

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
