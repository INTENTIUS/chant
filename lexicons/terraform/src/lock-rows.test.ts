/**
 * #4552: a choudoufu root's rows keep terragucci's format (`planRows` in
 * terragucci's apply-rows.ts), and Terraform, tofu and Terragrunt keep the
 * target grain and refuse the resource grain by name.
 */
import { describe, expect, test } from "vitest";
import type { ChangeSetPart } from "@intentius/chant/change-set";
import { terraformDefaultLockGrain, terraformLockGrainRefusal, terraformLockRows, terraformLockRowsFromPart } from "./lock-rows";
import { terraformApplyCapability } from "./components/capability-plugin";

const plan = {
  resource_changes: [
    { address: "aws_s3_bucket.logs", mode: "managed", change: { actions: ["update"], before: { id: "logs-1" } } },
    { address: "aws_sqs_queue.jobs", mode: "managed", change: { actions: ["create"], before: null } },
    { address: "aws_iam_role.app", previous_address: "aws_iam_role.old", mode: "managed", change: { actions: ["no-op"], before: { id: "app" } } },
    { address: "aws_iam_role.svc", previous_address: "aws_iam_role.legacy", mode: "managed", change: { actions: ["delete", "create"], before: { id: "svc" } } },
    { address: "data.aws_caller_identity.me", mode: "data", change: { actions: ["read"] } },
  ],
};

describe("terraformLockRows", () => {
  test("estate rows, the previous address of a moved instance, and object rows for anything but a create", () => {
    expect(terraformLockRows("net", "e01", plan).map((r) => r.key)).toEqual([
      "estate e01 aws_iam_role.legacy",
      "estate e01 aws_iam_role.svc",
      "estate e01 aws_s3_bucket.logs",
      "estate e01 aws_sqs_queue.jobs",
      "object logs-1",
      "object svc",
    ]);
  });

  test("a root with no estate is keyed by its path", () => {
    expect(terraformLockRows("live/net", undefined, plan).map((r) => r.key)).toEqual([
      "object logs-1",
      "object svc",
      "root live/net aws_iam_role.legacy",
      "root live/net aws_iam_role.svc",
      "root live/net aws_s3_bucket.logs",
      "root live/net aws_sqs_queue.jobs",
    ]);
  });

  test("from a change-set part: the same keys less the previous address", () => {
    const part: ChangeSetPart = {
      member: { member: "net", lexicon: "terraform", planner: "choudoufu", scope: "e01", status: "planned", planDigest: "sha256:x", holes: [] },
      entries: [
        { member: "net", lexicon: "terraform", planner: "choudoufu", address: "aws_s3_bucket.logs", type: "aws_s3_bucket", id: "logs-1", action: "update", attributes: [] },
        { member: "net", lexicon: "terraform", planner: "choudoufu", address: "aws_sqs_queue.jobs", type: "aws_sqs_queue", action: "no-op", attributes: [] },
      ],
    };
    expect(terraformLockRowsFromPart("net", part).map((r) => r.key)).toEqual(["estate e01 aws_s3_bucket.logs", "object logs-1"]);
  });
});

describe("the grain", () => {
  test("resource under choudoufu, the root under Terraform and tofu", () => {
    expect(terraformDefaultLockGrain("choudoufu")).toBe("resource");
    expect(terraformDefaultLockGrain("terraform")).toBe("target");
    expect(terraformDefaultLockGrain("tofu")).toBe("target");
  });

  test("resource is refused by engine name off choudoufu; target and repo are not", () => {
    expect(terraformLockGrainRefusal("resource", "choudoufu")).toBeUndefined();
    expect(terraformLockGrainRefusal("resource", "terraform")).toMatch(/^Terraform keeps/);
    expect(terraformLockGrainRefusal("resource", "tofu")).toMatch(/^tofu keeps/);
    expect(terraformLockGrainRefusal("resource", "terraform", "/usr/local/bin/terragrunt")).toMatch(/^Terragrunt keeps/);
    expect(terraformLockGrainRefusal("target", "terraform")).toBeUndefined();
    expect(terraformLockGrainRefusal("repo", "tofu")).toBeUndefined();
  });
});

describe("the ledger lock (ruling for ci-products 2026-10-28)", () => {
  test("a root's target row is `root <root>`, which a Terraform, tofu or Terragrunt apply waits for", async () => {
    expect(await terraformApplyCapability.targetLockRow!({ root: "stacks/net" } as never)).toEqual({ key: "root stacks/net", target: "stacks/net", address: "stacks/net" });
    expect(await terraformApplyCapability.targetLockRow!({ root: "" } as never)).toBeUndefined();
  });
});
