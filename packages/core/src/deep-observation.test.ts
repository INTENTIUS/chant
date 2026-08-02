import { describe, test, expect } from "vitest";
import {
  MASKED,
  UNRESOLVED,
  deepObservation,
  deepPathSet,
  deepValueEqual,
  flattenDeepProperties,
  isDeepObservationResult,
  isSensitiveKey,
  normalizeDeepObservation,
  normalizeDeepProperties,
  type DeepNormalizationHooks,
} from "./deep-observation";

describe("the deep observation envelope", () => {
  test("is discriminated by its version literal", () => {
    expect(isDeepObservationResult(deepObservation({}))).toBe(true);
    expect(isDeepObservationResult({ resources: {} })).toBe(false);
    expect(isDeepObservationResult({ observation: "v1", resources: {} })).toBe(false);
    expect(isDeepObservationResult(null)).toBe(false);
  });

  test("omits an empty unobserved map rather than emitting one", () => {
    expect(deepObservation({}, {})).toEqual({ deepObservation: "v1", resources: {} });
  });

  test("normalizing undefined yields two empty maps", () => {
    expect(normalizeDeepObservation(undefined)).toEqual({ resources: {}, unobserved: {} });
  });

  test("carries the tri-state contract's unobserved entries verbatim", () => {
    const result = deepObservation(
      { a: { type: "T", properties: {} } },
      { b: { type: "T", reason: "unsupported-kind", detail: "no reader" } },
    );
    expect(normalizeDeepObservation(result).unobserved.b.reason).toBe("unsupported-kind");
  });
});

