import { expect } from "bun:test";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { k8sSerializer } from "@intentius/chant-lexicon-k8s";

describeAllExamples(
  {
    lexicon: "k8s",
    serializer: k8sSerializer,
    outputKey: "k8s",
    examplesDir: import.meta.dir,
  },
  {
    "basic-deployment": { skipLint: true },
    "statefulset": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("kind: StatefulSet");
        expect(output).toContain("kind: Service");
        expect(output).toContain("kind: PersistentVolumeClaim");
        expect(output).toContain("serviceName: postgres-headless");
      },
    },
    "configmap-secret": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("kind: ConfigMap");
        expect(output).toContain("kind: Secret");
        expect(output).toContain("kind: Deployment");
        expect(output).toContain("kind: Service");
        expect(output).toContain("LOG_LEVEL: info");
      },
    },
  },
);
