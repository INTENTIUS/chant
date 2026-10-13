/**
 * Telemetry attribution on k8s workloads (#3059, #2558 D22, ws-060): each
 * container of a Deployment, StatefulSet, DaemonSet, ReplicaSet, Job, CronJob
 * or Pod gets `OTEL_SERVICE_NAME` and `OTEL_RESOURCE_ATTRIBUTES` when the
 * build hands the serializer `context.telemetry`.
 */
import { describe, expect, test } from "vitest";
import { loadAll } from "js-yaml";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { k8sSerializer } from "./serializer";

function mockResource(entityType: string, props: Record<string, unknown>): any {
  return { [DECLARABLE_MARKER]: true, lexicon: "k8s", entityType, kind: "resource", props };
}

type Doc = Record<string, any>;

function serialize(entities: Map<string, unknown>, telemetry?: { workspace?: string; member?: string; environment?: string }): string {
  const result = k8sSerializer.serialize(entities as Map<string, any>, [], telemetry ? { telemetry } : undefined);
  return typeof result === "string" ? result : result.primary;
}

function docs(out: string): Doc[] {
  return loadAll(out) as Doc[];
}

const podSpec = (containers: unknown[]) => ({ containers });
const RELEASE_ENV = {
  name: "CHANT_RELEASE_ATTRIBUTES",
  valueFrom: { fieldRef: { fieldPath: "metadata.annotations['chant.intentius.io/release-attributes']" } },
};
const valueOf = (env: Doc[], name: string) => env.find((e) => e.name === name)?.value;
const attrs = { workspace: "acme", member: "delivery", environment: "prod" };

const workloads: Array<[string, string, (spec: unknown) => Record<string, unknown>, (doc: Doc) => Doc]> = [
  ["Deployment", "K8s::Apps::Deployment", (s) => ({ spec: { template: { spec: s } } }), (d) => d.spec.template.spec],
  ["StatefulSet", "K8s::Apps::StatefulSet", (s) => ({ spec: { template: { spec: s } } }), (d) => d.spec.template.spec],
  ["DaemonSet", "K8s::Apps::DaemonSet", (s) => ({ spec: { template: { spec: s } } }), (d) => d.spec.template.spec],
  ["Job", "K8s::Batch::Job", (s) => ({ spec: { template: { spec: s } } }), (d) => d.spec.template.spec],
  ["CronJob", "K8s::Batch::CronJob", (s) => ({ spec: { schedule: "* * * * *", jobTemplate: { spec: { template: { spec: s } } } } }), (d) => d.spec.jobTemplate.spec.template.spec],
  ["Pod", "K8s::Core::Pod", (s) => ({ spec: s }), (d) => d.spec],
];