describe("normalizeDeepProperties", () => {
  test("canonicalizes object key order", () => {
    const out = normalizeDeepProperties(
      { zeta: 1, alpha: 2, mid: { z: 1, a: 2 } },
      { entityType: "T", side: "live" },
    );
    expect(Object.keys(out)).toEqual(["alpha", "mid", "zeta"]);
    expect(Object.keys(out.mid as Record<string, unknown>)).toEqual(["a", "z"]);
  });

  test("leaves array order alone with no ordering hook", () => {
    const out = normalizeDeepProperties({ Tags: [{ Key: "z" }, { Key: "a" }] }, { entityType: "T", side: "live" });
    expect(out.Tags).toEqual([{ Key: "z" }, { Key: "a" }]);
  });

  test("orders an array when the hook keys every element", () => {
    const hooks: DeepNormalizationHooks = {
      orderKey: (el) => (el.pattern === "Tags" ? String((el.element as { Key: string }).Key) : undefined),
    };
    const out = normalizeDeepProperties(
      { Tags: [{ Key: "z" }, { Key: "a" }], Steps: ["second", "first"] },
      { entityType: "T", side: "live", hooks },
    );
    expect(out.Tags).toEqual([{ Key: "a" }, { Key: "z" }]);
    // No key for Steps — order is left alone, because list order is often
    // semantic and a guess here is worse than a stable false negative.
    expect(out.Steps).toEqual(["second", "first"]);
  });

  test("a partially-keyed array keeps its order", () => {
    const hooks: DeepNormalizationHooks = {
      orderKey: (el) => (el.index === 0 ? "a" : undefined),
    };
    const out = normalizeDeepProperties({ List: ["x", "y"] }, { entityType: "T", side: "live", hooks });
    expect(out.List).toEqual(["x", "y"]);
  });

  test("prunes by hook, and prunes the whole subtree", () => {
    const hooks: DeepNormalizationHooks = { prune: (n) => n.pattern === "Status" };
    const out = normalizeDeepProperties(
      { Status: { Phase: "Ready", Conditions: [1, 2] }, Name: "n" },
      { entityType: "T", side: "live", hooks },
    );
    expect(out).toEqual({ Name: "n" });
  });

  // A container the rules emptied is not a container the source declared empty.
  // Keeping the husk turns a suppressed default into drift-shaped noise —
  // `SecurityGroupEgress[#{}]: <undeclared> → {}` was the case that found this.
  test("an object whose every field was pruned is dropped, not left as {}", () => {
    const hooks: DeepNormalizationHooks = { prune: (n) => n.key === "CidrIp" || n.key === "IpProtocol" };
    const out = normalizeDeepProperties(
      { Egress: [{ CidrIp: "0.0.0.0/0", IpProtocol: "-1" }], Name: "n" },
      { entityType: "T", side: "live", hooks },
    );
    expect(out).toEqual({ Name: "n" });
  });

  test("an object the source declared empty survives", () => {
    const hooks: DeepNormalizationHooks = { prune: () => false };
    const out = normalizeDeepProperties(
      { Spec: {}, Items: [], Name: "n" },
      { entityType: "T", side: "live", hooks },
    );
    expect(out).toEqual({ Spec: {}, Items: [], Name: "n" });
  });

  test("a partly pruned object keeps what survived", () => {
    const hooks: DeepNormalizationHooks = { prune: (n) => n.key === "Arn" };
    const out = normalizeDeepProperties(
      { Role: { Arn: "arn:…", Path: "/" } },
      { entityType: "T", side: "live", hooks },
    );
    expect(out).toEqual({ Role: { Path: "/" } });
  });

  test("emptiness propagates up as far as the pruning reaches", () => {
    const hooks: DeepNormalizationHooks = { prune: (n) => n.key === "Gone" };
    const out = normalizeDeepProperties(
      { Outer: { Inner: { Gone: 1 } }, Name: "n" },
      { entityType: "T", side: "live", hooks },
    );
    expect(out).toEqual({ Name: "n" });
  });

  test("an array keeps the elements pruning did not empty", () => {
    const hooks: DeepNormalizationHooks = { prune: (n) => n.key === "Default" };
    const out = normalizeDeepProperties(
      { Rules: [{ Default: true }, { Port: 443 }] },
      { entityType: "T", side: "live", hooks },
    );
    expect(out).toEqual({ Rules: [{ Port: 443 }] });
  });

  test("hooks see an index-erased pattern alongside the exact path", () => {
    const seen: Array<[string, string]> = [];
    const hooks: DeepNormalizationHooks = {
      prune: (n) => {
        seen.push([n.path, n.pattern]);
        return false;
      },
    };
    normalizeDeepProperties({ Tags: [{ Key: "a" }] }, { entityType: "T", side: "live", hooks });
    expect(seen).toContainEqual(["Tags[0].Key", "Tags[].Key"]);
  });

  test("counterpart is `unknown` for a one-sided pass and resolved when paths are supplied", () => {
    const seen: Record<string, string> = {};
    const hooks: DeepNormalizationHooks = {
      prune: (n) => {
        seen[n.pattern] = n.counterpart;
        return false;
      },
    };
    normalizeDeepProperties({ A: 1, B: 2 }, { entityType: "T", side: "live", hooks });
    expect(seen).toEqual({ A: "unknown", B: "unknown" });

    normalizeDeepProperties(
      { A: 1, B: 2 },
      { entityType: "T", side: "live", hooks, counterpartPaths: deepPathSet({ A: 9 }) },
    );
    expect(seen).toEqual({ A: "present", B: "absent" });
  });

  test("an array element counts as declared when the pattern is declared at any index", () => {
    const seen: Record<string, string> = {};
    const hooks: DeepNormalizationHooks = {
      prune: (n) => {
        seen[n.path] = n.counterpart;
        return false;
      },
    };
    normalizeDeepProperties(
      { Tags: [{ Key: "b" }, { Key: "a" }] },
      { entityType: "T", side: "live", hooks, counterpartPaths: deepPathSet({ Tags: [{ Key: "a" }] }) },
    );
    // Source declares one tag; both live tags match the `Tags[].Key` pattern.
    expect(seen["Tags[1].Key"]).toBe("present");
  });

  test("masks secret-bearing property names without recursing into them", () => {
    const out = normalizeDeepProperties(
      { MasterUserPassword: "hunter2", Nested: { ClientSecret: { a: 1 } }, Tags: [{ Key: "k", Value: "v" }] },
      { entityType: "T", side: "live" },
    );
    expect(out.MasterUserPassword).toBe(MASKED);
    expect((out.Nested as Record<string, unknown>).ClientSecret).toBe(MASKED);
    // `Key`/`Value` are not secrets — masking them would be its own drift signal.
    expect(out.Tags).toEqual([{ Key: "k", Value: "v" }]);
  });

  test("collapses non-JSON values (an unevaluated intrinsic) to the unresolved sentinel", () => {
    class SubIntrinsic {
      constructor(readonly template: string) {}
    }
    const out = normalizeDeepProperties(
      { BucketName: new SubIntrinsic("${AWS::StackName}-data"), Plain: "x" },
      { entityType: "T", side: "declared" },
    );
    expect(out.BucketName).toBe(UNRESOLVED);
    expect(out.Plain).toBe("x");
  });

  test("drops undefined but keeps null", () => {
    const out = normalizeDeepProperties({ a: undefined, b: null }, { entityType: "T", side: "live" });
    expect("a" in out).toBe(false);
    expect(out.b).toBeNull();
  });
});

