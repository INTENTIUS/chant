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
    "namespace-rbac": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("kind: Namespace");
        expect(output).toContain("kind: ServiceAccount");
        expect(output).toContain("kind: Role");
        expect(output).toContain("kind: RoleBinding");
        expect(output).toContain("name: app-team");
      },
    },
    "ingress-tls": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("kind: Deployment");
        expect(output).toContain("kind: Service");
        expect(output).toContain("kind: Ingress");
        expect(output).toContain("tls:");
        expect(output).toContain("app.example.com");
      },
    },
    "cronjob-cleanup": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("kind: CronJob");
        expect(output).toContain("schedule:");
        expect(output).toContain("0 * * * *");
      },
    },
  },
);
