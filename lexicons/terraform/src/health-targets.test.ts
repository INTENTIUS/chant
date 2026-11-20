import { describe, expect, test } from "vitest";
import { observation } from "@intentius/chant/observation";
import { terraformHealthTargets, type TerraformIdRead } from "./health-targets";
import { RESOURCE_TYPE, VARIABLE_TYPE } from "./hcl/parse";
import { terraformPlugin } from "./plugin";

const resource = (type: string, address: string) => ({ entityType: RESOURCE_TYPE, props: { type, address, root: "app" } });

describe("terraform health targets (#5338)", () => {
  test("covered types map to their provider's health type with the id from state; other resources are uncovered", async () => {
    const asked: string[][] = [];
    const read: TerraformIdRead = async (o) => {
      asked.push(o.entityNames);
      expect(o.depth).toBe("state");
      return observation(
        {
          "app/aws_ecs_service.api": { type: RESOURCE_TYPE, status: "managed", physicalId: "arn:aws:ecs:us-east-1:0:service/main/api", attributes: { address: "aws_ecs_service.api" } },
          "app/aws_route53_health_check.api": { type: RESOURCE_TYPE, status: "managed", physicalId: "abc-123", attributes: { address: "aws_route53_health_check.api" } },
          "app/google_cloud_run_v2_service.web": {
            type: RESOURCE_TYPE,
            status: "managed",
            physicalId: "google_cloud_run_v2_service.web",
            attributes: { address: "google_cloud_run_v2_service.web" },
            instances: [
              { key: "[0]", address: "google_cloud_run_v2_service.web[0]", verdict: "present", physicalId: "projects/p/locations/us-central1/services/web-0" },
              { key: "[1]", address: "google_cloud_run_v2_service.web[1]", verdict: "absent" },
            ],
          },
          "app/azurerm_container_app.norow": { type: RESOURCE_TYPE, status: "managed", physicalId: "azurerm_container_app.norow", attributes: { address: "azurerm_container_app.norow" } },
        },
        { "app/aws_ecs_service.broken": { reason: "no-credentials", detail: "init failed" } },
      );
    };
    const r = await terraformHealthTargets(
      {
        environment: "dev",
        buildOutput: "",
        entities: new Map<string, { entityType: string; props: Record<string, unknown> }>([
          ["app/aws_ecs_service.api", resource("aws_ecs_service", "aws_ecs_service.api")],
          ["app/aws_route53_health_check.api", resource("aws_route53_health_check", "aws_route53_health_check.api")],
          ["app/google_cloud_run_v2_service.web", resource("google_cloud_run_v2_service", "google_cloud_run_v2_service.web")],
          ["app/azurerm_container_app.norow", resource("azurerm_container_app", "azurerm_container_app.norow")],
          ["app/aws_ecs_service.broken", resource("aws_ecs_service", "aws_ecs_service.broken")],
          ["app/aws_ecs_service.later", resource("aws_ecs_service", "aws_ecs_service.later")],
          ["app/aws_s3_bucket.logs", resource("aws_s3_bucket", "aws_s3_bucket.logs")],
          ["app/var.region", { entityType: VARIABLE_TYPE, props: { address: "var.region", root: "app" } }],
        ]),
      },
      read,
    );
    expect(asked[0]).not.toContain("app/aws_s3_bucket.logs");
    expect(r.targets).toEqual({
      "app/aws_ecs_service.api": { lexicon: "aws", type: "AWS::ECS::Service", engineType: "aws_ecs_service", physicalId: "arn:aws:ecs:us-east-1:0:service/main/api" },
      "app/aws_route53_health_check.api": { lexicon: "aws", type: "AWS::Route53::HealthCheck", engineType: "aws_route53_health_check", physicalId: "abc-123" },
      "app/google_cloud_run_v2_service.web[0]": {
        lexicon: "gcp",
        type: "GCP::Run::Service",
        engineType: "google_cloud_run_v2_service",
        physicalId: "projects/p/locations/us-central1/services/web-0",
      },
    });
    expect(r.absent.sort()).toEqual(["app/aws_ecs_service.later", "app/google_cloud_run_v2_service.web[1]"]);
    expect(r.unobserved["app/aws_ecs_service.broken"]).toMatchObject({ type: "AWS::ECS::Service", reason: "no-credentials" });
    expect(r.unobserved["app/azurerm_container_app.norow"]).toMatchObject({ reason: "read-failed" });
    // A resource no provider reads is uncovered, which core reports unknown; a variable is no resource.
    expect(r.uncovered).toEqual({ "app/aws_s3_bucket.logs": "aws_s3_bucket" });
  });

  test("a root with no covered type reads no state, and every resource is uncovered", async () => {
    const read: TerraformIdRead = async () => {
      throw new Error("not called");
    };
    const r = await terraformHealthTargets({ environment: "dev", buildOutput: "", entities: new Map([["app/aws_s3_bucket.logs", resource("aws_s3_bucket", "aws_s3_bucket.logs")]]) }, read);
    expect(r).toEqual({ targets: {}, unobserved: {}, absent: [], uncovered: { "app/aws_s3_bucket.logs": "aws_s3_bucket" } });
  });

  test("the plugin answers health targets and classifies disruption", () => {
    expect(typeof terraformPlugin.healthTargets).toBe("function");
    expect(typeof terraformPlugin.classifyDisruption).toBe("function");
  });
});
