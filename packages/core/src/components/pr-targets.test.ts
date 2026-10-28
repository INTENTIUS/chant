/**
 * `pr-plan --target` (#4620): a bare address narrows every planned member,
 * `<member>:<address>` one member, and a member the pull request does not
 * plan is refused.
 */

import { describe, expect, test } from "vitest";
import { prPlanTargets } from "./pr-targets";

const KNOWN = new Set(["net", "app", "db"]);

describe("prPlanTargets", () => {
  test("a bare address narrows every member the pull request plans", () => {
    expect(prPlanTargets(["aws_s3_bucket.logs"], ["net", "app"], KNOWN)).toEqual({ targets: { app: ["aws_s3_bucket.logs"], net: ["aws_s3_bucket.logs"] } });
  });

  test("a member's name before the first colon narrows that member alone", () => {
    expect(prPlanTargets(["net:module.vpc", "net:aws_route.a", "net:module.vpc"], ["net", "app"], KNOWN)).toEqual({ targets: { net: ["aws_route.a", "module.vpc"] } });
  });

  test("a Pulumi URN is a bare address, since urn names no member", () => {
    const urn = "urn:pulumi:prod::app::aws:s3/bucket:Bucket::logs";
    expect(prPlanTargets([urn], ["app"], KNOWN)).toEqual({ targets: { app: [urn] } });
  });

  test("a member the pull request does not plan is refused by name", () => {
    const got = prPlanTargets(["db:aws_db_instance.main"], ["net", "app"], KNOWN);
    expect(got).toEqual({ error: expect.stringContaining("does not plan db") });
  });

  test("an empty address is refused, and nothing planned narrows nothing", () => {
    expect(prPlanTargets(["net:"], ["net"], KNOWN)).toEqual({ error: expect.stringContaining("name an address after net:") });
    expect(prPlanTargets(["aws_s3_bucket.logs"], [], KNOWN)).toEqual({ targets: {} });
  });
});
