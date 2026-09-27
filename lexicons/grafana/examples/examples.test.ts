import { expect } from "vitest";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { grafanaSerializer, type GrafanaIndex } from "@intentius/chant-lexicon-grafana";

describeAllExamples(
  {
    lexicon: "grafana",
    serializer: grafanaSerializer,
    outputKey: "grafana",
    examplesDir: import.meta.dirname,
  },
  {
    "getting-started": {
      checks: (output) => {
        const index = JSON.parse(output) as GrafanaIndex;
        expect(index.dashboards).toEqual([
          { uid: "service-overview", title: "Service overview", folder: "Services", file: "dashboards/Services/service-overview.json" },
        ]);
        expect(index.datasources.map((d) => `${d.name}:${d.type}:${d.uid}`)).toEqual(["Loki:loki:loki", "Prometheus:prometheus:prometheus", "Tempo:tempo:tempo"]);
        expect(index.files).toEqual([
          "dashboards/Services/service-overview.json",
          "provisioning/dashboards/chant.yaml",
          "provisioning/datasources/chant.yaml",
        ]);
      },
    },
  },
);
