import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { annotateDisruption } from "@intentius/chant/lifecycle/disruption";
import type { ChangeSet } from "@intentius/chant/lifecycle/change-set";
import { observePreview } from "./preview-observation";
import { classifyPulumiDisruption, pulumiDisruptionQueries } from "./disruption";
import { pulumiPlugin } from "./plugin";

const fixture = (path: string) => JSON.parse(readFileSync(join(__dirname, "testdata", path), "utf-8"));

const URN = "urn:pulumi:floci::corpus-aws-ts::";

describe("pulumi disruption from a preview's steps (#5338)", () => {
  test("a recorded preview classifies each update, replace and delete through the contract", async () => {
    const changes = pulumiDisruptionQueries(fixture("pulumi-preview/preview.json"));
    expect(changes.map((c) => c.name).sort()).toEqual(
      [
        "aws:ec2/securityGroup:SecurityGroup::app-sg",
        "aws:ec2/vpc:Vpc::main",
        "aws:sqs/queue:Queue::events",
        "aws:sqs/queue:Queue::worker-2",
        "aws:ssm/parameter:Parameter::db-password",
        "aws:ssm/parameter:Parameter::vpc-id",
      ].map((t) => URN + t),
    );
    const verdicts = await pulumiPlugin.classifyDisruption!({ environment: "floci", changes });
    expect(verdicts[`${URN}aws:sqs/queue:Queue::events`]).toEqual({ disruption: "in-place", detail: "the preview updates it in place" });
    expect(verdicts[`${URN}aws:ec2/vpc:Vpc::main`]).toMatchObject({ disruption: "replace", because: ["cidrBlock"] });
    expect(verdicts[`${URN}aws:ec2/securityGroup:SecurityGroup::app-sg`]).toMatchObject({ disruption: "replace", because: ["vpcId"] });
    expect(verdicts[`${URN}aws:sqs/queue:Queue::worker-2`]).toMatchObject({ disruption: "destroy" });
  });

  test("a delete before its replacement is destroy; a delete after is replace; a create is not asked", () => {
    const changes = pulumiDisruptionQueries(fixture("disruption/preview-delete-first.json"));
    expect(changes.map((c) => c.name)).toEqual([
      "urn:pulumi:dev::app::aws:rds/instance:Instance::db",
      "urn:pulumi:dev::app::aws:lb/targetGroup:TargetGroup::api",
    ]);
    expect(changes[0]!.type).toBe("aws:rds/instance:Instance");
    const verdicts = classifyPulumiDisruption({ environment: "dev", changes });
    expect(verdicts["urn:pulumi:dev::app::aws:rds/instance:Instance::db"]).toMatchObject({ disruption: "destroy", because: ["engine"] });
    expect(verdicts["urn:pulumi:dev::app::aws:lb/targetGroup:TargetGroup::api"]).toMatchObject({ disruption: "replace", because: ["port"] });
  });

  test("a query with no steps gets no verdict, which core reads as unknown", () => {
    expect(classifyPulumiDisruption({ environment: "dev", changes: [{ name: "x", deltas: [] }] })).toEqual({});
  });

  test("lifecycle plan's annotation reads a preview-depth node's plan attributes, and a node with none stays unknown", async () => {
    const observed = observePreview({ label: "app", preview: fixture("pulumi-preview/preview.json"), declared: new Map() })!.resources;
    const name = (t: string) => `app/${Object.keys(observed).find((k) => k.endsWith(t))!.replace(/^app\//, "")}`;
    const names = { inPlace: name("Queue::events"), replace: name("Vpc::main"), destroy: name("Queue::worker-2") };
    const cs = {
      env: "floci",
      entries: [
        ...Object.values(names).map((n) => ({ name: n, action: "update", lexicon: "pulumi", deltas: [{ path: "attributes.planAction", oldValue: null, newValue: "x" }] })),
        { name: "app/bare", action: "update", lexicon: "pulumi", deltas: [{ path: "attributes.tags", oldValue: "a", newValue: "b" }] },
      ],
    } as unknown as ChangeSet;
    const out = await annotateDisruption(cs, "floci", (o) => pulumiPlugin.classifyDisruption!(o), { ...observed, "app/bare": { attributes: { urn: "u" } } } as never);
    const by = Object.fromEntries(out.entries.map((e) => [e.name, e]));
    expect(by[names.inPlace]).toMatchObject({ disruption: "in-place" });
    expect(by[names.replace]).toMatchObject({ disruption: "replace", disruptionBecause: ["cidrBlock"] });
    expect(by[names.destroy]).toMatchObject({ disruption: "destroy" });
    expect(by["app/bare"]).toMatchObject({ disruption: "unknown" });
  });

  test("planActions order tells a delete-before-replace from a create-before-replace", () => {
    const q = (ops: string[]) => ({ name: "u", deltas: [], attributes: { planActions: { u: ops }, planReplacePaths: ["engine"] } });
    const v = classifyPulumiDisruption({
      environment: "dev",
      changes: [{ ...q(["delete-replaced", "create-replacement", "replace"]), name: "a" }, { ...q(["create-replacement", "replace", "delete-replaced"]), name: "b" }, { ...q(["update"]), name: "c" }, { ...q(["create"]), name: "d" }],
    });
    expect(v.a).toMatchObject({ disruption: "destroy", because: ["engine"] });
    expect(v.b).toMatchObject({ disruption: "replace", because: ["engine"] });
    expect(v.c).toEqual({ disruption: "in-place", detail: "the preview updates it in place" });
    expect(v.d).toBeUndefined();
  });

  test("previewSteps answers are kept when a query carries both shapes", () => {
    const [query] = pulumiDisruptionQueries(fixture("pulumi-preview/preview.json")).filter((c) => c.name.endsWith("Vpc::main"));
    const v = classifyPulumiDisruption({ environment: "dev", changes: [{ ...query!, attributes: { ...query!.attributes, planActions: { x: ["update"] } } }] });
    expect(Object.values(v)[0]).toMatchObject({ disruption: "replace" });
  });
});
