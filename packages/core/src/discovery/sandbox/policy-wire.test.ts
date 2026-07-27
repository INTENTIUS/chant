import { describe, test, expect } from "vitest";
import { AttrRef } from "../../attrref";
import { CHILD_PROJECT_MARKER } from "../../child-project";
import { DECLARABLE_MARKER, type Declarable } from "../../declarable";
import { INTRINSIC_MARKER, type Intrinsic } from "../../intrinsic";
import { DiscoveryError } from "../../errors";
import { createResource } from "../../runtime";
import { resolveAttrRefs } from "../resolve";
import { isAttrRefLike } from "../../utils";
import type { PostSynthCheck } from "../../lint/post-synth";
import { runPostSynthChecks } from "../../lint/post-synth";
import {
  decodePolicyBuildResult,
  encodePolicyBuildResult,
  scanPolicyDiagnostics,
  type EncodablePolicyBuildResult,
} from "./policy-wire";

/**
 * chant #1131 — the contract between the CLI process and the sandboxed policy
 * child, in both directions.
 *
 * These tests are the "document the difference precisely and pin it" half of
 * the brief. A policy check under `--sandbox` no longer sees the parent's own
 * live objects; it sees what survived `encodePolicyBuildResult` →
 * `JSON.parse(JSON.stringify(...))` → `decodePolicyBuildResult`. Everything
 * that is the SAME is asserted here so a regression is caught, and everything
 * that is NARROWER is asserted here too, so the narrowing can never quietly
 * change without a test failing.
 */

/** What the IPC channel actually does to the payload. Every test goes through it — an in-memory hand-off would prove nothing. */
function overTheWire(result: EncodablePolicyBuildResult) {
  const wire = encodePolicyBuildResult(result);
  return decodePolicyBuildResult(JSON.parse(JSON.stringify(wire)));
}

function emptyResult(overrides: Partial<EncodablePolicyBuildResult> = {}): EncodablePolicyBuildResult {
  return {
    outputs: new Map(),
    entities: new Map(),
    warnings: [],
    errors: [],
    sourceFileCount: 0,
    ...overrides,
  };
}