describe("telemetry attribution on workloads", () => {
  test.each(workloads)("a %s's containers get OTEL_SERVICE_NAME and OTEL_RESOURCE_ATTRIBUTES", (_kind, type, wrap, pod) => {
    const entities = new Map([["apiWorkload", mockResource(type, { metadata: { name: "api" }, ...wrap(podSpec([{ name: "api", image: "nginx:1" }])) })]]);
    const [doc] = docs(serialize(entities, attrs));
    expect(pod(doc).containers[0].env).toEqual([
      { name: "OTEL_SERVICE_NAME", value: "api" },
      RELEASE_ENV,
      {
        name: "OTEL_RESOURCE_ATTRIBUTES",
        value: "chant.workspace=acme,chant.member=delivery,chant.decl=apiWorkload,deployment.environment.name=prod$(CHANT_RELEASE_ATTRIBUTES)",
      },
    ]);
  });

  test("without a telemetry context the output is the same bytes as with an empty one, and has no OTEL_ variables", () => {
    const entities = new Map([["api", mockResource("K8s::Apps::Deployment", { metadata: { name: "api" }, spec: { template: { spec: podSpec([{ name: "api", image: "nginx:1" }]) } } })]]);
    const plain = serialize(entities);
    expect(plain).toBe(k8sSerializer.serialize(entities as Map<string, any>, [], {}));
    expect(plain).not.toContain("OTEL_");
  });

  test("a variable the container sets is kept, its own resource attributes keep their keys, and valueFrom is left alone", () => {
    const containers = [
      {
        name: "own",
        image: "x",
        env: [
          { name: "PORT", value: "80" },
          { name: "OTEL_SERVICE_NAME", value: "checkout" },
          { name: "OTEL_RESOURCE_ATTRIBUTES", value: "chant.member=mine,team=pay" },
        ],
      },
      { name: "ref", image: "y", env: [{ name: "OTEL_RESOURCE_ATTRIBUTES", valueFrom: { configMapKeyRef: { name: "otel", key: "attrs" } } }] },
    ];
    const entities = new Map([["api", mockResource("K8s::Apps::Deployment", { metadata: { name: "api" }, spec: { template: { spec: podSpec(containers) } } })]]);
    const [own, ref] = docs(serialize(entities, attrs))[0].spec.template.spec.containers;
    expect(own.env).toEqual([
      { name: "PORT", value: "80" },
      { name: "OTEL_SERVICE_NAME", value: "checkout" },
      RELEASE_ENV,
      { name: "OTEL_RESOURCE_ATTRIBUTES", value: "chant.member=mine,team=pay,chant.workspace=acme,chant.decl=api,deployment.environment.name=prod$(CHANT_RELEASE_ATTRIBUTES)" },
    ]);
    expect(ref.env).toEqual([
      { name: "OTEL_RESOURCE_ATTRIBUTES", valueFrom: { configMapKeyRef: { name: "otel", key: "attrs" } } },
      { name: "OTEL_SERVICE_NAME", value: "api" },
    ]);
  });

  test("an env given as a map keeps its keys and gains the missing ones, without the release reference a map cannot order", () => {
    const containers = [{ name: "api", image: "x", env: { PORT: "80", OTEL_SERVICE_NAME: "checkout" } }];
    const entities = new Map([["api", mockResource("K8s::Core::Pod", { metadata: { name: "api" }, spec: podSpec(containers) })]]);
    const env = docs(serialize(entities, { workspace: "acme" }))[0].spec.containers[0].env;
    expect(env).toEqual({ PORT: "80", OTEL_SERVICE_NAME: "checkout", OTEL_RESOURCE_ATTRIBUTES: "chant.workspace=acme,chant.decl=api" });
  });

  test("an image pinned by digest gives service.version, per container", () => {
    const containers = [
      { name: "api", image: "ghcr.io/acme/api@sha256:abc123" },
      { name: "proxy", image: "envoyproxy/envoy:v1.31" },
    ];
    const entities = new Map([["api", mockResource("K8s::Apps::Deployment", { metadata: { name: "api" }, spec: { template: { spec: podSpec(containers) } } })]]);
    const [api, proxy] = docs(serialize(entities, { workspace: "acme" }))[0].spec.template.spec.containers;
    expect(valueOf(api.env, "OTEL_RESOURCE_ATTRIBUTES")).toBe("chant.workspace=acme,chant.decl=api,service.version=sha256%3Aabc123$(CHANT_RELEASE_ATTRIBUTES)");
    expect(valueOf(proxy.env, "OTEL_RESOURCE_ATTRIBUTES")).toBe("chant.workspace=acme,chant.decl=api$(CHANT_RELEASE_ATTRIBUTES)");
  });

  test("init containers, non-workload kinds and a CRD that reuses a workload kind name are not stamped", () => {
    const entities = new Map<string, unknown>([
      ["api", mockResource("K8s::Apps::Deployment", { metadata: { name: "api" }, spec: { template: { spec: { initContainers: [{ name: "init", image: "x" }], containers: [{ name: "api", image: "x" }] } } } })],
      ["svc", mockResource("K8s::Core::Service", { metadata: { name: "api" }, spec: { ports: [{ port: 80 }] } })],
      ["crd", mockResource("K8s::Apps::Deployment", { apiVersion: "example.com/v1", kind: "Deployment", metadata: { name: "x" }, spec: { template: { spec: podSpec([{ name: "x", image: "x" }]) } } })],
    ]);
    const out = docs(serialize(entities, attrs));
    const deployment = out.find((d) => d.apiVersion === "apps/v1")!;
    expect(deployment.spec.template.spec.initContainers[0].env).toBeUndefined();
    expect(deployment.spec.template.spec.containers[0].env).toHaveLength(3);
    expect(JSON.stringify(out.filter((d) => d !== deployment))).not.toContain("OTEL_");
  });

  test("a workload without metadata.name takes the name the serializer derives for it", () => {
    const entities = new Map([["worker", mockResource("K8s::Batch::Job", { spec: { template: { spec: podSpec([{ name: "w", image: "x" }]) } } })]]);
    const [doc] = docs(serialize(entities, { workspace: "acme" }));
    expect(doc.spec.template.spec.containers[0].env[0]).toEqual({ name: "OTEL_SERVICE_NAME", value: doc.metadata.name });
  });

  test("the release reference is added once, and the variable is always defined before it", () => {
    const containers = [
      { name: "a", image: "x", env: [{ name: "OTEL_RESOURCE_ATTRIBUTES", value: "team=pay$(CHANT_RELEASE_ATTRIBUTES)" }] },
      { name: "b", image: "x", env: [{ name: "CHANT_RELEASE_ATTRIBUTES", value: ",team=ops" }] },
    ];
    const entities = new Map([["api", mockResource("K8s::Apps::Deployment", { metadata: { name: "api" }, spec: { template: { spec: podSpec(containers) } } })]]);
    const [a, b] = docs(serialize(entities, { workspace: "acme" }))[0].spec.template.spec.containers;
    expect(valueOf(a.env, "OTEL_RESOURCE_ATTRIBUTES")).toBe("team=pay$(CHANT_RELEASE_ATTRIBUTES),chant.workspace=acme,chant.decl=api");
    // The reference is already there, but the variable still has to be defined before it.
    expect(a.env.map((e: Doc) => e.name)).toEqual(["CHANT_RELEASE_ATTRIBUTES", "OTEL_RESOURCE_ATTRIBUTES", "OTEL_SERVICE_NAME"]);
    // The container's own definition comes first, so the reference reads it.
    expect(b.env).toEqual([
      { name: "CHANT_RELEASE_ATTRIBUTES", value: ",team=ops" },
      { name: "OTEL_SERVICE_NAME", value: "api" },
      { name: "OTEL_RESOURCE_ATTRIBUTES", value: "chant.workspace=acme,chant.decl=api$(CHANT_RELEASE_ATTRIBUTES)" },
    ]);
  });
});
