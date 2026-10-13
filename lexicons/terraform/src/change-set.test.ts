/**
 * The terraform-family change-set adapters (#3181), against real plans.
 *
 * `__fixtures__/change-set/{terraform,tofu,choudoufu}.plan.json` are `show
 * -json` output from terraform 1.15.8, OpenTofu 1.12.5 and choudoufu 0.16.0:
 * `v1.tf.txt` applied, then `v2.tf.txt` (with `v2-module-app.tf.txt` as
 * `modules/app/main.tf`) planned. The plan has a no-op, an in-place update, an
 * update of a sensitive value, a delete-then-create replacement, a delete and
 * two creates under a module with `count`. `choudoufu-set-plan.json` is
 * choudoufu's own golden for `live-plan-set -json`
 * (`internal/live/setplan/testdata/document.golden.json` at choudoufu
 * 0dc53834d5): two planned roots and one that failed at init.
 *
 * The `*.golden.json` files are what the adapters produce. Regenerate them
 * with `UPDATE_GOLDEN=1`. `packages/core/src/change-set.test.ts` validates
 * them against the change-set schema.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composeChangeSet, type ChangeSetPart } from "@intentius/chant/change-set";
import { actionFor, choudoufuSetPlanParts, parseTerraformAddress, plannerForBinary, terraformChangeSetPart } from "./change-set";
import { terraformPlanDigest } from "./plan-digest";

const DIR = join(import.meta.dirname, "__fixtures__", "change-set");
const read = (name: string): unknown => JSON.parse(readFileSync(join(DIR, name), "utf-8"));

function golden(name: string, value: unknown): void {
  const path = join(DIR, name);
  const text = JSON.stringify(value, null, 2) + "\n";
  if (process.env.UPDATE_GOLDEN) writeFileSync(path, text);
  expect(text).toBe(readFileSync(path, "utf-8"));
}

describe("terraformChangeSetPart, on real plans", () => {
  test.each(["terraform", "tofu", "choudoufu"] as const)("%s show -json matches its golden part", (planner) => {
    const plan = read(`${planner}.plan.json`);
    const part = terraformChangeSetPart({ member: "estate", plan, planner });
    golden(`${planner}.part.golden.json`, part);
    expect(part.member.planDigest).toBe(terraformPlanDigest(plan));
  });

  test("the three binaries' plans project to the same entries", () => {
    const entries = (planner: "terraform" | "tofu" | "choudoufu") =>
      terraformChangeSetPart({ member: "estate", plan: read(`${planner}.plan.json`), planner }).entries.map((e) => ({ ...e, planner: undefined, attributes: e.attributes.map((a) => a.path) }));
    expect(entries("tofu")).toEqual(entries("terraform"));
    expect(entries("choudoufu")).toEqual(entries("terraform"));
  });

  test("actions, disruption, module and index, and a sensitive value left out", () => {
    const { entries } = terraformChangeSetPart({ member: "estate", plan: read("tofu.plan.json"), planner: "tofu" });
    const at = (address: string) => entries.find((e) => e.address === address)!;
    expect(at("terraform_data.keep")).toMatchObject({ action: "no-op", attributes: [] });
    expect(at("terraform_data.old")).toMatchObject({ action: "delete", disruption: "destroy" });
    expect(at("terraform_data.worker")).toMatchObject({ action: "replace", disruption: "destroy" });
    expect(at("terraform_data.worker").attributes.find((a) => a.path === "triggers_replace")).toEqual({
      path: "triggers_replace", before: ["build-1"], after: ["build-2"], forcesReplacement: true,
    });
    expect(at("terraform_data.config")).toMatchObject({ action: "update", disruption: "in-place" });
    expect(at("terraform_data.config").attributes.find((a) => a.path === "input")).toEqual({
      path: "input", before: { size: "small", tags: { team: "core" } }, after: { size: "large", tags: { team: "core" } },
    });
    const secret = at("terraform_data.secret").attributes.find((a) => a.path === "input")!;
    expect(secret).toEqual({ path: "input", sensitive: true });
    expect(JSON.stringify(secret)).not.toContain("s3cr3t");
    // Redaction follows the planner's marks. All three binaries leave
    // terraform_data's `output` unmarked in before_sensitive, so its old value
    // is carried, as it is in the plan JSON itself.
    expect(at("terraform_data.secret").attributes.find((a) => a.path === "output")).toEqual({ path: "output", before: "s3cr3t-1", unknown: true });
    expect(at("module.app.terraform_data.instance[1]")).toMatchObject({ action: "create", module: "module.app", name: "instance", index: 1 });
  });
});

describe("imports, forgets and triggered actions", () => {
  // terraform 1.15.8 show -json: a `removed` block with destroy = false (action
  // "forget"), an `import` block (change.importing, action "update") and a
  // create. The plan has no field named for a forget beyond its action.
  const plan = read("terraform.import-forget.plan.json") as { resource_changes: unknown[] };

  test("a forget keeps the action forget and an import is flagged beside its own action", () => {
    const { entries } = terraformChangeSetPart({ member: "root", plan });
    const at = (address: string) => entries.find((e) => e.address === address)!;
    expect(at("terraform_data.a")).toMatchObject({ action: "forget", attributes: [] });
    expect(at("terraform_data.a").importing).toBeUndefined();
    expect(at("terraform_data.b")).toMatchObject({ action: "update", importing: true });
    expect(at("terraform_data.c").importing).toBeUndefined();
  });

  test("action_invocations become side effects, and bind the plan digest only when present", () => {
    const invocation = { address: "action.aws_lambda_invoke.notify", type: "aws_lambda_invoke", lifecycle_action_trigger: { triggering_resource_address: "aws_lambda_function.worker", action_trigger_event: "after_update", actions_block_index: 0, action_trigger_block_index: 0 } };
    const withAction = { ...plan, action_invocations: [invocation] };
    const part = terraformChangeSetPart({ member: "root", plan: withAction });
    expect(part.sideEffects).toEqual([{ address: "action.aws_lambda_invoke.notify", type: "aws_lambda_invoke", trigger: "aws_lambda_function.worker", event: "after_update" }]);
    expect(terraformChangeSetPart({ member: "root", plan }).sideEffects).toBeUndefined();
    expect(terraformPlanDigest(withAction)).not.toBe(terraformPlanDigest(plan));
    expect(terraformPlanDigest({ ...plan, action_invocations: [] })).toBe(terraformPlanDigest(plan));
    expect(composeChangeSet([part]).sideEffects).toEqual([{ member: "root", ...part.sideEffects![0] }]);
  });
});

describe("choudoufuSetPlanParts, on choudoufu's golden set plan", () => {
  test("one part per root, the failed root a failed member, and the golden document", () => {
    const parts = choudoufuSetPlanParts({ document: read("choudoufu-set-plan.json") });
    expect(parts.map((p) => [p.member.member, p.member.status, p.member.scope])).toEqual([
      ["estates/e01", "planned", "est-e01"],
      ["estates/e02", "planned", "est-e02"],
      ["estates/e03", "failed", "est-e03"],
    ]);
    expect(parts[2].member).toMatchObject({ planDigest: null, error: "e03 broke at init on purpose" });
    // choudoufu's own root digest rides along; the member's plan digest is chant's.
    expect(parts[0].member.nativeDigest).toBe("sha256:bbe048fb0f7df99fcd65f00351d8b3c3be9b8a2a25a99a706b1c16d81277bb97");
    // The golden plan carries only address and actions, so type and name come off the address.
    expect(parts[0].entries[0]).toMatchObject({ address: "terraform_data.x", type: "terraform_data", name: "x", action: "create" });
    const doc = composeChangeSet(parts);
    expect(doc.summary.failed).toEqual(["estates/e03"]);
    golden("choudoufu-set-plan.change-set.golden.json", doc);
  });

  test("memberFor names the workspace member a root belongs to", () => {
    const parts: ChangeSetPart[] = choudoufuSetPlanParts({ document: read("choudoufu-set-plan.json"), memberFor: (root) => root.replace("estates/", "") });
    expect(parts.map((p) => p.member.member)).toEqual(["e01", "e02", "e03"]);
  });

  test("a document without roots is refused", () => {
    expect(() => choudoufuSetPlanParts({ document: { format_version: "1" } })).toThrow(/no top-level "roots"/);
  });
});

describe("address and action parsing", () => {
  test.each([
    ["aws_s3_bucket.logs", { type: "aws_s3_bucket", name: "logs" }],
    ["data.aws_iam_policy_document.p", { type: "aws_iam_policy_document", name: "p" }],
    ["module.net.module.sub[2].aws_subnet.a[0]", { module: "module.net.module.sub[2]", type: "aws_subnet", name: "a", index: 0 }],
    ['module.app["eu.west"].aws_instance.web["a.b"]', { module: 'module.app["eu.west"]', type: "aws_instance", name: "web", index: "a.b" }],
  ])("%s", (address, expected) => {
    expect(parseTerraformAddress(address)).toEqual(expected);
  });

  test("create-before-destroy is a replace with replace disruption, and an unknown action is refused", () => {
    const plan = { resource_changes: [{ address: "a.b", type: "a", name: "b", change: { actions: ["create", "delete"], before: {}, after: {} } }] };
    expect(terraformChangeSetPart({ member: "m", plan }).entries[0]).toMatchObject({ action: "replace", disruption: "replace" });
    expect(() => actionFor(["teleport"])).toThrow(/no action/);
  });

  test("the planner a binary names", () => {
    expect(plannerForBinary("/usr/local/bin/tofu")).toBe("tofu");
    expect(plannerForBinary("choudoufu")).toBe("choudoufu");
    expect(plannerForBinary(undefined)).toBe("terraform");
  });
});
