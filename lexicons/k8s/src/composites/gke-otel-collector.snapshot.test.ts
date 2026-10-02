/**
 * GkeOtelCollector's rendered manifests, held to a snapshot (#2898).
 *
 * `OtelCollector`, `OtelCollectorGateway` and `GkeOtelCollector` share the
 * collector resources in `otel-collector-agent.ts`. The snapshot was recorded
 * before the gateway work touched that file, so any change to the GKE output
 * made through the shared code fails here. #2923 changed it on purpose: the
 * shared ClusterRole was narrowed to what k8sattributes and the config's
 * receivers need (see `agentClusterRules`).
 */
import { describe, expect, test } from "vitest";
import { expandComposite } from "@intentius/chant";
import { k8sSerializer } from "../serializer";
import { GkeOtelCollector } from "./gke-otel-collector";

function manifests(instance: ReturnType<typeof GkeOtelCollector>): string {
  const out = k8sSerializer.serialize(expandComposite("collector", instance));
  return typeof out === "string" ? out : out.primary;
}

describe("GkeOtelCollector output", () => {
  test("with Workload Identity", () => {
    expect(
      manifests(
        GkeOtelCollector({
          clusterName: "test-cluster",
          projectId: "test-project",
          gcpServiceAccountEmail: "otel@test-project.iam.gserviceaccount.com",
        }),
      ),
    ).toMatchSnapshot();
  });

  test("with every prop set", () => {
    expect(
      manifests(
        GkeOtelCollector({
          clusterName: "c1",
          projectId: "p-123456",
          name: "otel",
          namespace: "telemetry",
          image: "otel/opentelemetry-collector-contrib:0.100.0",
          labels: { team: "obs" },
          cpuRequest: "50m",
          memoryRequest: "128Mi",
          cpuLimit: "1",
          memoryLimit: "1Gi",
          defaults: { daemonSet: { spec: { updateStrategy: { type: "OnDelete" } } } },
        }),
      ),
    ).toMatchSnapshot();
  });
});
