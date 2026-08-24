import { describe, test, expect } from "vitest";
import { normalizeObservation } from "@intentius/chant/observation";
import { describeResources } from "./describe-resources";
import { parseReleaseDocuments } from "./release-observe";
import type { HelmRunner } from "./release-observe";

const LIST = JSON.stringify([
  {
    name: "web-app",
    namespace: "prod",
    revision: "3",
    updated: "2026-08-01 10:00:00.000000000 +0000 UTC",
    status: "deployed",
    chart: "web-app-0.1.0",
    app_version: "1.0.0",
  },
]);

const MANIFEST = `---
# Source: web-app/templates/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web-app
  labels:
    app.kubernetes.io/managed-by: chant
    chant.intentius.io/stack: shop
    chant.intentius.io/env: prod
spec:
  replicas: 2
---
# Source: web-app/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: web-app
  namespace: elsewhere
spec:
  ports:
    - port: 80
---
# Source: web-app/crds/widgets.yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: widgets.example.com
`;

const HOOKS = `---
# Source: web-app/templates/migrate-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: web-app-migrate
  annotations:
    "helm.sh/hook": pre-install,pre-upgrade
    "helm.sh/hook-weight": "1"
    "helm.sh/hook-delete-policy": hook-succeeded
`;

/** A scripted helm CLI: canned stdout per subcommand, recorded commands. */
function scriptedHelm(
  outputs: { list?: string; manifest?: string; hooks?: string },
  commands: string[] = [],
): HelmRunner {
  return async (command) => {
    commands.push(command);
    if (command.startsWith("helm list")) return { stdout: outputs.list ?? "[]" };
    if (command.startsWith("helm get manifest")) {
      if (outputs.manifest === undefined) throw new Error("release: not found");
      return { stdout: outputs.manifest };
    }
    if (command.startsWith("helm get hooks")) {
      if (outputs.hooks === undefined) throw new Error("release: not found");
      return { stdout: outputs.hooks };
    }
    throw new Error(`unexpected command: ${command}`);
  };
}

const chartEntities = new Map([
  ["chart", { entityType: "Helm::Chart", props: { name: "web-app" } }],
  ["valuesSchema", { entityType: "Helm::Values", props: { replicaCount: 2 } }],
]);

const baseOptions = {
  environment: "prod",
  buildOutput: "",
  entityNames: [...chartEntities.keys()],
  entities: chartEntities,
};