describe("the build result a sandboxed policy sees (chant #1131)", () => {
  test("outputs — the surface the reference policy corpus actually reads — cross exactly", () => {
    const result = emptyResult({
      outputs: new Map<string, string | { primary: string; files?: Record<string, string>; warnings?: string[] }>([
        ["k8s", "apiVersion: v1\nkind: Service\n"],
        ["aws", { primary: '{"Resources":{}}', files: { "net.template.json": "{}" }, warnings: ["dropped a key"] }],
      ]),
      warnings: ["a build warning"],
      sourceFileCount: 3,
    });

    const decoded = overTheWire(result);

    expect(decoded.outputs.get("k8s")).toBe("apiVersion: v1\nkind: Service\n");
    expect(decoded.outputs.get("aws")).toEqual({
      primary: '{"Resources":{}}',
      files: { "net.template.json": "{}" },
      warnings: ["dropped a key"],
    });
    expect(decoded.outputs).toBeInstanceOf(Map);
    expect(decoded.warnings).toEqual(["a build warning"]);
    expect(decoded.sourceFileCount).toBe(3);
  });

  test("entities cross as a live Map of Declarables, with AttrRefs still resolved and still AttrRefs", () => {
    const Vpc = createResource("Test::Vpc", "test", { vpcId: "VpcId" });
    const Subnet = createResource("Test::Subnet", "test", { subnetId: "SubnetId" });
    const vpc = new Vpc({ CidrBlock: "10.0.0.0/16" });
    const subnet = new Subnet({ VpcId: (vpc as unknown as Record<string, AttrRef>).vpcId });
    const entities = new Map<string, Declarable>([
      ["Vpc", vpc as unknown as Declarable],
      ["Subnet", subnet as unknown as Declarable],
    ]);
    resolveAttrRefs(entities);

    const decoded = overTheWire(emptyResult({ entities }));

    expect([...decoded.entities.keys()]).toEqual(["Vpc", "Subnet"]);
    const decodedSubnet = decoded.entities.get("Subnet") as unknown as { props: { VpcId: unknown } };
    expect(isAttrRefLike(decodedSubnet.props.VpcId)).toBe(true);
    // A real AttrRef, not a `{__attrRef}` envelope — several chant call sites
    // (and any policy doing the same) test `instanceof`, not duck typing.
    expect(decodedSubnet.props.VpcId).toBeInstanceOf(AttrRef);
    expect((decodedSubnet.props.VpcId as AttrRef).getLogicalName()).toBe("Vpc");
    // The WeakRef points at the DECODED parent — self-consistent inside the
    // child, which is all a check over `ctx.entities` can observe.
    expect((decodedSubnet.props.VpcId as AttrRef).parent.deref()).toBe(decoded.entities.get("Vpc"));
  });

  test("a decoded entity's own enumerable keys match the original's", () => {
    // `createResource` defines lexicon/entityType/kind/props/attributes
    // non-enumerable and the per-attribute AttrRefs enumerable; the decoder
    // reproduces exactly that split. So `Object.keys(entity)` — which a policy
    // walking an entity generically would use — is the same on both sides.
    const Bucket = createResource("Test::Bucket", "test", { arn: "Arn", name: "Name" });
    const bucket = new Bucket({ Versioning: true });
    const entities = new Map<string, Declarable>([["Bucket", bucket as unknown as Declarable]]);
    resolveAttrRefs(entities);

    const decoded = overTheWire(emptyResult({ entities }));

    expect(Object.keys(decoded.entities.get("Bucket") as object)).toEqual(Object.keys(bucket as object));
    expect((decoded.entities.get("Bucket") as unknown as { props: unknown }).props).toEqual({ Versioning: true });
    expect(DECLARABLE_MARKER in (decoded.entities.get("Bucket") as object)).toBe(true);
  });

  test("encoding is idempotent over an already-decoded entity — the run-fallback subset pays nothing extra", () => {
    // Under `--sandbox` the parent's merged entities ALREADY include decoded
    // ones for every run-fallback file (`./run.ts`). If a second round trip
    // narrowed them further, this child would be doing real damage to part of
    // the set. It does not: encode∘decode∘encode === encode.
    const Queue = createResource("Test::Queue", "test", { url: "Url" });
    const Fn = createResource("Test::Fn", "test", {});
    const queue = new Queue({ Fifo: true });
    const fn = new Fn({ QueueUrl: (queue as unknown as Record<string, AttrRef>).url });
    const entities = new Map<string, Declarable>([
      ["Queue", queue as unknown as Declarable],
      ["Fn", fn as unknown as Declarable],
    ]);
    resolveAttrRefs(entities);

    const once = encodePolicyBuildResult(emptyResult({ entities }));
    const twice = encodePolicyBuildResult(emptyResult({ entities: decodePolicyBuildResult(once).entities }));

    expect(twice.entities).toEqual(once.entities);
  });

  test("NARROWER: an intrinsic decodes to a toJSON()-bearing wrapper, not to its own class", () => {
    class Sub implements Intrinsic {
      readonly [INTRINSIC_MARKER] = true as const;
      constructor(readonly template: string) {}
      toJSON(): unknown {
        return { "Fn::Sub": this.template };
      }
    }
    const Fn = createResource("Test::Fn", "test", {});
    const fn = new Fn({ Name: new Sub("${AWS::StackName}-fn") });
    const entities = new Map<string, Declarable>([["Fn", fn as unknown as Declarable]]);
    resolveAttrRefs(entities);

    const decoded = overTheWire(emptyResult({ entities }));
    const name = (decoded.entities.get("Fn") as unknown as { props: { Name: Intrinsic & { template?: string } } }).props.Name;

    // What still works: the marker, and the serialized form every serializer
    // and every output-reading check goes through.
    expect(INTRINSIC_MARKER in (name as object)).toBe(true);
    expect(name.toJSON()).toEqual({ "Fn::Sub": "${AWS::StackName}-fn" });
    // What does NOT: the class, and its own fields. A policy that reaches into
    // an intrinsic's internals rather than its `toJSON()` sees nothing under
    // `--sandbox`. Documented in docs/.../architecture/sandbox.mdx.
    expect(name).not.toBeInstanceOf(Sub);
    expect(name.template).toBeUndefined();
  });

  test("NARROWER: errors cross as plain objects, not Error instances", () => {
    const result = emptyResult({ errors: [new DiscoveryError("/p/a.ts", "boom", "import")] });

    const decoded = overTheWire(result);

    expect(decoded.errors).toEqual([
      { name: "DiscoveryError", file: "/p/a.ts", message: "boom", type: "import" },
    ]);
    expect(decoded.errors[0]).not.toBeInstanceOf(Error);
    // Never observable in practice: `chant build` runs policies only when the
    // build produced no errors at all, so this array is always empty there.
  });

  test("REFUSED, not dropped: a nestedStack() child project has no wire form", () => {
    const child = { [DECLARABLE_MARKER]: true, [CHILD_PROJECT_MARKER]: true, lexicon: "test", entityType: "Test::Child" };
    const entities = new Map<string, Declarable>([["Child", child as unknown as Declarable]]);

    expect(() => encodePolicyBuildResult(emptyResult({ entities }))).toThrow(/child project \(nestedStack\(\)\)/);
  });

  test("REFUSED, not dropped: a serializer output that is not data is named by key path", () => {
    const outputs = new Map<string, string | { primary: string }>([
      ["weird", { primary: "ok", extra: () => 1 } as unknown as { primary: string }],
    ]);

    // `encodeOutput` copies only the declared fields, so a stray function on a
    // SerializerResult never reaches the wire in the first place. The scan is
    // the backstop for the fields that ARE carried.
    const encoded = encodePolicyBuildResult(emptyResult({ outputs }));
    expect(encoded.outputs).toEqual([["weird", { primary: "ok" }]]);

    expect(() =>
      encodePolicyBuildResult(emptyResult({ manifest: { generatedAt: new Date(0) } })),
    ).toThrow(/buildResult\.manifest\.generatedAt: a Date/);
  });

  test("the undeclared-but-carried fields (dependencies, manifest, foldDecisions, buildParams) cross too", () => {
    const result = emptyResult({
      dependencies: new Map([["Subnet", new Set(["Vpc"])]]),
      manifest: { lexicons: ["test"], outputs: {}, deployOrder: ["test"] },
      foldDecisions: [{ file: "/p/a.ts", mode: "fold", resourceCount: 1 }],
      buildParams: [{ name: "tier", value: "prod", source: "cli" }],
    });

    const decoded = overTheWire(result) as unknown as {
      dependencies: Map<string, Set<string>>;
      manifest: unknown;
      foldDecisions: unknown[];
      buildParams: unknown[];
    };

    expect(decoded.dependencies.get("Subnet")).toEqual(new Set(["Vpc"]));
    expect(decoded.manifest).toEqual({ lexicons: ["test"], outputs: {}, deployOrder: ["test"] });
    expect(decoded.foldDecisions).toEqual([{ file: "/p/a.ts", mode: "fold", resourceCount: 1 }]);
    expect(decoded.buildParams).toEqual([{ name: "tier", value: "prod", source: "cli" }]);
  });

  test("a check run over the decoded result produces what it produces over the original", () => {
    const Ingress = createResource("Test::Ingress", "test", {});
    const entities = new Map<string, Declarable>([
      ["Ing", new Ingress({ tls: [] }) as unknown as Declarable],
    ]);
    resolveAttrRefs(entities);
    const result = emptyResult({ entities, outputs: new Map([["test", "kind: Ingress\n"]]) });

    const check: PostSynthCheck = {
      id: "T",
      description: "reads both surfaces",
      check(ctx) {
        const out: Array<{ checkId: string; severity: "error"; message: string; entity?: string }> = [];
        for (const [name, entity] of ctx.entities) {
          const props = (entity as unknown as { props?: { tls?: unknown[] } }).props;
          if (Array.isArray(props?.tls) && props.tls.length === 0) {
            out.push({ checkId: "T", severity: "error", message: `${name} has no TLS in ${ctx.env}`, entity: name });
          }
        }
        for (const [, o] of ctx.outputs) {
          if (typeof o === "string" && o.includes("Ingress")) {
            out.push({ checkId: "T", severity: "error", message: "output mentions Ingress" });
          }
        }
        return out;
      },
    };

    const inProcess = runPostSynthChecks([check], result as unknown as Parameters<typeof runPostSynthChecks>[1], "prod");
    const sandboxed = runPostSynthChecks([check], overTheWire(result), "prod");

    expect(sandboxed).toEqual(inProcess);
  });
});

