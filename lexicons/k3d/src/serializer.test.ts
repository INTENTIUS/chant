import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { k3dSerializer } from "./serializer";
import {
  Cluster,
  KubeconfigOptions,
  Options,
  Port,
  RuntimeOptions,
  Volume,
} from "./generated/index";
import type { Declarable } from "@intentius/chant/declarable";

function serializeOne(entities: Record<string, Declarable>): {
  text: string;
  doc: Record<string, unknown>;
} {
  const result = k3dSerializer.serialize(new Map(Object.entries(entities)));
  const text = typeof result === "string" ? result : result.primary;
  return { text, doc: load(text) as Record<string, unknown> };
}

describe("k3d serializer", () => {
  it("has the k3d name and K3D rule prefix", () => {
    expect(k3dSerializer.name).toBe("k3d");
    expect(k3dSerializer.rulePrefix).toBe("K3D");
  });

  it("emits apiVersion and kind literals even when undeclared", () => {
    const { doc } = serializeOne({ probe: new Cluster({ servers: 1 }) });
    expect(doc.apiVersion).toBe("k3d.io/v1alpha5");
    expect(doc.kind).toBe("Simple");
  });

  it("defaults metadata.name from the entity name and never overrides an explicit one", () => {
    const { doc } = serializeOne({ "my-cluster": new Cluster({ servers: 1 }) });
    expect((doc.metadata as Record<string, unknown>).name).toBe("my-cluster");

    const { doc: explicit } = serializeOne({
      probe: new Cluster({ servers: 1, metadata: { name: "elsewhere" } }),
    });
    expect((explicit.metadata as Record<string, unknown>).name).toBe("elsewhere");
  });

  it("keeps agents: 0 — zero is meaningful, not falsy", () => {
    const { text, doc } = serializeOne({ probe: new Cluster({ servers: 1, agents: 0 }) });
    expect(doc.agents).toBe(0);
    expect(text).toMatch(/^agents: 0$/m);
  });

  it("keeps booleans booleans", () => {
    const { text } = serializeOne({
      probe: new Cluster({
        servers: 1,
        options: new Options({
          kubeconfig: new KubeconfigOptions({
            updateDefaultKubeconfig: false,
            switchCurrentContext: false,
          }),
        }),
      }),
    });
    expect(text).toContain("updateDefaultKubeconfig: false");
    expect(text).not.toContain('"false"');
    expect(text).not.toContain("'false'");
  });

  it("injects chant's safe kubeconfig defaults when the declaration says nothing", () => {
    const { doc } = serializeOne({ probe: new Cluster({ servers: 1 }) });
    const options = doc.options as Record<string, Record<string, unknown>>;
    expect(options.kubeconfig).toEqual({
      updateDefaultKubeconfig: false,
      switchCurrentContext: false,
    });
  });

  it("passes a declared kubeconfig block through exactly as written", () => {
    const { doc } = serializeOne({
      probe: new Cluster({
        servers: 1,
        options: new Options({
          kubeconfig: new KubeconfigOptions({ updateDefaultKubeconfig: true }),
        }),
      }),
    });
    const options = doc.options as Record<string, Record<string, unknown>>;
    expect(options.kubeconfig).toEqual({ updateDefaultKubeconfig: true });
  });

  it("passes nodeFilters through untouched, k3d syntax and all", () => {
    const { doc } = serializeOne({
      probe: new Cluster({
        servers: 1,
        ports: [new Port({ port: "8080:80", nodeFilters: ["loadbalancer"] })],
        volumes: [new Volume({ volume: "/tmp/x:/x", nodeFilters: ["server:0", "agent:*"] })],
      }),
    });
    const ports = doc.ports as Array<Record<string, unknown>>;
    expect(ports[0].nodeFilters).toEqual(["loadbalancer"]);
    const volumes = doc.volumes as Array<Record<string, unknown>>;
    expect(volumes[0].nodeFilters).toEqual(["server:0", "agent:*"]);
  });

  it("round-trips: emitted YAML parses back to the declared values", () => {
    const declared = {
      servers: 3,
      agents: 2,
      image: "rancher/k3s:v1.31.4-k3s1",
      options: new Options({
        k3d: { disableLoadbalancer: true },
        runtime: new RuntimeOptions({
          labels: [
            { label: "app.kubernetes.io/managed-by=chant", nodeFilters: ["server:*"] },
          ],
        }),
      }),
    };
    const { doc } = serializeOne({ probe: new Cluster(declared) });
    expect(doc.servers).toBe(3);
    expect(doc.agents).toBe(2);
    expect(doc.image).toBe("rancher/k3s:v1.31.4-k3s1");
    const options = doc.options as Record<string, unknown>;
    expect((options.k3d as Record<string, unknown>).disableLoadbalancer).toBe(true);
    const runtime = options.runtime as Record<string, unknown>;
    expect(runtime.labels).toEqual([
      { label: "app.kubernetes.io/managed-by=chant", nodeFilters: ["server:*"] },
    ]);
  });

  it("stamps ownership as runtime labels on every node when the build carries a marker", () => {
    const result = k3dSerializer.serialize(
      new Map<string, Declarable>([["probe", new Cluster({ servers: 1 })]]),
      undefined,
      { ownership: { stack: "fountain", env: "local" } },
    );
    const text = typeof result === "string" ? result : result.primary;
    const doc = load(text) as Record<string, unknown>;
    const runtime = (doc.options as Record<string, Record<string, unknown>>).runtime;
    expect(runtime.labels).toEqual(
      expect.arrayContaining([
        { label: "app.kubernetes.io/managed-by=chant", nodeFilters: ["all"] },
        { label: "chant.intentius.io/stack=fountain", nodeFilters: ["all"] },
        { label: "chant.intentius.io/env=local", nodeFilters: ["all"] },
      ]),
    );
  });

  it("an author's own label with the marker key wins over the stamp", () => {
    const result = k3dSerializer.serialize(
      new Map<string, Declarable>([
        [
          "probe",
          new Cluster({
            servers: 1,
            options: new Options({
              runtime: new RuntimeOptions({
                labels: [{ label: "chant.intentius.io/stack=mine", nodeFilters: ["server:0"] }],
              }),
            }),
          }),
        ],
      ]),
      undefined,
      { ownership: { stack: "fountain", env: "local" } },
    );
    const text = typeof result === "string" ? result : result.primary;
    const doc = load(text) as Record<string, unknown>;
    const labels = (doc.options as Record<string, Record<string, unknown>>).runtime.labels as Array<
      Record<string, unknown>
    >;
    const stackLabels = labels.filter((l) => String(l.label).startsWith("chant.intentius.io/stack="));
    expect(stackLabels).toEqual([{ label: "chant.intentius.io/stack=mine", nodeFilters: ["server:0"] }]);
  });

  it("emits one document per cluster: first primary, the rest in files", () => {
    const result = k3dSerializer.serialize(
      new Map<string, Declarable>([
        ["first", new Cluster({ servers: 1 })],
        ["second", new Cluster({ servers: 1 })],
      ]),
    );
    expect(typeof result).not.toBe("string");
    if (typeof result !== "string") {
      expect(result.primary).toContain("name: first");
      expect(Object.keys(result.files ?? {})).toEqual(["second.k3d.yaml"]);
      expect(result.files?.["second.k3d.yaml"]).toContain("name: second");
    }
  });
});
