import { describe, expect, test } from "vitest";
import { healthApplicable, observeHealthFor, summarizeHealth, totalHealth, type HealthLexicon } from "./health";

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
