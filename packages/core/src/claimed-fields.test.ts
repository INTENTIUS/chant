import { describe, test, expect } from "vitest";
import {
  NO_CLAIMED_FIELDS,
  claimedFieldPaths,
  claimedFieldsFromPaths,
  claimedFieldsOfProps,
  claimedFieldsOfTree,
  classifyLiveField,
  heldBy,
  isClaimed,
} from "./claimed-fields";
import { UNRESOLVED, type DeepNormalizationHooks } from "./deep-observation";

describe("claimedFieldsOfProps", () => {
  test("walks props to leaf paths in the diff's grammar", () => {
    const claimed = claimedFieldsOfProps(
      { spec: { replicas: 2, template: { spec: { containers: [{ name: "app", image: "a:1" }] } } } },
      { entityType: "K8s::Apps::Deployment" },
    );
    expect(claimedFieldPaths(claimed)).toEqual([
      "spec.replicas",
      "spec.template.spec.containers[0].image",
      "spec.template.spec.containers[0].name",
    ]);
  });

  test("addresses set-like arrays by the lexicon's own order key", () => {
    const hooks: DeepNormalizationHooks = {
      orderKey: (el) => (el.pattern === "Tags" ? String((el.element as { Key: string }).Key) : undefined),
    };
    const claimed = claimedFieldsOfProps(
      { Tags: [{ Key: "env", Value: "prod" }] },
      { entityType: "AWS::S3::Bucket", hooks },
    );
    expect(claimedFieldPaths(claimed)).toEqual(["Tags[#env].Key", "Tags[#env].Value"]);
  });

  test("a pruned property is not claimed", () => {
    // The hooks decide what is even in the tree, so the claim inherits them
    // rather than second-guessing them: a field the lexicon subtracts on both
    // sides is not a field chant is asserting anything about.
    const hooks: DeepNormalizationHooks = { prune: (node) => node.pattern.startsWith("status") };
    const claimed = claimedFieldsOfProps(
      { spec: { replicas: 2 }, status: { readyReplicas: 2 } },
      { entityType: "T", hooks },
    );
    expect(claimedFieldPaths(claimed)).toEqual(["spec.replicas"]);
  });

  test("an unevaluated intrinsic is still claimed", () => {
    // chant set the field; it just cannot say what the reference resolves to.
    const claimed = claimedFieldsOfProps({ BucketName: UNRESOLVED }, { entityType: "T" });
    expect(isClaimed(claimed, "BucketName")).toBe(true);
  });

  test("an empty declaration claims nothing", () => {
    expect(claimedFieldPaths(claimedFieldsOfProps({}, { entityType: "T" }))).toEqual([]);
    expect(claimedFieldPaths(NO_CLAIMED_FIELDS)).toEqual([]);
  });

  test("agrees with the tree form on an already-normalized tree", () => {
    const props = { spec: { replicas: 2 } };
    expect(claimedFieldPaths(claimedFieldsOfProps(props, { entityType: "T" }))).toEqual(
      claimedFieldPaths(claimedFieldsOfTree(props, { entityType: "T" })),
    );
  });
});

describe("isClaimed", () => {
  const claimed = claimedFieldsFromPaths(["Tags[0].Value", "spec.replicas"]);

  test("matches exactly", () => {
    expect(isClaimed(claimed, "spec.replicas")).toBe(true);
  });

  test("does not match by index-erased pattern", () => {
    // A pattern match would answer "declared" for a path with no declared value
    // to compare against, which is neither of the two declared classifications.
    expect(isClaimed(claimed, "Tags[3].Value")).toBe(false);
  });

  test("does not match an ancestor's claim", () => {
    // Declaring `spec.replicas` says nothing about `spec.strategy.type`.
    expect(isClaimed(claimed, "spec.strategy.type")).toBe(false);
  });

  test("an absent claim claims nothing", () => {
    expect(isClaimed(undefined, "spec.replicas")).toBe(false);
  });
});

describe("classifyLiveField", () => {
  const claimed = claimedFieldsFromPaths(["spec.replicas"]);

  test("declared and equal", () => {
    expect(
      classifyLiveField({ claimed, path: "spec.replicas", declaredValue: 2, liveValue: 2 }),
    ).toBe("declared-equal");
  });

  test("declared and different", () => {
    expect(
      classifyLiveField({ claimed, path: "spec.replicas", declaredValue: 2, liveValue: 5 }),
    ).toBe("declared-changed");
  });

  test("undeclared", () => {
    expect(
      classifyLiveField({ claimed, path: "metadata.labels.team", declaredValue: undefined, liveValue: "platform" }),
    ).toBe("undeclared");
  });

  test("structural equality, not identity", () => {
    const shaped = claimedFieldsFromPaths(["spec.selector"]);
    expect(
      classifyLiveField({
        claimed: shaped,
        path: "spec.selector",
        declaredValue: { app: "web" },
        liveValue: { app: "web" },
      }),
    ).toBe("declared-equal");
  });
});

describe("heldBy", () => {
  test("the substrate's manager answers where it has one", () => {
    expect(heldBy({ "spec.replicas": "hpa-controller" }, "spec.replicas")).toEqual({
      holder: "hpa-controller",
      source: "field-manager",
    });
  });

  test("the claim answers where the substrate records nothing", () => {
    expect(heldBy(undefined, "spec.replicas")).toEqual({ source: "claimed-fields" });
  });

  test("the claim answers for a path the ownership metadata does not cover", () => {
    // Kubernetes' own case: a keyed list segment has no `managedFields` entry
    // under that path, so the declaration is the only witness left.
    expect(heldBy({ "spec.replicas": "hpa-controller" }, "spec.template.spec.containers[#sidecar].image")).toEqual({
      source: "claimed-fields",
    });
  });
});
