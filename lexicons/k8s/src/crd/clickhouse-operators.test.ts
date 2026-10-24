/**
 * ClickHouse operator CRDs: ClickHouse Inc.'s (clickhouse.com) and Altinity's
 * (clickhouse.altinity.com, clickhouse-keeper.altinity.com). One resource of
 * each operator's main kind, plus the namespace split between the two.
 */

import { describe, test, expect } from "vitest";
import {
  ClickHouseCluster,
  KeeperCluster,
  ClickHouseInstallation,
  ClickHouseInstallationTemplate,
  ClickHouseKeeperInstallation,
  ClickHouseOperatorConfiguration,
} from "../generated";
import lexiconJson from "../generated/lexicon-k8s.json";
import { k8sSerializer } from "../serializer";
import { namespaceSegmentForGroup } from "../group-namespace";
import { parseYAML } from "@intentius/chant/yaml";

function synth(logicalName: string, resource: unknown): any {
  const yaml = k8sSerializer.serialize(new Map([[logicalName, resource as never]])) as string;
  return parseYAML(yaml);
}

describe("ClickHouse operator (clickhouse.com)", () => {
  test("ClickHouseCluster carries the apiVersion and kind", () => {
    const doc = synth(
      "analytics",
      new ClickHouseCluster({
        metadata: { name: "analytics", namespace: "data" },
        spec: { replicas: 2, shards: 1, keeperClusterRef: { name: "analytics-keeper" } },
      }),
    );
    expect(doc.apiVersion).toBe("clickhouse.com/v1alpha1");
    expect(doc.kind).toBe("ClickHouseCluster");
    expect(doc.metadata.name).toBe("analytics");
    expect(doc.spec.replicas).toBe(2);
    expect(doc.spec.keeperClusterRef).toEqual({ name: "analytics-keeper" });
  });

  test("KeeperCluster carries the apiVersion and kind", () => {
    const doc = synth(
      "analyticsKeeper",
      new KeeperCluster({ metadata: { name: "analytics-keeper" }, spec: { replicas: 3 } }),
    );
    expect(doc.apiVersion).toBe("clickhouse.com/v1alpha1");
    expect(doc.kind).toBe("KeeperCluster");
    expect(doc.spec.replicas).toBe(3);
  });
});

describe("Altinity ClickHouse operator (clickhouse.altinity.com)", () => {
  test("ClickHouseInstallation carries the apiVersion and kind", () => {
    const doc = synth(
      "analytics",
      new ClickHouseInstallation({
        metadata: { name: "analytics", namespace: "data" },
        spec: {
          configuration: {
            clusters: [{ name: "main", layout: { shardsCount: 1, replicasCount: 2 } }],
          },
        },
      }),
    );
    expect(doc.apiVersion).toBe("clickhouse.altinity.com/v1");
    expect(doc.kind).toBe("ClickHouseInstallation");
    expect(doc.spec.configuration.clusters[0].layout).toEqual({ shardsCount: 1, replicasCount: 2 });
  });

  test("the other three kinds keep their groups", () => {
    const kinds: Array<[unknown, string, string]> = [
      [new ClickHouseInstallationTemplate({ metadata: { name: "t" }, spec: {} }), "clickhouse.altinity.com/v1", "ClickHouseInstallationTemplate"],
      [new ClickHouseOperatorConfiguration({ metadata: { name: "c" }, spec: {} }), "clickhouse.altinity.com/v1", "ClickHouseOperatorConfiguration"],
      [new ClickHouseKeeperInstallation({ metadata: { name: "k" }, spec: {} }), "clickhouse-keeper.altinity.com/v1", "ClickHouseKeeperInstallation"],
    ];
    for (const [resource, apiVersion, kind] of kinds) {
      const doc = synth("r", resource);
      expect(doc.apiVersion).toBe(apiVersion);
      expect(doc.kind).toBe(kind);
    }
  });
});

describe("namespaces", () => {
  test("the two operators do not share one", () => {
    expect(namespaceSegmentForGroup("clickhouse.com")).toBe("ClickHouse");
    expect(namespaceSegmentForGroup("clickhouse.altinity.com")).toBe("Altinity");
    expect(namespaceSegmentForGroup("clickhouse-keeper.altinity.com")).toBe("Altinity");
  });

  test("every kind is generated under its operator's namespace", () => {
    const types = Object.values(lexiconJson as Record<string, { resourceType?: string }>).map((e) => e.resourceType);
    for (const t of [
      "K8s::ClickHouse::ClickHouseCluster",
      "K8s::ClickHouse::KeeperCluster",
      "K8s::Altinity::ClickHouseInstallation",
      "K8s::Altinity::ClickHouseInstallationTemplate",
      "K8s::Altinity::ClickHouseKeeperInstallation",
      "K8s::Altinity::ClickHouseOperatorConfiguration",
    ]) {
      expect(types).toContain(t);
    }
  });
});