describe("isSensitiveKey", () => {
  test("matches the secret-bearing names and nothing broader", () => {
    for (const k of ["Password", "clientSecret", "AuthToken", "PrivateKey", "credentials", "ConnectionString"]) {
      expect(isSensitiveKey(k), k).toBe(true);
    }
    for (const k of ["Key", "KeyName", "KmsKeyId", "Value", "Name"]) {
      expect(isSensitiveKey(k), k).toBe(false);
    }
  });
});

describe("flattenDeepProperties", () => {
  test("flattens to leaf paths, keeping empty containers as values", () => {
    const flat = flattenDeepProperties({
      A: { B: 1 },
      List: [{ C: "x" }, "y"],
      EmptyObj: {},
      EmptyArr: [],
    });
    expect(Object.fromEntries(flat)).toEqual({
      "A.B": 1,
      "List[0].C": "x",
      "List[1]": "y",
      EmptyObj: {},
      EmptyArr: [],
    });
  });
});

describe("flattenDeepProperties with an ordering hook", () => {
  const hooks: DeepNormalizationHooks = {
    orderKey: (el) => (el.pattern === "Tags" ? String((el.element as { Key: string }).Key) : undefined),
  };
  const opts = { entityType: "T", side: "live" as const, hooks };

  test("addresses a keyable array by key, so an inserted element shifts nothing", () => {
    const flat = flattenDeepProperties({ Tags: [{ Key: "env", Value: "prod" }] }, opts);
    expect([...flat.keys()].sort()).toEqual(["Tags[#env].Key", "Tags[#env].Value"]);

    const withExtra = flattenDeepProperties(
      { Tags: [{ Key: "cost", Value: "x" }, { Key: "env", Value: "prod" }] },
      opts,
    );
    expect(withExtra.get("Tags[#env].Value")).toBe("prod");
  });

  test("falls back to positional paths when keys collide", () => {
    const flat = flattenDeepProperties({ Tags: [{ Key: "env", Value: "a" }, { Key: "env", Value: "b" }] }, opts);
    expect([...flat.keys()]).toContain("Tags[0].Value");
  });

  test("falls back to positional paths for an array the hook cannot key", () => {
    const flat = flattenDeepProperties({ Steps: ["a", "b"] }, opts);
    expect([...flat.keys()]).toEqual(["Steps[0]", "Steps[1]"]);
  });
});

describe("deepPathSet", () => {
  test("records both the exact path and the index-erased pattern", () => {
    const set = deepPathSet({ Tags: [{ Key: "a" }] });
    expect([...set].sort()).toEqual(["Tags", "Tags[0]", "Tags[0].Key", "Tags[]", "Tags[].Key"]);
  });
});

