import { describe, test, expect } from "vitest";
import { countHeld, countHeldFields, countPropertyDrift, diffDeep, suspiciousHeld, type DeclaredDeepEntity } from "./deep-diff";
import { UNRESOLVED, type NormalizedDeepObservation } from "../deep-observation";
import { HELD_ELSEWHERE_TAG } from "../held-elsewhere";
import type { BaselineLexicon } from "./observation-baseline";

/** A declared property's normalized held-elsewhere form, as `deep-observation.ts` produces it (#2162). Tests build this directly, same as they build every other already-normalized declared value in this file. */
const held = (by: string, reason: string) => ({ heldElsewhere: HELD_ELSEWHERE_TAG, by, reason });

const live = (
  resources: Record<string, { type: string; properties: Record<string, unknown>; fieldOwners?: Record<string, string> }>,
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

  test("a property only the cloud has is held elsewhere, not drift", () => {
    const result = diffDeep({
      declared: { b: { type: "T", properties: {} } },
      live: live({ b: { type: "T", properties: { LoggingConfiguration: { TargetBucket: "logs" } } } }),
    });
    expect(result.drifted).toEqual([]);
    expect(countPropertyDrift(result)).toBe(0);
    expect(result.heldElsewhere).toEqual([
      {
        name: "b",
        type: "T",
        fields: [
          { path: "LoggingConfiguration.TargetBucket", live: "logs", source: "claimed-fields" },
        ],
      },
    ]);
    // Every property chant declared matches, so the entity is clean: a field
    // somebody else set must not keep an entity reported forever.
    expect(result.unchanged).toEqual(["b"]);
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
  // A path source DOES declare — since #2160 the baseline only ever has drift
  // to suppress, because a path source never declared is held elsewhere and was
  // never reported in the first place.
  const declared = { b: { type: "AWS::S3::Bucket", properties: { Tags: [{ Value: "ours" }] } } };

  test("an accepted deviation is not drift", () => {
    const result = diffDeep({
      declared,
      live: live({ b: { type: "AWS::S3::Bucket", properties: { Tags: [{ Value: "platform" }] } } }),
      baseline,
    });
    expect(result.drifted).toEqual([]);
    expect(result.accepted[0].changes[0]).toEqual({
      path: "Tags[0].Value",
      kind: "changed",
      declared: "ours",
      live: "platform",
      baseline: "platform",
    });
  });

  test("a value that moved away from the accepted one is drift again, and shows all three axes", () => {
    const result = diffDeep({
      declared,
      live: live({ b: { type: "AWS::S3::Bucket", properties: { Tags: [{ Value: "someone-else" }] } } }),
      baseline,
    });
    expect(result.drifted[0].changes[0]).toEqual({
      path: "Tags[0].Value",
      kind: "changed",
      declared: "ours",
      live: "someone-else",
      baseline: "platform",
    });
  });

  test("an entity with only accepted deviations is not counted as unchanged", () => {
    const result = diffDeep({
      declared,
      live: live({ b: { type: "AWS::S3::Bucket", properties: { Tags: [{ Value: "platform" }] } } }),
      baseline,
    });
    expect(result.unchanged).toEqual([]);
  });

  test("the baseline never suppresses a different path", () => {
    const result = diffDeep({
      declared: { b: { type: "AWS::S3::Bucket", properties: { Tags: [{ Value: "ours" }], Extra: 0 } } },
      live: live({ b: { type: "AWS::S3::Bucket", properties: { Tags: [{ Value: "platform" }], Extra: 1 } } }),
      baseline,
    });
    expect(result.drifted[0].changes.map((c) => c.path)).toEqual(["Extra"]);
  });

  test("a held field carries its accepted value but never needed one", () => {
    // A baseline recorded before #2160 still names undeclared paths. The value
    // rides along for continuity; the field is quiet either way.
    const result = diffDeep({
      declared: { b: { type: "AWS::S3::Bucket", properties: {} } },
      live: live({ b: { type: "AWS::S3::Bucket", properties: { Tags: [{ Value: "platform" }] } } }),
      baseline,
    });
    expect(result.drifted).toEqual([]);
    expect(result.accepted).toEqual([]);
    expect(result.heldElsewhere[0].fields[0]).toEqual({
      path: "Tags[0].Value",
      live: "platform",
      source: "claimed-fields",
      baseline: "platform",
    });
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

// #1443 — the declared-side counterpart of `owner`. Both sides of one
// comparison get precise attribution, which is what makes the report actionable.
describe("diffDeep — declared-side origin (#1443)", () => {
  // Annotated, not `as const`: the annotation is what keeps `kind` narrowed to
  // its literal, and it types the fixture as the production shape rather than
  // whatever the literal happens to infer to.
  const declared: Record<string, DeclaredDeepEntity> = {
    web: {
      type: "K8s::Apps::Deployment",
      properties: { spec: { replicas: 2, template: { spec: { containers: [{ name: "app", image: "a:1" }] } } } },
      pathOrigins: {
        "": { kind: "composite", composite: "WebService", instance: "web" },
        "spec.replicas": { kind: "build-param", params: ["tier"] },
      },
    },
  };

  test("reports the origin alongside the live owner", () => {
    const result = diffDeep({
      declared,
      live: live({
        web: {
          type: "K8s::Apps::Deployment",
          properties: { spec: { replicas: 5, template: { spec: { containers: [{ name: "app", image: "a:1" }] } } } },
          fieldOwners: { "spec.replicas": "hpa-controller" },
        },
      }),
    });
    expect(result.drifted[0].changes[0]).toMatchObject({
      path: "spec.replicas",
      owner: "hpa-controller",
      origin: { kind: "build-param", params: ["tier"] },
    });
  });

  test("a path with no origin of its own inherits the nearest recorded ancestor", () => {
    const result = diffDeep({
      declared,
      live: live({
        web: {
          type: "K8s::Apps::Deployment",
          properties: { spec: { replicas: 2, template: { spec: { containers: [{ name: "app", image: "a:2" }] } } } },
        },
      }),
    });
    const change = result.drifted[0].changes.find((c) => c.path.includes("image"))!;
    expect(change.origin).toEqual({ kind: "composite", composite: "WebService", instance: "web" });
  });

  test("an undeclared path gets no origin because it is not a drift row at all", () => {
    const result = diffDeep({
      declared,
      live: live({
        web: {
          type: "K8s::Apps::Deployment",
          properties: {
            spec: { replicas: 2, template: { spec: { containers: [{ name: "app", image: "a:1" }] } } },
            status: { observed: 1 },
          },
        },
      }),
    });
    expect(result.drifted).toEqual([]);
    const held = result.heldElsewhere[0].fields.find((f) => f.path === "status.observed")!;
    expect(held).toEqual({ path: "status.observed", live: 1, source: "claimed-fields" });
  });

  test("is absent when the build recorded no path origins", () => {
    // The run path, and a sandboxed child: absent means "could not record",
    // not "nothing governs this field", so the key must not appear at all.
    const result = diffDeep({
      declared: { web: { type: "K8s::Apps::Deployment", properties: { spec: { replicas: 2 } } } },
      live: live({ web: { type: "K8s::Apps::Deployment", properties: { spec: { replicas: 5 } } } }),
    });
    expect(result.drifted[0].changes[0]).not.toHaveProperty("origin");
  });
});


// #2160 - the claimed-field set. A live value on a property this declaration
// never set belongs to whoever wrote it, and chant reports it as theirs rather
// than proposing to change it.
describe("diffDeep - the claimed-field set (#2160)", () => {
  const declared: Record<string, DeclaredDeepEntity> = {
    web: { type: "K8s::Apps::Deployment", properties: { spec: { replicas: 2 } } },
  };

  test("a declared path that differs is still drift, unchanged", () => {
    const result = diffDeep({
      declared,
      live: live({ web: { type: "K8s::Apps::Deployment", properties: { spec: { replicas: 5 } } } }),
    });
    expect(result.drifted[0].changes).toEqual([
      { path: "spec.replicas", kind: "changed", declared: 2, live: 5 },
    ]);
    expect(result.heldElsewhere).toEqual([]);
  });

  test("a declared path that matches is neither drift nor held", () => {
    const result = diffDeep({
      declared,
      live: live({ web: { type: "K8s::Apps::Deployment", properties: { spec: { replicas: 2 } } } }),
    });
    expect(result.unchanged).toEqual(["web"]);
    expect(result.heldElsewhere).toEqual([]);
  });

  test("the claim answers where the substrate records no manager", () => {
    const result = diffDeep({
      declared,
      live: live({
        web: {
          type: "K8s::Apps::Deployment",
          properties: { spec: { replicas: 2 }, metadata: { labels: { team: "platform" } } },
        },
      }),
    });
    expect(result.heldElsewhere[0].fields).toEqual([
      { path: "metadata.labels.team", live: "platform", source: "claimed-fields" },
    ]);
  });

  test("the manager wins over the claim where the substrate names one", () => {
    const result = diffDeep({
      declared,
      live: live({
        web: {
          type: "K8s::Apps::Deployment",
          properties: { spec: { replicas: 2 }, metadata: { labels: { team: "platform" } } },
          fieldOwners: { "metadata.labels.team": "kubectl-edit" },
        },
      }),
    });
    expect(result.heldElsewhere[0].fields).toEqual([
      { path: "metadata.labels.team", live: "platform", heldBy: "kubectl-edit", source: "field-manager" },
    ]);
  });

  test("a field manager on a DECLARED path still reports drift and names the manager", () => {
    // The contested case: chant's source asks for 2, an autoscaler holds 5.
    // The claim covers the path, so the disagreement is real drift.
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
    expect(result.heldElsewhere).toEqual([]);
    expect(result.drifted[0].changes[0]).toMatchObject({ kind: "changed", owner: "hpa-controller" });
  });

  test("held fields are never counted as drift", () => {
    const result = diffDeep({
      declared,
      live: live({
        web: {
          type: "K8s::Apps::Deployment",
          properties: { spec: { replicas: 5 }, status: { readyReplicas: 5, observedGeneration: 3 } },
        },
      }),
    });
    expect(countPropertyDrift(result)).toBe(1);
    expect(countHeldFields(result)).toBe(2);
  });

  test("an unevaluated intrinsic is claimed, so its live value is not held elsewhere", () => {
    // chant DID set the field; it just cannot know what the reference resolves
    // to. Treating it as unclaimed would report an interpolated property as
    // somebody else's on every read.
    const result = diffDeep({
      declared: { b: { type: "T", properties: { BucketName: UNRESOLVED } } },
      live: live({ b: { type: "T", properties: { BucketName: "prod-data" } } }),
    });
    expect(result.drifted).toEqual([]);
    expect(result.heldElsewhere).toEqual([]);
  });
});

// #2162 — a `heldElsewhere()` marker is never drift: a difference on it is
// reported as held, with its holder and reason, and never as `changed`,
// `undeclared`, or `absent`. The honest example from the issue: an HPA owns
// a Deployment's `spec.replicas` after the first apply.
describe("diffDeep — heldElsewhere() (#2162)", () => {
  test("a live value on a held path is reported as held, not drift", () => {
    const result = diffDeep({
      declared: {
        web: {
          type: "K8s::Apps::Deployment",
          properties: { spec: { replicas: held("hpa", "the autoscaler owns replicas after the first apply") } },
        },
      },
      live: live({ web: { type: "K8s::Apps::Deployment", properties: { spec: { replicas: 5 } } } }),
    });
    expect(result.drifted).toEqual([]);
    expect(countPropertyDrift(result)).toBe(0);
    expect(result.held).toEqual([
      {
        name: "web",
        type: "K8s::Apps::Deployment",
        held: [
          {
            path: "spec.replicas",
            by: "hpa",
            reason: "the autoscaler owns replicas after the first apply",
            live: 5,
            suspicious: false,
          },
        ],
      },
    ]);
    expect(countHeld(result)).toBe(1);
    // Metadata otherwise matched, so it is unchanged too — held is a
    // separate axis, not a substitute for the drift/unchanged split.
    expect(result.unchanged).toEqual(["web"]);
  });

  test("no live value at all on a held path is suspicious — the claimed hand-over never showed up", () => {
    const result = diffDeep({
      declared: {
        web: {
          type: "K8s::Apps::Deployment",
          properties: { spec: { replicas: held("hpa", "x") } },
        },
      },
      live: live({ web: { type: "K8s::Apps::Deployment", properties: {} } }),
    });
    expect(result.drifted).toEqual([]);
    expect(result.held[0].held[0]).toEqual({
      path: "spec.replicas",
      by: "hpa",
      reason: "x",
      suspicious: true,
    });
    expect(result.held[0].held[0]).not.toHaveProperty("live");
    expect(suspiciousHeld(result)).toEqual([
      { name: "web", type: "K8s::Apps::Deployment", path: "spec.replicas", by: "hpa", reason: "x", suspicious: true },
    ]);
  });

  test("carries the field manager that owns the path live, where the substrate records one (#1189)", () => {
    const result = diffDeep({
      declared: {
        web: { type: "K8s::Apps::Deployment", properties: { spec: { replicas: held("hpa", "x") } } },
      },
      live: live({
        web: {
          type: "K8s::Apps::Deployment",
          properties: { spec: { replicas: 5 } },
          fieldOwners: { "spec.replicas": "hpa-controller" },
        },
      }),
    });
    expect(result.held[0].held[0]).toMatchObject({ owner: "hpa-controller" });
  });

  test("a held property never counts toward property drift, even alongside a genuine drift on another path", () => {
    const result = diffDeep({
      declared: {
        web: {
          type: "K8s::Apps::Deployment",
          properties: { spec: { replicas: held("hpa", "x"), image: "app:1" } },
        },
      },
      live: live({
        web: { type: "K8s::Apps::Deployment", properties: { spec: { replicas: 7, image: "app:2" } } },
      }),
    });
    expect(result.drifted).toEqual([
      { name: "web", type: "K8s::Apps::Deployment", changes: [{ path: "spec.image", kind: "changed", declared: "app:1", live: "app:2" }] },
    ]);
    expect(countPropertyDrift(result)).toBe(1);
    expect(countHeld(result)).toBe(1);
    // A held+drifted entity is not unchanged — the same rule as accepted.
    expect(result.unchanged).toEqual([]);
  });

  test("suspiciousHeld() reports nothing when the held property never differs from having no baseline to check", () => {
    // A held property whose live value showed up is not suspicious, whatever
    // that value is — chant has no seed to compare it against, so presence
    // alone is the only evidence it can read in one observation.
    const result = diffDeep({
      declared: { web: { type: "T", properties: { A: held("controller", "x") } } },
      live: live({ web: { type: "T", properties: { A: "anything" } } }),
    });
    expect(suspiciousHeld(result)).toEqual([]);
  });
});
