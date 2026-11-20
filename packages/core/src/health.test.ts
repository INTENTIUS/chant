import { describe, expect, test } from "vitest";
import {
  healthApplicable,
  observeEngineHealth,
  observeHealthFor,
  summarizeHealth,
  totalHealth,
  type EngineHealthLexicon,
  type HealthLexicon,
  type HealthReadOptions,
} from "./health";

const entities = new Map([
  ["web", { entityType: "AWS::ECS::Service", props: {} }],
  ["check", { entityType: "AWS::Route53::HealthCheck", props: {} }],
]);

describe("health reads (#4177)", () => {
  test("healthApplicable keeps only the types the lexicon names", () => {
    const all = new Map([...entities, ["bucket", { entityType: "AWS::S3::Bucket", props: {} }]]);
    const picked = healthApplicable({ name: "aws", healthTypes: ["AWS::ECS::Service"] }, all);
    expect([...picked.keys()]).toEqual(["web"]);
  });

  test("a thrown reader is read-failed for every entity, never unhealthy", async () => {
    const plugin: HealthLexicon = {
      name: "aws",
      healthTypes: ["AWS::ECS::Service"],
      observeHealth: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    };
    const r = await observeHealthFor(plugin, { environment: "dev", buildOutput: "", entities });
    expect(r.entities).toEqual({});
    expect(r.unobserved.web).toEqual({ reason: "read-failed", type: "AWS::ECS::Service", detail: "connect ECONNREFUSED" });
    expect(Object.keys(r.unobserved)).toEqual(["web", "check"]);
  });

  test("a lexicon without a reader reports unsupported-kind", async () => {
    const r = await observeHealthFor({ name: "aws" }, { environment: "dev", buildOutput: "", entities });
    expect(r.unobserved.web?.reason).toBe("unsupported-kind");
  });

  test("the result is made total, and entities win over absent and unobserved", () => {
    const r = totalHealth(["web", "check", "gone", "forgot"], {
      entities: { web: { type: "AWS::ECS::Service", state: "healthy", detail: "1/1 running", observedAt: "t" } },
      unobserved: { web: { reason: "read-failed" }, check: { reason: "no-credentials" } },
      absent: ["gone", "web"],
    });
    expect(Object.keys(r.entities)).toEqual(["web"]);
    expect(r.absent).toEqual(["gone"]);
    expect(r.unobserved.check?.reason).toBe("no-credentials");
    expect(r.unobserved.forgot?.reason).toBe("read-failed");
    expect(r.unobserved.web).toBeUndefined();
  });

  test("summarizeHealth counts each place", () => {
    const s = summarizeHealth([
      {
        entities: {
          a: { type: "t", state: "healthy", detail: "", observedAt: "" },
          b: { type: "t", state: "unhealthy", detail: "", observedAt: "" },
          c: { type: "t", state: "unknown", detail: "", observedAt: "" },
        },
        unobserved: { d: { reason: "read-failed" } },
        absent: ["e", "f"],
      },
    ]);
    expect(s).toEqual({ healthy: 1, unhealthy: 1, unknown: 1, unobserved: 1, absent: 2 });
  });
});

describe("engine health through the provider lexicons (#5338)", () => {
  const declared = new Map([
    ["app/aws_ecs_service.api", { entityType: "Terraform::Resource", props: { type: "aws_ecs_service" } }],
    ["app/aws_route53_health_check.api", { entityType: "Terraform::Resource", props: { type: "aws_route53_health_check" } }],
    ["app/azurerm_container_app.web", { entityType: "Terraform::Resource", props: { type: "azurerm_container_app" } }],
    ["app/aws_ecs_service.gone", { entityType: "Terraform::Resource", props: { type: "aws_ecs_service" } }],
  ]);
  const engine: EngineHealthLexicon = {
    name: "terraform",
    healthTargets: async () => ({
      targets: {
        "app/aws_ecs_service.api": { lexicon: "aws", type: "AWS::ECS::Service", engineType: "aws_ecs_service", physicalId: "arn:svc" },
        "app/aws_route53_health_check.api": { lexicon: "aws", type: "AWS::Route53::HealthCheck", engineType: "aws_route53_health_check", physicalId: "hc-1" },
        "app/azurerm_container_app.web": { lexicon: "azure", type: "Microsoft.App/containerApps", engineType: "azurerm_container_app", physicalId: "/subscriptions/s/x" },
      },
      unobserved: {},
      absent: ["app/aws_ecs_service.gone"],
      uncovered: { "app/aws_s3_bucket.logs": "aws_s3_bucket" },
    }),
  };

  test("each target is read by its provider with the engine's id; a provider not installed leaves a hole", async () => {
    let seen: HealthReadOptions | undefined;
    const aws: HealthLexicon = {
      name: "aws",
      healthTypes: ["AWS::ECS::Service"],
      observeHealth: async (o) => {
        seen = o;
        return { entities: { "app/aws_ecs_service.api": { type: "AWS::ECS::Service", state: "healthy", detail: "2/2 running", observedAt: "t" } }, unobserved: {}, absent: [] };
      },
    };
    const { result, error } = await observeEngineHealth(
      engine,
      { environment: "dev", buildOutput: "x", entities: declared },
      async (l) => (l === "aws" ? aws : undefined),
      () => new Date("2026-11-19T00:00:00.000Z"),
    );
    expect(error).toBeUndefined();
    expect(seen?.physicalIds).toEqual({ "app/aws_ecs_service.api": "arn:svc" });
    expect([...seen!.entities]).toEqual([["app/aws_ecs_service.api", { entityType: "AWS::ECS::Service", props: {} }]]);
    expect(result.entities["app/aws_ecs_service.api"]?.state).toBe("healthy");
    expect(result.unobserved["app/aws_route53_health_check.api"]).toMatchObject({ reason: "unsupported-kind", detail: "the aws lexicon has no health read for AWS::Route53::HealthCheck" });
    expect(result.unobserved["app/azurerm_container_app.web"]).toMatchObject({ reason: "unsupported-kind", detail: "azurerm_container_app is read by the azure lexicon, which is not installed" });
    expect(result.absent).toEqual(["app/aws_ecs_service.gone"]);
    // A resource no provider reads is unknown, never left out: a soak must not pass on what nobody observed.
    expect(result.entities["app/aws_s3_bucket.logs"]).toEqual({
      type: "aws_s3_bucket",
      state: "unknown",
      detail: "no health read for aws_s3_bucket",
      observedAt: "2026-11-19T00:00:00.000Z",
    });
    expect(summarizeHealth([result])).toMatchObject({ healthy: 1, unknown: 1 });
  });

  test("a thrown healthTargets is an error with no entries", async () => {
    const broken: EngineHealthLexicon = { name: "pulumi", healthTargets: async () => { throw new Error("no export"); } };
    const r = await observeEngineHealth(broken, { environment: "dev", buildOutput: "", entities: declared }, async () => undefined);
    expect(r).toEqual({ result: { entities: {}, unobserved: {}, absent: [] }, error: "no export" });
  });
});