describe("deepValueEqual", () => {
  test("compares structurally", () => {
    expect(deepValueEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
    expect(deepValueEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    expect(deepValueEqual(null, undefined)).toBe(false);
    expect(deepValueEqual(1, 1)).toBe(true);
  });
});

// #1314 — a nested property authored through a lexicon's generated constructor
// is authored data, not an opaque class instance. Collapsing it to UNRESOLVED
// left the declared side empty while the live side held the real value, so
// every field of it reported `<undeclared>` on a clean apply.
describe("normalizeDeepProperties — property-kind declarables (#1314)", () => {
  /** Shaped like a generated property constructor's instance. */
  const propertyDeclarable = (entityType: string, props: Record<string, unknown>) => ({
    entityType,
    kind: "property",
    props,
  });

  test("unwraps a property-kind declarable to its authored props", () => {
    const out = normalizeDeepProperties(
      {
        GroupDescription: "sg",
        SecurityGroupIngress: [
          propertyDeclarable("AWS::EC2::SecurityGroup.Ingress", {
            IpProtocol: "tcp",
            FromPort: 443,
            ToPort: 443,
            CidrIp: "10.42.0.0/16",
          }),
        ],
      },
      { entityType: "AWS::EC2::SecurityGroup", side: "declared" },
    );
    expect(out).toEqual({
      GroupDescription: "sg",
      SecurityGroupIngress: [{ CidrIp: "10.42.0.0/16", FromPort: 443, IpProtocol: "tcp", ToPort: 443 }],
    });
  });

  test("produces the same tree as the equivalent plain object — the two authoring forms must not differ", () => {
    const viaConstructor = normalizeDeepProperties(
      { Ingress: [propertyDeclarable("T.Ingress", { IpProtocol: "tcp", FromPort: 443 })] },
      { entityType: "T", side: "declared" },
    );
    const viaLiteral = normalizeDeepProperties(
      { Ingress: [{ IpProtocol: "tcp", FromPort: 443 }] },
      { entityType: "T", side: "declared" },
    );
    expect(viaConstructor).toEqual(viaLiteral);
  });

  test("unwraps nested property declarables all the way down", () => {
    const out = normalizeDeepProperties(
      {
        Logging: propertyDeclarable("T.Logging", {
          CloudWatch: propertyDeclarable("T.CloudWatch", { Enabled: true, LogGroup: "g" }),
        }),
      },
      { entityType: "T", side: "declared" },
    );
    expect(out).toEqual({ Logging: { CloudWatch: { Enabled: true, LogGroup: "g" } } });
  });

  test("still collapses a RESOURCE-kind declarable — it is a reference with no source-side value", () => {
    // A class instance, as a lexicon actually constructs one: a resource-kind
    // declarable in another resource's props is a Ref, and there is nothing on
    // the source side to compare a live value against.
    class VpcDeclarable {
      readonly entityType = "AWS::EC2::VPC";
      readonly kind = "resource";
      readonly props = { CidrBlock: "10.0.0.0/16" };
    }
    const out = normalizeDeepProperties(
      { VpcId: new VpcDeclarable() },
      { entityType: "AWS::EC2::SecurityGroup", side: "declared" },
    );
    expect(out).toEqual({ VpcId: UNRESOLVED });
  });

  test("unwraps a property-kind declarable that is a class instance, which is how a lexicon builds one", () => {
    class IngressDeclarable {
      readonly entityType = "AWS::EC2::SecurityGroup.Ingress";
      readonly kind = "property";
      constructor(readonly props: Record<string, unknown>) {}
    }
    const out = normalizeDeepProperties(
      { Ingress: [new IngressDeclarable({ IpProtocol: "tcp", FromPort: 443 })] },
      { entityType: "AWS::EC2::SecurityGroup", side: "declared" },
    );
    expect(out).toEqual({ Ingress: [{ FromPort: 443, IpProtocol: "tcp" }] });
  });

  test("still collapses a genuine class instance, which is what the branch is for", () => {
    class Sub {
      constructor(readonly template: string) {}
    }
    const out = normalizeDeepProperties({ Name: new Sub("${AWS::StackName}-x") }, { entityType: "T", side: "declared" });
    expect(out).toEqual({ Name: UNRESOLVED });
  });

  test("masks a secret inside an unwrapped property declarable, same as in a plain object", () => {
    const out = normalizeDeepProperties(
      { Auth: propertyDeclarable("T.Auth", { Username: "u", Password: "hunter2" }) },
      { entityType: "T", side: "declared" },
    );
    expect(out).toEqual({ Auth: { Password: MASKED, Username: "u" } });
  });
});
