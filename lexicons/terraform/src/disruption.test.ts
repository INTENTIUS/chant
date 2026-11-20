import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { annotateDisruption } from "@intentius/chant/lifecycle/disruption";
import type { ChangeSet } from "@intentius/chant/lifecycle/change-set";
import { classifyTerraformDisruption, terraformActionsDisruption, terraformDisruptionQueries } from "./disruption";
import { terraformChangeSetPart } from "./change-set";
import { indexPlan, planAttributesFor } from "./plan-observation";
import { terraformPlugin } from "./plugin";

const plan = JSON.parse(readFileSync(join(__dirname, "__fixtures__/disruption/plan.json"), "utf-8"));

describe("terraform disruption from plan JSON (#5338)", () => {
  test("each action list maps to its class", () => {
    expect(terraformActionsDisruption(["update"])).toBe("in-place");
    expect(terraformActionsDisruption(["create", "delete"])).toBe("replace");
    expect(terraformActionsDisruption(["delete", "create"])).toBe("destroy");
    expect(terraformActionsDisruption(["delete"])).toBe("destroy");
    expect(terraformActionsDisruption(["create"])).toBeUndefined();
    expect(terraformActionsDisruption(["no-op"])).toBeUndefined();
    expect(terraformActionsDisruption(["read"])).toBeUndefined();
  });

  test("a plan's resource changes classify per resource through the contract", async () => {
    const changes = terraformDisruptionQueries(plan);
    expect(changes.map((c) => c.name)).toEqual([
      "aws_ecs_service.api",
      "aws_lb_target_group.api",
      "aws_db_instance.main",
      "aws_s3_bucket.old",
      "aws_eip.pool[0]",
      "aws_eip.pool[1]",
    ]);
    const verdicts = await terraformPlugin.classifyDisruption!({ environment: "dev", changes });
    expect(verdicts["aws_ecs_service.api"]).toEqual({ disruption: "in-place", detail: "the plan updates it in place" });
    expect(verdicts["aws_lb_target_group.api"]).toMatchObject({ disruption: "replace", because: ["port"] });
    expect(verdicts["aws_db_instance.main"]).toMatchObject({ disruption: "destroy", because: ["engine"] });
    expect(verdicts["aws_s3_bucket.old"]).toMatchObject({ disruption: "destroy" });
    expect(verdicts["aws_eip.pool[1]"]).toMatchObject({ disruption: "destroy", because: ["domain"] });
  });

  test("a block read at the plan depth takes its worst instance's class", () => {
    const attributes = planAttributesFor("aws_eip.pool", indexPlan(plan));
    const verdicts = classifyTerraformDisruption({ environment: "dev", changes: [{ name: "app/aws_eip.pool", deltas: [], attributes }] });
    expect(verdicts["app/aws_eip.pool"]).toMatchObject({ disruption: "destroy", because: ["domain"] });
  });

  test("lifecycle plan's annotation reads the observed plan attributes, and a read with no plan stays unknown", async () => {
    const cs: ChangeSet = {
      env: "dev",
      entries: [
        { name: "app/aws_lb_target_group.api", action: "update", lexicon: "terraform", deltas: [{ path: "attributes.planChanges", oldValue: [], newValue: [{ path: "port" }] }] },
        { name: "app/aws_iam_role.same", action: "update", lexicon: "terraform", deltas: [{ path: "attributes.provider", oldValue: "a", newValue: "b" }] },
      ],
    } as unknown as ChangeSet;
    const index = indexPlan(plan);
    const observed = {
      "app/aws_lb_target_group.api": { attributes: planAttributesFor("aws_lb_target_group.api", index) },
      "app/aws_iam_role.same": { attributes: { address: "aws_iam_role.same" } },
    };
    const out = await annotateDisruption(cs, "dev", (o) => terraformPlugin.classifyDisruption!(o), observed);
    expect(out.entries[0]).toMatchObject({ disruption: "replace", disruptionBecause: ["port"] });
    expect(out.entries[1]).toMatchObject({ disruption: "unknown" });
  });

  test("the change set adapter reads the same table", () => {
    const part = terraformChangeSetPart({ member: "app", plan });
    const by = Object.fromEntries(part.entries.map((e) => [e.address, e.disruption]));
    expect(by).toMatchObject({
      "aws_ecs_service.api": "in-place",
      "aws_lb_target_group.api": "replace",
      "aws_db_instance.main": "destroy",
      "aws_s3_bucket.old": "destroy",
    });
    expect(by["aws_sqs_queue.new"]).toBeUndefined();
  });
});
