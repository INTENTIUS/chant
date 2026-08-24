import { describe, test, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, mkdtempSync } from "node:fs";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

import { HelmRender, getHelmRenderRecords, clearHelmRenderRecords } from "./render";

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

  // CRDs shipped in the chart's crds/ directory — helm template drops these
  // unless --include-crds is passed.
  mkdirSync(join(CHART_DIR, "crds"), { recursive: true });
  writeFileSync(
    join(CHART_DIR, "crds", "widgets.yaml"),
    `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: widgets.example.com
spec:
  group: example.com
  names:
    kind: Widget
    listKind: WidgetList
    plural: widgets
    singular: widget
  scope: Namespaced
  versions:
  - name: v1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
`,
  );

  // A subchart with its own crds/ directory — must also survive the render.
  const SUBCHART_DIR = join(CHART_DIR, "charts", "tiny-sub");
  mkdirSync(join(SUBCHART_DIR, "crds"), { recursive: true });
  mkdirSync(join(SUBCHART_DIR, "templates"), { recursive: true });
  writeFileSync(
    join(SUBCHART_DIR, "Chart.yaml"),
    `apiVersion: v2
name: tiny-sub
description: Subchart fixture with its own CRD
type: application
version: 0.1.0
`,
  );
  writeFileSync(
    join(SUBCHART_DIR, "crds", "gadgets.yaml"),
    `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: gadgets.example.com
spec:
  group: example.com
  names:
    kind: Gadget
    listKind: GadgetList
    plural: gadgets
    singular: gadget
  scope: Namespaced
  versions:
  - name: v1
    served: true
    storage: true
    schema:
      openAPIV3Schema:
        type: object
`,
  );
  writeFileSync(
    join(SUBCHART_DIR, "templates", "configmap.yaml"),
    `apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ .Release.Name }}-tiny-sub
data:
  role: subchart
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

  test("CRDs from crds/ directories are included (top level + subchart)", () => {
    const result = HelmRender({
      name: "rel",
      chart: CHART_DIR,
      noCache: true,
    });
    const keys = Object.keys(result.members as Record<string, unknown>);
    expect(keys).toContain("CustomResourceDefinition_widgets_example_com");
    expect(keys).toContain("CustomResourceDefinition_gadgets_example_com");
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

/**
 * Capability-profile plumbing (#1235) — asserted against a scripted `helm`
 * double that records its argv, so these tests need no real helm binary, no
 * network, and no chart. The double answers any `helm template` with one
 * minimal manifest.
 */
describe("HelmRender capability profiles", () => {
  const FAKE_BIN = join(tmpdir(), "chant-helm-render-fake-bin");
  let argvFile: string;
  let origPath: string | undefined;
  let origCwd: string;

  beforeAll(() => {
    mkdirSync(FAKE_BIN, { recursive: true });
    writeFileSync(
      join(FAKE_BIN, "helm"),
      `#!/bin/sh
printf '%s\\n' "$@" > "$CHANT_TEST_HELM_ARGV"
cat <<'EOF'
apiVersion: v1
kind: ConfigMap
metadata:
  name: fake-render
EOF
`,
      { mode: 0o755 },
    );
  });

  beforeEach(() => {
    argvFile = join(mkdtempSync(join(tmpdir(), "chant-helm-argv-")), "argv.txt");
    process.env.CHANT_TEST_HELM_ARGV = argvFile;
    origPath = process.env.PATH;
    process.env.PATH = FAKE_BIN + delimiter + (origPath ?? "");
    origCwd = process.cwd();
    clearHelmRenderRecords();
  });

  afterEach(() => {
    process.env.PATH = origPath;
    delete process.env.CHANT_TEST_HELM_ARGV;
    process.chdir(origCwd);
  });

  function renderedArgv(): string[] {
    return readFileSync(argvFile, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
  }

  test("an inline profile pins --kube-version and one --api-versions per entry", () => {
    HelmRender({
      name: "rel",
      chart: "/dev/null/some-chart",
      noCache: true,
      capabilityProfile: {
        name: "prod",
        kubeVersion: "1.33.6",
        apiVersions: ["monitoring.coreos.com/v1", "cert-manager.io/v1"],
      },
    } as Parameters<typeof HelmRender>[0]);

    const argv = renderedArgv();
    const kvIdx = argv.indexOf("--kube-version");
    expect(kvIdx).toBeGreaterThan(-1);
    expect(argv[kvIdx + 1]).toBe("1.33.6");
    const apiIdxs = argv.map((a, i) => (a === "--api-versions" ? i : -1)).filter((i) => i >= 0);
    expect(apiIdxs.length).toBe(2);
    expect(argv[apiIdxs[0] + 1]).toBe("monitoring.coreos.com/v1");
    expect(argv[apiIdxs[1] + 1]).toBe("cert-manager.io/v1");
  });

  test("no profile means no capability flags — today's unpinned behavior", () => {
    HelmRender({
      name: "rel",
      chart: "/dev/null/some-chart",
      noCache: true,
    } as Parameters<typeof HelmRender>[0]);

    const argv = renderedArgv();
    expect(argv).not.toContain("--kube-version");
    expect(argv).not.toContain("--api-versions");
  });

  test("a profile named in chant.config.json resolves and pins the render", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "chant-helm-render-project-"));
    writeFileSync(
      join(projectDir, "chant.config.json"),
      JSON.stringify({
        helm: {
          capabilityProfiles: {
            prod: { kubeVersion: "v1.31.4", apiVersions: ["batch/v1"] },
          },
        },
      }),
    );
    process.chdir(projectDir);

    HelmRender({
      name: "rel",
      chart: "/dev/null/some-chart",
      noCache: true,
      capabilityProfile: "prod",
    } as Parameters<typeof HelmRender>[0]);

    const argv = renderedArgv();
    const kvIdx = argv.indexOf("--kube-version");
    expect(argv[kvIdx + 1]).toBe("v1.31.4");
    const apiIdx = argv.indexOf("--api-versions");
    expect(argv[apiIdx + 1]).toBe("batch/v1");
  });

  test("an undeclared profile reference is an error naming it, before helm runs", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "chant-helm-render-project-"));
    writeFileSync(
      join(projectDir, "chant.config.json"),
      JSON.stringify({ helm: { capabilityProfiles: { staging: { kubeVersion: "1.31.4" } } } }),
    );
    process.chdir(projectDir);

    expect(() =>
      HelmRender({
        name: "rel",
        chart: "/dev/null/some-chart",
        noCache: true,
        capabilityProfile: "prod",
      } as Parameters<typeof HelmRender>[0]),
    ).toThrow(/capability profile "prod" is not declared/);
    // Failed before any render: the double never ran.
    expect(existsSync(argvFile)).toBe(false);
  });

  test("an invalid inline profile is an error naming the field", () => {
    expect(() =>
      HelmRender({
        name: "rel",
        chart: "/dev/null/some-chart",
        noCache: true,
        capabilityProfile: { name: "prod", kubeVersion: "latest" },
      } as Parameters<typeof HelmRender>[0]),
    ).toThrow(/kubeVersion/);
  });

  test("the render record carries the profile identity for pinned renders, and none for unpinned", () => {
    HelmRender({
      name: "pinned",
      chart: "/dev/null/some-chart",
      noCache: true,
      capabilityProfile: { name: "prod", kubeVersion: "1.33.6", apiVersions: ["batch/v1"] },
    } as Parameters<typeof HelmRender>[0]);
    HelmRender({
      name: "unpinned",
      chart: "/dev/null/some-chart",
      noCache: true,
    } as Parameters<typeof HelmRender>[0]);

    const records = getHelmRenderRecords();
    expect(records.length).toBe(2);
    expect(records[0].name).toBe("pinned");
    expect(records[0].capabilityProfile).toEqual({
      name: "prod",
      kubeVersion: "1.33.6",
      apiVersions: ["batch/v1"],
    });
    expect(records[1].name).toBe("unpinned");
    expect(records[1].capabilityProfile).toBeUndefined();
  });
});
