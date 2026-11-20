import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { exportIds, pulumiHealthTargets } from "./health-targets";
import { pulumiPlugin } from "./plugin";

const doc = {
  deployment: {
    resources: [
      { urn: "urn:pulumi:dev::app::pulumi:pulumi:Stack::app-dev", type: "pulumi:pulumi:Stack" },
      { urn: "urn:pulumi:dev::app::aws:ecs/service:Service::api", type: "aws:ecs/service:Service", id: "arn:aws:ecs:us-east-1:0:service/main/api" },
      { urn: "urn:pulumi:dev::app::aws:route53/healthCheck:HealthCheck::api", type: "aws:route53/healthCheck:HealthCheck", id: "abc-123" },
      { urn: "urn:pulumi:dev::app::gcp:cloudrunv2/service:Service::web", type: "gcp:cloudrunv2/service:Service", id: "projects/p/locations/us-central1/services/web" },
      { urn: "urn:pulumi:dev::app::aws:s3/bucket:Bucket::logs", type: "aws:s3/bucket:Bucket", id: "logs" },
    ],
  },
};

describe("pulumi health targets (#5338)", () => {
  test("covered types map to their provider's health type with the id from the export", async () => {
    const entities = new Map([
      ["app/aws:ecs/service:Service::api", { entityType: "aws:ecs/service:Service", props: {} }],
      ["app/aws:route53/healthCheck:HealthCheck::api", { entityType: "aws:route53/healthCheck:HealthCheck", props: {} }],
      ["app/gcp:cloudrunv2/service:Service::web", { entityType: "gcp:cloudrunv2/service:Service", props: {} }],
      ["app/aws:ecs/service:Service::gone", { entityType: "aws:ecs/service:Service", props: {} }],
      ["app/aws:s3/bucket:Bucket::logs", { entityType: "aws:s3/bucket:Bucket", props: {} }],
    ]);
    const r = await pulumiHealthTargets({ environment: "dev", buildOutput: "", entities }, { dir: "/x", label: "app", doc });
    expect(r.targets).toEqual({
      "app/aws:ecs/service:Service::api": { lexicon: "aws", type: "AWS::ECS::Service", engineType: "aws:ecs/service:Service", physicalId: "arn:aws:ecs:us-east-1:0:service/main/api" },
      "app/aws:route53/healthCheck:HealthCheck::api": { lexicon: "aws", type: "AWS::Route53::HealthCheck", engineType: "aws:route53/healthCheck:HealthCheck", physicalId: "abc-123" },
      "app/gcp:cloudrunv2/service:Service::web": {
        lexicon: "gcp",
        type: "GCP::Run::Service",
        engineType: "gcp:cloudrunv2/service:Service",
        physicalId: "projects/p/locations/us-central1/services/web",
      },
    });
    expect(r.absent).toEqual(["app/aws:ecs/service:Service::gone"]);
    expect(r.unobserved).toEqual({});
    expect(r.uncovered).toEqual({ "app/aws:s3/bucket:Bucket::logs": "aws:s3/bucket:Bucket" });
  });

  test("with no export read, a covered resource is a hole and the rest are uncovered", async () => {
    const entities = new Map([
      ["app/aws:ecs/service:Service::api", { entityType: "aws:ecs/service:Service", props: {} }],
      ["app/aws:s3/bucket:Bucket::logs", { entityType: "aws:s3/bucket:Bucket", props: {} }],
    ]);
    const r = await pulumiHealthTargets({ environment: "dev", buildOutput: "", entities }, undefined);
    expect(Object.keys(r.unobserved)).toEqual(["app/aws:ecs/service:Service::api"]);
    expect(r.unobserved["app/aws:ecs/service:Service::api"]).toMatchObject({ type: "AWS::ECS::Service", reason: "no-binding" });
    expect(r.uncovered).toEqual({ "app/aws:s3/bucket:Bucket::logs": "aws:s3/bucket:Bucket" });
  });

  test("ids key like the member read's entities, on a recorded export", () => {
    const recorded = JSON.parse(readFileSync(join(__dirname, "testdata/pulumi-preview/stack-export.json"), "utf-8"));
    const ids = exportIds({ label: "corpus", doc: recorded });
    expect(ids.get("corpus/aws:sns/topic:Topic::alerts-west")).toBe("arn:aws:sns:us-west-2:000000000000:rec-ts-alerts-west");
  });

  test("the plugin answers health targets and classifies disruption", () => {
    expect(typeof pulumiPlugin.healthTargets).toBe("function");
    expect(typeof pulumiPlugin.classifyDisruption).toBe("function");
  });
});
