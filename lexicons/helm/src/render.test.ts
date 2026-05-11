import { describe, test, expect, beforeAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

import { HelmRender } from "./render";

const FIXTURE_DIR = join(tmpdir(), "chant-helm-render-fixture");
const CHART_DIR = join(FIXTURE_DIR, "tiny-chart");
const REPO_DIR = join(FIXTURE_DIR, "repo");

/**
 * Builds a tiny self-contained chart that emits one Deployment + one
 * Service, packages it as a local chart repo, and serves it via file://.
 * Avoids network access in tests.
 */
function maybeSetupFixture(): boolean {
  // If helm isn't on PATH, the test will be skipped at the call site.
  try {
    execFileSync("helm", ["version"], { stdio: "ignore" });
  } catch {
    return false;
  }

  if (existsSync(FIXTURE_DIR)) {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  }
  mkdirSync(join(CHART_DIR, "templates"), { recursive: true });
  mkdirSync(REPO_DIR, { recursive: true });

  writeFileSync(
    join(CHART_DIR, "Chart.yaml"),
    `apiVersion: v2
name: tiny-chart
description: Minimal chart for chant-lexicon-helm HelmRender tests
type: application
version: 0.1.0
appVersion: "1.0"
`,
  );

  writeFileSync(
    join(CHART_DIR, "values.yaml"),
    `replicaCount: 1
image:
  repository: nginx
  tag: "latest"
service:
  port: 80
`,
  );

  writeFileSync(
    join(CHART_DIR, "templates", "deployment.yaml"),
    `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Release.Name }}-tiny
spec:
  replicas: {{ .Values.replicaCount }}
  selector:
    matchLabels:
      app: {{ .Release.Name }}
  template:
    metadata:
      labels:
        app: {{ .Release.Name }}
    spec:
      containers:
      - name: app
        image: "{{ .Values.image.repository }}:{{ .Values.image.tag }}"
`,
  );

  writeFileSync(
    join(CHART_DIR, "templates", "service.yaml"),
    `apiVersion: v1
kind: Service
metadata:
  name: {{ .Release.Name }}-tiny
spec:
  selector:
    app: {{ .Release.Name }}
  ports:
  - port: {{ .Values.service.port }}
`,
  );

  // Package the chart into a .tgz and create a repo index.yaml.
  execFileSync("helm", ["package", CHART_DIR, "-d", REPO_DIR], { stdio: "ignore" });
  execFileSync("helm", ["repo", "index", REPO_DIR], { stdio: "ignore" });
  return true;
}

const fixtureAvailable = maybeSetupFixture();

describe.skipIf(!fixtureAvailable)("HelmRender", () => {
  beforeAll(() => {
    // Ensure fixture is fresh for the suite.
    expect(fixtureAvailable).toBe(true);
  });

  test("renders a local chart into K8s declarables (Deployment + Service)", () => {
    const result = HelmRender({
      name: "rel",
      chart: CHART_DIR,
      noCache: true,
    });

    // Composite returns its members under .members; iterate keys.
    const members = result.members as Record<string, unknown>;
    const keys = Object.keys(members);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    const deployment = keys.find((k) => k.startsWith("Deployment_"));
    const service = keys.find((k) => k.startsWith("Service_"));
    expect(deployment).toBeDefined();
    expect(service).toBeDefined();
  });

  test("createNamespace adds a Namespace declarable", () => {
    const result = HelmRender({
      name: "rel",
      chart: CHART_DIR,
      namespace: "myns",
      createNamespace: true,
      noCache: true,
    });
    const keys = Object.keys(result.members as Record<string, unknown>);
    expect(keys).toContain("__namespace");
  });

  test("values overrides are applied (replicaCount: 3)", () => {
    const result = HelmRender({
      name: "rel",
      chart: CHART_DIR,
      values: { replicaCount: 3 },
      noCache: true,
    });
    const members = result.members as Record<string, unknown>;
    const deploymentKey = Object.keys(members).find((k) => k.startsWith("Deployment_"));
    expect(deploymentKey).toBeDefined();
    const dep = members[deploymentKey!] as {
      props: { spec: { replicas: number } };
    };
    expect(dep.props.spec.replicas).toBe(3);
  });

  test("cache reuse: second render with same args skips helm CLI", () => {
    // First, render with cache enabled.
    const first = HelmRender({
      name: "rel",
      chart: CHART_DIR,
    });
    expect(Object.keys(first.members as Record<string, unknown>).length).toBeGreaterThanOrEqual(2);

    // Now sabotage `helm` by pointing PATH at an empty dir — if cache is used,
    // the second call should still succeed.
    const emptyDir = join(tmpdir(), "chant-helm-render-empty-path");
    if (!existsSync(emptyDir)) mkdirSync(emptyDir);
    const origPath = process.env.PATH;
    process.env.PATH = emptyDir;
    try {
      const second = HelmRender({
        name: "rel",
        chart: CHART_DIR,
      });
      expect(Object.keys(second.members as Record<string, unknown>).length).toBeGreaterThanOrEqual(2);
    } finally {
      process.env.PATH = origPath;
    }
  });
});
