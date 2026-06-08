import { expect } from "vitest";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { k8sSerializer } from "@intentius/chant-lexicon-k8s";

describeAllExamples(
  {
    lexicon: "k8s",
    serializer: k8sSerializer,
    outputKey: "k8s",
    examplesDir: import.meta.dirname,
  },
  {
    "basic-deployment": { skipLint: true },
    "layered-config": {
      // Layered config must lint clean — it is the example for the "one
      // composite, many environments" pattern, so the static-spread layering
      // must pass EVL.
      checks: (output) => {
        // One composite instantiated for three environments → distinct names.
        expect(output).toContain("name: web-dev");
        expect(output).toContain("name: web-staging");
        expect(output).toContain("name: web-prod");
        // Nested `labels` deep-merge: base label inherited everywhere, per-env
        // override present, and a prod-only key that dev/staging don't get.
        expect(output).toContain("app.kubernetes.io/part-of: acme-web");
        expect(output).toContain("acme.io/env: prod");
        expect(output).toContain("acme.io/tier: critical");
        // Only prod/staging declare an ingress host (dev inherits no ingress).
        expect(output).toContain("acme.example");
      },
    },
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