describe("what a policy is allowed to return (chant #1131)", () => {
  const P = "/p/policies/org.ts";

  test("plain diagnostics pass", () => {
    expect(
      scanPolicyDiagnostics(
        [
          { checkId: "A", severity: "error", message: "m", entity: "E", lexicon: "k8s" },
          { checkId: "B", severity: "info", message: "n" },
        ],
        P,
      ),
    ).toEqual([]);
    expect(scanPolicyDiagnostics([], P)).toEqual([]);
  });

  test("a function on a diagnostic is named, with the policy that produced it", () => {
    const offenders = scanPolicyDiagnostics([{ checkId: "A", severity: "error", message: "m", fix: () => 1 }], P);

    expect(offenders).toEqual([{ policy: P, path: "[0].fix", found: "a function" }]);
  });

  test("a Date, a class instance and a circular reference are each named", () => {
    expect(scanPolicyDiagnostics([{ checkId: "A", severity: "error", message: "m", at: new Date(0) }], P)[0]).toMatchObject({
      path: "[0].at",
      found: "a Date",
    });
    expect(scanPolicyDiagnostics([{ checkId: "A", severity: "error", message: "m", err: new Error("x") }], P)[0]).toMatchObject({
      found: "an Error",
    });
    const circular: Record<string, unknown> = { checkId: "A", severity: "error", message: "m" };
    circular.self = circular;
    expect(scanPolicyDiagnostics([circular], P)[0]).toMatchObject({ found: "a circular reference" });
  });

  test("a value that is data but is not a diagnostic is named too", () => {
    expect(scanPolicyDiagnostics([{ severity: "error", message: "m" }], P)).toEqual([
      { policy: P, path: "[0].checkId", found: "not a non-empty string" },
    ]);
    expect(scanPolicyDiagnostics([{ checkId: "A", severity: "fatal", message: "m" }], P)).toEqual([
      { policy: P, path: "[0].severity", found: `not one of "error", "warning", "info"` },
    ]);
    expect(scanPolicyDiagnostics(["just a string"], P)).toEqual([
      { policy: P, path: "[0]", found: "a string" },
    ]);
  });

  test("a check that does not return an array at all is named", () => {
    expect(scanPolicyDiagnostics(undefined, P)).toEqual([
      { policy: P, path: "<return value>", found: "undefined" },
    ]);
    expect(scanPolicyDiagnostics({ checkId: "A" }, P)).toEqual([
      { policy: P, path: "<return value>", found: "a object" },
    ]);
  });
});
