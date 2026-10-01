import { describe, expect, test } from "vitest";
import { load } from "js-yaml";
import type { Declarable } from "@intentius/chant/declarable";
import { collectorYaml } from "../collector";
import { validateCollectorEntities } from "../validate-config";
import { COLLECTOR_PIN } from "../define";
import { Pipeline, Service } from "../pipeline";
import { DebugExporter } from "./exporters";
import { K8sClusterReceiver } from "./k8s-receivers";
import { K8sLeaderElectorExtension, type K8sLeaderElectorExtensionConfig } from "./extensions";

function problems(component: Declarable): string[] {
  return validateCollectorEntities([component])
    .filter((i) => i.code === "OTEL107")
    .map((i) => i.message.replace(/^\w+ "[^"]+": /, ""));
}

const lease = { lease_name: "otel-k8s-cluster", lease_namespace: "observability" };

describe("k8s_leader_elector extension", () => {
  test("is a built-in pinned to the collector release", () => {
    expect(K8sLeaderElectorExtension.definition.kind).toBe("extension");
    expect(K8sLeaderElectorExtension.definition.type).toBe("k8s_leader_elector");
    expect(K8sLeaderElectorExtension.definition.builtin).toBe(true);
    expect(K8sLeaderElectorExtension.definition.pin).toBe(COLLECTOR_PIN);
  });

  test("a k8s_cluster receiver names it by componentId", () => {
    const elector = new K8sLeaderElectorExtension({ name: "cluster", auth_type: "serviceAccount", ...lease, lease_duration: "20s" });
    const cluster = new K8sClusterReceiver({ k8s_leader_elector: elector.componentId });
    const debug = new DebugExporter({});
    const yaml = collectorYaml([
      cluster,
      elector,
      debug,
      new Pipeline({ signal: "metrics", receivers: [cluster], exporters: [debug] }),
      new Service({ extensions: [elector] }),
    ]);
    expect(load(yaml)).toMatchObject({
      receivers: { k8s_cluster: { k8s_leader_elector: "k8s_leader_elector/cluster" } },
      extensions: {
        "k8s_leader_elector/cluster": { auth_type: "serviceAccount", lease_name: "otel-k8s-cluster", lease_namespace: "observability", lease_duration: "20s" },
      },
      service: { extensions: ["k8s_leader_elector/cluster"] },
    });
    expect(problems(elector)).toEqual([]);
  });

  test("needs lease_name and lease_namespace", () => {
    expect(problems(new K8sLeaderElectorExtension({ lease_name: "", lease_namespace: "obs" }))).toEqual([
      "lease_name and lease_namespace must be set",
    ]);
    expect(problems(new K8sLeaderElectorExtension({} as K8sLeaderElectorExtensionConfig))).toEqual([
      "lease_name and lease_namespace must be set",
    ]);
  });

  test("checks the durations the way client-go's leader elector does", () => {
    expect(problems(new K8sLeaderElectorExtension({ ...lease, lease_duration: "10s" }))).toEqual([
      "lease_duration must be greater than renew_deadline",
    ]);
    expect(problems(new K8sLeaderElectorExtension({ ...lease, renew_deadline: "2400ms" }))).toEqual([
      "renew_deadline must be greater than 1.2 times retry_period",
    ]);
    expect(problems(new K8sLeaderElectorExtension({ ...lease, retry_period: "0s" }))).toEqual(["retry_period must be positive"]);
    expect(problems(new K8sLeaderElectorExtension({ ...lease, lease_duration: "1m30s", renew_deadline: "1m", retry_period: "5s" }))).toEqual([]);
    // A value this can't read (an env reference) is left to the collector.
    expect(problems(new K8sLeaderElectorExtension({ ...lease, lease_duration: "${env:LEASE}" }))).toEqual([]);
  });
});
