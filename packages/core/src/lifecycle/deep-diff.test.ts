import { describe, test, expect } from "vitest";
import { countPropertyDrift, diffDeep } from "./deep-diff";
import { UNRESOLVED, type NormalizedDeepObservation } from "../deep-observation";
import type { BaselineLexicon } from "./observation-baseline";

const live = (
  resources: Record<string, { type: string; properties: Record<string, unknown> }>,
  unobserved: NormalizedDeepObservation["unobserved"] = {},
): NormalizedDeepObservation => ({ resources, unobserved });

describe("diffDeep", () => {
  test("identical trees are unchanged", () => {
    const result = diffDeep({
      declared: { b: { type: "AWS::S3::Bucket", properties: { BucketName: "x" } } },
      live: live({ b: { type: "AWS::S3::Bucket", properties: { BucketName: "x" } } }),
    });
    expect(result.unchanged).toEqual(["b"]);
    expect(result.drifted).toEqual([]);
  });

  test("a changed property reports declared and live", () => {
    const result = diffDeep({
      declared: { b: { type: "AWS::S3::Bucket", properties: { Versioning: { Status: "Enabled" } } } },
      live: live({ b: { type: "AWS::S3::Bucket", properties: { Versioning: { Status: "Suspended" } } } }),
    });
    expect(result.drifted).toEqual([
      {
        name: "b",
        type: "AWS::S3::Bucket",
        changes: [{ path: "Versioning.Status", kind: "changed", declared: "Enabled", live: "Suspended" }],
      },
    ]);
    expect(countPropertyDrift(result)).toBe(1);
  });

  test("a property only the cloud has is undeclared drift", () => {
    const result = diffDeep({
      declared: { b: { type: "T", properties: {} } },
      live: live({ b: { type: "T", properties: { LoggingConfiguration: { TargetBucket: "logs" } } } }),
    });
    expect(result.drifted[0].changes).toEqual([
      { path: "LoggingConfiguration.TargetBucket", kind: "undeclared", live: "logs" },
    ]);
  });

  test("a declared property the cloud does not carry is absent", () => {
    const result = diffDeep({
      declared: { b: { type: "T", properties: { A: 1 } } },
      live: live({ b: { type: "T", properties: {} } }),
    });
    expect(result.drifted[0].changes).toEqual([{ path: "A", kind: "absent", declared: 1 }]);
  });

  test("an unevaluated intrinsic on the declared side is never drift", () => {
    const result = diffDeep({
      declared: { b: { type: "T", properties: { BucketName: UNRESOLVED, Other: "x" } } },
      live: live({ b: { type: "T", properties: { BucketName: "prod-data", Other: "x" } } }),
    });
    expect(result.drifted).toEqual([]);
    expect(result.unchanged).toEqual(["b"]);
  });

  test("an entity the deep read could not look at is a hole, not drift", () => {
    const result = diffDeep({
      declared: { b: { type: "T", properties: { A: 1 } } },
      live: live({}, { b: { type: "T", reason: "unsupported-kind", detail: "no reader" } }),
    });
    expect(result.drifted).toEqual([]);
    expect(result.unobserved).toEqual([
      { name: "b", type: "T", reason: "unsupported-kind", detail: "no reader" },
    ]);
  });

  test("present beats not-observed", () => {
    const result = diffDeep({
      declared: { b: { type: "T", properties: { A: 1 } } },
      live: live({ b: { type: "T", properties: { A: 1 } } }, { b: { reason: "read-failed" } }),
    });
    expect(result.unobserved).toEqual([]);
  });

  test("an entity absent from the deep read reports no property drift at all", () => {
    // The thin diff already calls this `missing`; restating every declared
    // property as `absent` would bury that one line.
    const result = diffDeep({
      declared: { b: { type: "T", properties: { A: 1, B: 2 } } },
      live: live({}),
    });
    expect(result.drifted).toEqual([]);
    expect(result.unchanged).toEqual([]);
  });

  test("a live entity nobody declared is reported separately", () => {
    const result = diffDeep({
      declared: {},
      live: live({ ghost: { type: "T", properties: { A: 1 } } }),
    });
    expect(result.undeclaredEntities).toEqual(["ghost"]);
    expect(result.drifted).toEqual([]);
  });
});