describe("helm describeResources (#1246)", () => {
  test("reads BOTH channels: manifest resources and hook resources are rows", async () => {
    const commands: string[] = [];
    const result = await describeResources(baseOptions, scriptedHelm({ list: LIST, manifest: MANIFEST, hooks: HOOKS }, commands));
    const { resources, unobserved } = normalizeObservation(result);

    expect(commands.some((c) => c.startsWith("helm get manifest 'web-app' -n 'prod'"))).toBe(true);
    expect(commands.some((c) => c.startsWith("helm get hooks 'web-app' -n 'prod'"))).toBe(true);

    // The release row, keyed by the chart entity.
    expect(resources.chart).toMatchObject({
      type: "Helm::Release",
      physicalId: "prod/web-app",
      status: "deployed",
      ownership: "owned",
    });

    // Manifest channel: namespace-silent documents inherit the release
    // namespace; explicit namespaces are kept; cluster-scoped kinds get none.
    expect(resources["Deployment/prod/web-app"]).toMatchObject({
      type: "K8s::Apps::Deployment",
      attributes: expect.objectContaining({ channel: "manifest", release: "web-app" }),
    });
    expect(resources["Service/elsewhere/web-app"]).toBeDefined();
    expect(resources["cluster:CustomResourceDefinition/widgets.example.com"]).toBeDefined();

    // Hooks channel: excluded from `helm get manifest`, so this row only
    // exists because both channels were read.
    expect(resources["Job/prod/web-app-migrate"]).toMatchObject({
      type: "K8s::Batch::Job",
      attributes: expect.objectContaining({
        channel: "hooks",
        hook: "pre-install,pre-upgrade",
        hookWeight: "1",
        hookDeletePolicy: "hook-succeeded",
      }),
    });

    expect(unobserved).toEqual({});
  });

  test("every rendered resource is owned via release identity and a runtime child of its chart (#1077)", async () => {
    const result = await describeResources(baseOptions, scriptedHelm({ list: LIST, manifest: MANIFEST, hooks: HOOKS }));
    const { resources } = normalizeObservation(result);
    for (const key of ["Deployment/prod/web-app", "Service/elsewhere/web-app", "Job/prod/web-app-migrate"]) {
      expect(resources[key].ownership).toBe("owned");
      expect(resources[key].ownerChain).toEqual({ root: "declared", entity: "chart" });
    }
  });

  test("surfaces chant's stack/env marker verbatim where the rendered labels carry it (#1222)", async () => {
    const result = await describeResources(baseOptions, scriptedHelm({ list: LIST, manifest: MANIFEST, hooks: HOOKS }));
    const { resources } = normalizeObservation(result);
    expect(resources["Deployment/prod/web-app"].marker).toEqual({ stack: "shop", env: "prod" });
    expect(resources["Service/elsewhere/web-app"].marker).toBeUndefined();
  });

  test("chart-authoring satellites ride the single chart's release verdict", async () => {
    const present = normalizeObservation(
      await describeResources(baseOptions, scriptedHelm({ list: LIST, manifest: MANIFEST, hooks: HOOKS })),
    );
    expect(present.resources.valuesSchema).toMatchObject({
      type: "Helm::Values",
      status: "deployed",
      ownership: "owned",
    });

    // Release absent → chart AND satellites in neither map (create is right).
    const absent = normalizeObservation(await describeResources(baseOptions, scriptedHelm({ list: "[]" })));
    expect(absent.resources).toEqual({});
    expect(absent.unobserved).toEqual({});
  });

  test("missing helm binary: every declared entity is unobserved with no-credentials, never a clean empty snapshot", async () => {
    const result = await describeResources(baseOptions, async () => {
      throw Object.assign(new Error("/bin/sh: helm: command not found"), { code: 127 });
    });
    const { resources, unobserved } = normalizeObservation(result);
    expect(resources).toEqual({});
    expect(unobserved.chart.reason).toBe("no-credentials");
    expect(unobserved.valuesSchema.reason).toBe("no-credentials");
  });

  test("unreachable cluster (kubeconfig): no-credentials with the CLI's own words", async () => {
    const result = await describeResources(baseOptions, async () => {
      throw new Error('Error: Kubernetes cluster unreachable: Get "https://127.0.0.1:6443/version": connect: connection refused');
    });
    const { unobserved } = normalizeObservation(result);
    expect(unobserved.chart.reason).toBe("no-credentials");
  });

  test("an unreachable release is unobserved with a reason, never absent (#1246)", async () => {
    // `helm list` succeeds, `helm get manifest` fails.
    const result = await describeResources(baseOptions, scriptedHelm({ list: LIST }));
    const { resources, unobserved } = normalizeObservation(result);
    expect(resources.chart).toBeUndefined();
    expect(unobserved.chart.reason).toBe("read-failed");
    // The satellite shares the hole, with the same reason.
    expect(unobserved.valuesSchema.reason).toBe("read-failed");
  });

  test("a release deployed under another name resolves through its chart identity", async () => {
    const list = JSON.stringify([
      { name: "web-prod", namespace: "prod", status: "deployed", chart: "web-app-0.1.0", revision: "1" },
    ]);
    const { resources } = normalizeObservation(
      await describeResources(baseOptions, scriptedHelm({ list, manifest: MANIFEST, hooks: "" })),
    );
    expect(resources.chart).toMatchObject({ physicalId: "prod/web-prod" });
  });

  test("the deploy unit (`stack`) names the release for a single-chart project", async () => {
    const list = JSON.stringify([
      { name: "custom-name", namespace: "apps", status: "deployed", chart: "something-else-2.0.0" },
    ]);
    const { resources } = normalizeObservation(
      await describeResources(
        { ...baseOptions, stack: "apps/custom-name" },
        scriptedHelm({ list, manifest: "", hooks: "" }),
      ),
    );
    expect(resources.chart).toMatchObject({ physicalId: "apps/custom-name" });
  });

  test("the same release name in several namespaces is unobserved, not guessed and not absent", async () => {
    const list = JSON.stringify([
      { name: "web-app", namespace: "a", status: "deployed", chart: "web-app-0.1.0" },
      { name: "web-app", namespace: "b", status: "deployed", chart: "web-app-0.1.0" },
    ]);
    const { resources, unobserved } = normalizeObservation(
      await describeResources(baseOptions, scriptedHelm({ list })),
    );
    expect(resources.chart).toBeUndefined();
    expect(unobserved.chart.reason).toBe("read-failed");
    expect(unobserved.chart.detail).toContain("several namespaces");
  });

  test("--owned filters nothing and says so in a note — every row is release-scoped", async () => {
    const result = await describeResources(
      { ...baseOptions, owned: true },
      scriptedHelm({ list: LIST, manifest: MANIFEST, hooks: HOOKS }),
    );
    const { resources, notes } = normalizeObservation(result);
    expect(Object.keys(resources).length).toBeGreaterThan(0);
    expect(notes.some((n) => n.includes("--owned"))).toBe(true);
  });
});

describe("helm release document parsing", () => {
  test("tolerates comments, empty documents and non-object documents", () => {
    const rows = parseReleaseDocuments(
      `# just a comment\n---\n---\n"scalar"\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\n`,
      "manifest",
      "prod",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "ConfigMap/prod/cm", entityType: "K8s::Core::ConfigMap" });
  });

  test("unparseable YAML yields no rows rather than throwing", () => {
    expect(parseReleaseDocuments("{{ not yaml", "manifest", "prod")).toEqual([]);
  });
});
