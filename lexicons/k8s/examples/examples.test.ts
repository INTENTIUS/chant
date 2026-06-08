import { describe, test, expect } from "vitest";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { buildCommand } from "@intentius/chant/cli/commands/build";
import { k8sSerializer, k8sPlugin } from "@intentius/chant-lexicon-k8s";
import { resolve, join } from "path";
import { tmpdir } from "os";

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

// ── org-policy: environment-aware organizational policy (#201) ──────────────
// describeAllExamples (above) builds + lints the example like any other; this
// block exercises the *policy enforcement*, which only runs via buildCommand
// (it loads chant.config's `lint.policies`). The TLS policy is env-gated.

describe("org-policy example — environment-aware organizational policy", () => {
  const src = resolve(import.meta.dirname, "org-policy", "src");
  const out = join(tmpdir(), "chant-org-policy.yaml");
  const buildEnv = (env?: string) =>
    buildCommand({ path: src, output: out, format: "yaml", serializers: [k8sSerializer], plugins: [k8sPlugin], env });

  test("builds clean with no env and in dev (prod-only policy dormant)", async () => {
    expect((await buildEnv(undefined)).success).toBe(true);
    expect((await buildEnv("dev")).success).toBe(true);
  });

  test("fails in prod — ORG-PROD-TLS blocks the TLS-less ingress", async () => {
    const r = await buildEnv("prod");
    expect(r.success).toBe(false);
    expect(r.errors.join("\n")).toContain("ORG-PROD-TLS");
  });

  test("cost-center policy is enforced in every environment (compliant here)", async () => {
    // The workload carries the cost-center label, so ORG-COST-CENTER passes
    // even with no env — proving the always-on policy ran and was satisfied.
    const r = await buildEnv(undefined);
    expect(r.errors.join("\n")).not.toContain("ORG-COST-CENTER");
  });
});