describe("diffDeep with an accepted baseline", () => {
  const baseline: BaselineLexicon = {
    b: {
      type: "AWS::S3::Bucket",
      accepted: [{ path: "Tags[0].Value", value: "platform", note: "set by the platform team" }],
    },
  };

  test("an accepted deviation is not drift", () => {
    const result = diffDeep({
      declared: { b: { type: "AWS::S3::Bucket", properties: {} } },
      live: live({ b: { type: "AWS::S3::Bucket", properties: { Tags: [{ Value: "platform" }] } } }),
      baseline,
    });
    expect(result.drifted).toEqual([]);
    expect(result.accepted[0].changes[0]).toEqual({
      path: "Tags[0].Value",
      kind: "undeclared",
      live: "platform",
      baseline: "platform",
    });
  });

  test("a value that moved away from the accepted one is drift again, and shows all three axes", () => {
    const result = diffDeep({
      declared: { b: { type: "AWS::S3::Bucket", properties: {} } },
      live: live({ b: { type: "AWS::S3::Bucket", properties: { Tags: [{ Value: "someone-else" }] } } }),
      baseline,
    });
    expect(result.drifted[0].changes[0]).toEqual({
      path: "Tags[0].Value",
      kind: "undeclared",
      live: "someone-else",
      baseline: "platform",
    });
  });

  test("an entity with only accepted deviations is not counted as unchanged", () => {
    const result = diffDeep({
      declared: { b: { type: "AWS::S3::Bucket", properties: {} } },
      live: live({ b: { type: "AWS::S3::Bucket", properties: { Tags: [{ Value: "platform" }] } } }),
      baseline,
    });
    expect(result.unchanged).toEqual([]);
  });

  test("the baseline never suppresses a different path", () => {
    const result = diffDeep({
      declared: { b: { type: "AWS::S3::Bucket", properties: {} } },
      live: live({ b: { type: "AWS::S3::Bucket", properties: { Tags: [{ Value: "platform" }], Extra: 1 } } }),
      baseline,
    });
    expect(result.drifted[0].changes.map((c) => c.path)).toEqual(["Extra"]);
  });
});

// #1189 — `kind` says a path is undeclared or changed; `owner` says who did it.
// The two are independent: `hpa-controller` owning `spec.replicas` and somebody
// running `kubectl edit` are the same kind and opposite situations.
describe("diffDeep — owning field manager (#1189)", () => {
  const declared = { web: { type: "K8s::Apps::Deployment", properties: { spec: { replicas: 2 } } } };

  test("names the manager on a drifted path", () => {
    const result = diffDeep({
      declared,
      live: live({
        web: {
          type: "K8s::Apps::Deployment",
          properties: { spec: { replicas: 5 } },
          fieldOwners: { "spec.replicas": "hpa-controller" },
        },
      }),
    });
    expect(result.drifted[0].changes[0]).toMatchObject({
      path: "spec.replicas",
      kind: "changed",
      owner: "hpa-controller",
    });
  });

  test("is absent when the substrate records no per-field ownership", () => {
    // Every substrate but k8s. The field must not appear at all rather than
    // appear empty — a consumer branches on its presence.
    const result = diffDeep({
      declared,
      live: live({ web: { type: "K8s::Apps::Deployment", properties: { spec: { replicas: 5 } } } }),
    });
    expect(result.drifted[0].changes[0]).not.toHaveProperty("owner");
  });

  test("is absent for a path with no live value — nobody owns a field that is not there", () => {
    const result = diffDeep({
      declared,
      live: live({
        web: { type: "K8s::Apps::Deployment", properties: {}, fieldOwners: { "spec.replicas": "someone" } },
      }),
    });
    const change = result.drifted[0].changes.find((c) => c.path === "spec.replicas")!;
    expect(change.kind).toBe("absent");
    expect(change).not.toHaveProperty("owner");
  });
});
