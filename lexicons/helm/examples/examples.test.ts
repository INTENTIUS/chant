import { expect } from "vitest";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { helmSerializer } from "@intentius/chant-lexicon-helm";

describeAllExamples(
  {
    lexicon: "helm",
    serializer: helmSerializer,
    outputKey: "helm",
    examplesDir: import.meta.dirname,
  },
  {
    "stateful-service": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("name: redis");
        expect(output).toContain("appVersion: '7.2.4'");
      },
    },
    "cron-job": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("name: db-backup");
        expect(output).toContain("apiVersion: v2");
      },
    },
    "multi-container": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("name: api-with-sidecar");
        expect(output).toContain("type: application");
      },
    },
    "web-app-with-ingress": { skipLint: true, skipBuild: true },
    "microservice-chart": { skipLint: true, skipBuild: true },
    "composites-basic": { skipLint: true, skipBuild: true },
    "composites-infrastructure": { skipLint: true, skipBuild: true },
    "composites-production": { skipLint: true, skipBuild: true },
    // HelmRender example — fetches a real upstream chart at build time, so
    // skip in CI (would require network + the helm CLI inside the test
    // sandbox). render.test.ts covers the codepath via a local chart.
    "helm-render-external-secrets": { skipLint: true, skipBuild: true },
  },
);
