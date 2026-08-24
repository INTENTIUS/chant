/**
 * Cross-lexicon lifecycle integration — Helm row (#1246/#1247, epic #1228).
 *
 * Drives the REAL helmPlugin through core's live-diff and change-set paths,
 * with the helm CLI faked at the PATH edge: a scripted `helm` shell double
 * answers `list`, `get manifest` and `get hooks` from canned fixtures, so the
 * plugin's own exec conventions (the same `helm …` command strings production
 * runs) are what execute. The deep path is exercised through the same release
 * plumbing with the k8s lexicon's fake cluster at the API edge — the seam the
 * k8s lexicon's own integration test replaces.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { helmPlugin } from "./plugin";
import { normalizeObservation } from "@intentius/chant/observation";
import { buildChangeSet } from "@intentius/chant/lifecycle/change-set";
import { diffLive } from "@intentius/chant/lifecycle/live-diff";
import { describeObservationConformance } from "@intentius/chant-test-utils";
import { describeResources } from "./describe-resources";
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
spec:
  replicas: 2
---
# Source: web-app/templates/service.yaml
apiVersion: v1
kind: Service
metadata:
  name: web-app
spec:
  ports:
    - port: 80
`;

const HOOKS = `---
# Source: web-app/templates/migrate-job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: web-app-migrate
  annotations:
    "helm.sh/hook": pre-install
    "helm.sh/hook-weight": "1"
`;

/** Write a scripted `helm` CLI double into its own dir and put it on PATH. */
function installHelmShim(fixtures: { list: string; manifest: string; hooks: string; fail?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-helm-shim-"));
  writeFileSync(join(dir, "list.json"), fixtures.list);
  writeFileSync(join(dir, "manifest.yaml"), fixtures.manifest);
  writeFileSync(join(dir, "hooks.yaml"), fixtures.hooks);
  const script = `#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
${fixtures.fail ? `echo "${fixtures.fail}" >&2; exit 1` : ""}
if [ "$1" = "list" ]; then cat "$DIR/list.json"; exit 0; fi
if [ "$1" = "get" ] && [ "$2" = "manifest" ]; then cat "$DIR/manifest.yaml"; exit 0; fi
if [ "$1" = "get" ] && [ "$2" = "hooks" ]; then cat "$DIR/hooks.yaml"; exit 0; fi
echo "helm shim: unexpected args: $*" >&2
exit 1
`;
  writeFileSync(join(dir, "helm"), script);
  chmodSync(join(dir, "helm"), 0o755);
  return dir;
}

const entities = new Map([
  ["chart", { entityType: "Helm::Chart", props: { name: "web-app" } }],
  ["valuesSchema", { entityType: "Helm::Values", props: { replicaCount: 2 } }],
]);
const declared = new Set(entities.keys());
const baseOptions = {
  environment: "prod",
  buildOutput: "",
  entityNames: [...entities.keys()],
  entities,
};

describe("helm lifecycle integration (#1246/#1247)", () => {
  const originalPath = process.env.PATH;
  let shimDirs: string[] = [];

  const useShim = (fixtures: Parameters<typeof installHelmShim>[0]): void => {
    const dir = installHelmShim(fixtures);
    shimDirs.push(dir);
    process.env.PATH = `${dir}:${originalPath}`;
  };

  beforeEach(() => {
    shimDirs = [];
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    for (const dir of shimDirs) rmSync(dir, { recursive: true, force: true });
  });

  test("lifecycle diff --live gains helm rows: real plugin, scripted helm CLI, both channels", async () => {
    useShim({ list: LIST, manifest: MANIFEST, hooks: HOOKS });

    const observed = normalizeObservation(await helmPlugin.describeResources!(baseOptions));

    // The release row and the per-resource rows, hook resource included —
    // the row `helm get manifest` alone can never produce.
    expect(observed.resources.chart).toMatchObject({ type: "Helm::Release", status: "deployed" });
    expect(observed.resources["Deployment/prod/web-app"]).toBeDefined();
    expect(observed.resources["Service/prod/web-app"]).toBeDefined();
    expect(observed.resources["Job/prod/web-app-migrate"]).toMatchObject({
      attributes: expect.objectContaining({ channel: "hooks", hook: "pre-install" }),
    });

    const diff = diffLive({ declared, observedNow: observed.resources, observedThen: undefined, unobserved: observed.unobserved });
    // Nothing declared is missing, and the rendered resources are expected
    // runtime — an unpinned release is not reported as drift (#1246).
    expect(diff.missing).toEqual([]);
    expect(diff.orphan).toEqual([]);
    expect(diff.runtimeChildren.map((r) => r.name).sort()).toEqual([
      "Deployment/prod/web-app",
      "Job/prod/web-app-migrate",
      "Service/prod/web-app",
    ]);
    expect(diff.runtimeChildren.every((r) => r.owner === "chart")).toBe(true);
  });

  test("change-set verdicts: present chart is noop, rendered resources are runtime, absent chart is create", async () => {
    useShim({ list: LIST, manifest: MANIFEST, hooks: HOOKS });
    const observed = normalizeObservation(await helmPlugin.describeResources!(baseOptions));
    const cs = buildChangeSet("prod", {
      declared,
      observedNow: observed.resources,
      observedThen: undefined,
      unobserved: observed.unobserved,
    });
    const byName = Object.fromEntries(cs.entries.map((e) => [e.name, e.action]));
    expect(byName.chart).toBe("noop");
    expect(byName.valuesSchema).toBe("noop");
    expect(byName["Deployment/prod/web-app"]).toBe("runtime");
    expect(byName["Job/prod/web-app-migrate"]).toBe("runtime");
  });

  test("a failing helm CLI is unobserved for every declared entity — never N creates", async () => {
    useShim({ list: "[]", manifest: "", hooks: "", fail: "Error: Kubernetes cluster unreachable" });
    const observed = normalizeObservation(await helmPlugin.describeResources!(baseOptions));
    expect(observed.resources).toEqual({});
    expect(observed.unobserved.chart.reason).toBe("no-credentials");

    const cs = buildChangeSet("prod", {
      declared,
      observedNow: observed.resources,
      observedThen: undefined,
      unobserved: observed.unobserved,
    });
    for (const entry of cs.entries) expect(entry.action).toBe("unobserved");
  });

  test("a missing helm binary is no-credentials, never a clean empty snapshot", async () => {
    const empty = mkdtempSync(join(tmpdir(), "chant-helm-nopath-"));
    shimDirs.push(empty);
    process.env.PATH = empty; // /bin/sh is exec'd absolutely; only `helm` resolution uses PATH
    const observed = normalizeObservation(await helmPlugin.describeResources!(baseOptions));
    expect(observed.resources).toEqual({});
    expect(observed.unobserved.chart.reason).toBe("no-credentials");
    expect(observed.unobserved.valuesSchema.reason).toBe("no-credentials");
  });

  test("the deep hook is declared and shares the k8s lexicon's normalization hooks (#1247)", async () => {
    expect(typeof helmPlugin.observeResourcesDeep).toBe("function");
    const { k8sDeepNormalizationHooks } = await import("@intentius/chant-lexicon-k8s/deep-observe-hooks");
    expect(helmPlugin.deepNormalizationHooks).toBe(k8sDeepNormalizationHooks);
  });
});

// The shared conformance suite (#1089) — every observing lexicon runs it.
// Scenarios drive the same describeResources the plugin dispatches to, with
// the CLI seam injected per scenario.
const scripted = (outputs: { list?: string; manifest?: string; hooks?: string; throwWith?: Error }): HelmRunner =>
  async (command) => {
    if (outputs.throwWith) throw outputs.throwWith;
    if (command.startsWith("helm list")) return { stdout: outputs.list ?? "[]" };
    if (command.startsWith("helm get manifest")) return { stdout: outputs.manifest ?? "" };
    if (command.startsWith("helm get hooks")) return { stdout: outputs.hooks ?? "" };
    throw new Error(`unexpected command: ${command}`);
  };

const conformanceEntities = new Map([["chart", { entityType: "Helm::Chart", props: { name: "web-app" } }]]);
const conformanceOptions = {
  environment: "prod",
  buildOutput: "",
  entityNames: ["chart"],
  entities: conformanceEntities,
};

const MARKED_MANIFEST = `---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-app-config
  labels:
    app.kubernetes.io/managed-by: chant
    chant.intentius.io/stack: shop
    chant.intentius.io/env: prod
data:
  key: value
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: unmarked-config
data:
  key: value
`;

describeObservationConformance({
  lexicon: "helm",
  ownershipChannel: helmPlugin.ownershipChannel,
  scenarios: [
    {
      name: "a healthy release read, both channels",
      declared: ["chart"],
      expectPresent: ["chart"],
      run: () => describeResources(conformanceOptions, scripted({ list: LIST, manifest: MANIFEST, hooks: HOOKS })),
    },
    {
      name: "helm binary missing alongside nothing else readable",
      declared: ["chart"],
      expectUnobserved: ["chart"],
      run: () =>
        describeResources(
          conformanceOptions,
          scripted({ throwWith: Object.assign(new Error("helm: command not found"), { code: 127 }) }),
        ),
    },
    {
      name: "an unreachable release (list succeeds, get fails)",
      declared: ["chart"],
      expectUnobserved: ["chart"],
      run: () =>
        describeResources(conformanceOptions, async (command) => {
          if (command.startsWith("helm list")) return { stdout: LIST };
          throw new Error("Error: release: not found");
        }),
    },
    {
      name: "a release helm was asked about and did not report",
      declared: ["chart"],
      expectAbsent: ["chart"],
      run: () => describeResources(conformanceOptions, scripted({ list: "[]" })),
    },
    {
      name: "an owned read resolves real verdicts — release identity is the marker",
      declared: ["chart"],
      expectPresent: ["chart"],
      owned: true,
      run: () =>
        describeResources(
          { ...conformanceOptions, owned: true },
          scripted({ list: LIST, manifest: MANIFEST, hooks: HOOKS }),
        ),
    },
    {
      name: "a marker-stamped rendered document surfaces its stack/env identity; an unmarked one surfaces none (#1222)",
      declared: ["chart"],
      expectPresent: ["chart", "ConfigMap/prod/web-app-config", "ConfigMap/prod/unmarked-config"],
      expectMarker: { "ConfigMap/prod/web-app-config": { stack: "shop", env: "prod" } },
      expectNoMarker: ["ConfigMap/prod/unmarked-config"],
      run: () => describeResources(conformanceOptions, scripted({ list: LIST, manifest: MARKED_MANIFEST, hooks: "" })),
    },
  ],
});
