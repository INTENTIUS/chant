import { describe, test, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, mkdtempSync } from "node:fs";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

import type { PostSynthContext } from "@intentius/chant/lint/post-synth";

import { HelmRender, getHelmRenderRecords, clearHelmRenderRecords } from "./render";
import { helmContentDigest, helmInputDigest, renderStability } from "./render-digest";
import { loadRenderManifest } from "./render-store";
import { clearValuesProbeRecords, getValuesProbeRecords } from "./values-probe";
import { whm504 } from "./lint/post-synth/whm504";

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

  test("CHANT_HELM_RENDER_ROOT redirects the unpinned cache — the air-gapped handoff (#2035)", () => {
    // Before #2035 the unprofiled path hardcoded ~/.chant/helm-renders and
    // honoured no environment variable, so a hermetic build had no way to be
    // handed a pre-rendered chart short of pre-warming $HOME.
    const root = mkdtempSync(join(tmpdir(), "chant-helm-render-root-"));
    const origRoot = process.env.CHANT_HELM_RENDER_ROOT;
    process.env.CHANT_HELM_RENDER_ROOT = root;
    try {
      const first = HelmRender({ name: "rel-rooted", chart: CHART_DIR });
      expect(Object.keys(first.members as Record<string, unknown>).length).toBeGreaterThanOrEqual(2);
      // The cache landed under the override, not under $HOME.
      const cached = readdirSync(root).filter((d) => !d.startsWith("_"));
      expect(cached.length).toBe(1);
      expect(existsSync(join(root, cached[0], "manifests.yaml"))).toBe(true);

      // A machine with no helm at all renders from the handed-over store.
      const emptyDir = join(tmpdir(), "chant-helm-render-empty-path");
      if (!existsSync(emptyDir)) mkdirSync(emptyDir);
      const origPath = process.env.PATH;
      process.env.PATH = emptyDir;
      try {
        const second = HelmRender({ name: "rel-rooted", chart: CHART_DIR });
        expect(Object.keys(second.members as Record<string, unknown>).length).toBeGreaterThanOrEqual(2);
      } finally {
        process.env.PATH = origPath;
      }
    } finally {
      if (origRoot === undefined) delete process.env.CHANT_HELM_RENDER_ROOT;
      else process.env.CHANT_HELM_RENDER_ROOT = origRoot;
      rmSync(root, { recursive: true, force: true });
    }
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

  test("digests are recorded only for pinned renders — unpinned renders record neither (#1237)", () => {
    HelmRender({
      name: "pinned",
      chart: "/dev/null/some-chart",
      noCache: true,
      capabilityProfile: { name: "prod", kubeVersion: "1.33.6" },
    } as Parameters<typeof HelmRender>[0]);
    HelmRender({
      name: "unpinned",
      chart: "/dev/null/some-chart",
      noCache: true,
    } as Parameters<typeof HelmRender>[0]);

    const [pinned, unpinned] = getHelmRenderRecords();
    expect(pinned.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pinned.inputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The double's output is fixed, so the content digest is the canonical
    // digest of that one ConfigMap — assert it against the canonicalizer.
    expect(pinned.contentDigest).toBe(
      helmContentDigest("apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: fake-render\n"),
    );
    expect(unpinned.contentDigest).toBeUndefined();
    expect(unpinned.inputDigest).toBeUndefined();
  });

  test("a pinned render's inputDigest is #1243's input digest for the same inputs", () => {
    HelmRender({
      name: "rel",
      chart: "/dev/null/some-chart",
      noCache: true,
      values: { replicaCount: 3 },
      capabilityProfile: { name: "prod", kubeVersion: "1.33.6", apiVersions: ["batch/v1"] },
    } as Parameters<typeof HelmRender>[0]);

    const [record] = getHelmRenderRecords();
    expect(record.inputDigest).toBe(
      helmInputDigest({
        chart: "/dev/null/some-chart",
        chartVersion: undefined,
        values: { replicaCount: 3 },
        capabilityProfile: { kubeVersion: "1.33.6", apiVersions: ["batch/v1"] },
      }),
    );
  });
});

/**
 * Digest behavior against real helm renders of the deterministic fixture
 * (#1237). Pinning uses an inline profile so `helm template` runs with
 * `--kube-version` — the same invocation shape a config-declared profile
 * produces.
 */
describe.skipIf(!fixtureAvailable)("HelmRender digests (real helm)", () => {
  const PROFILE = { name: "test", kubeVersion: "1.33.6" };

  beforeEach(() => {
    clearHelmRenderRecords();
  });

  test("two pinned renders of the deterministic fixture agree on both digests", () => {
    for (const name of ["rel", "rel"]) {
      HelmRender({
        name,
        chart: CHART_DIR,
        noCache: true,
        capabilityProfile: PROFILE,
      } as Parameters<typeof HelmRender>[0]);
    }
    const [first, second] = getHelmRenderRecords();
    expect(first.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.contentDigest).toBe(second.contentDigest);
    expect(first.inputDigest).toBe(second.inputDigest);

    const report = renderStability(getHelmRenderRecords());
    expect(report.unstable).toEqual([]);
    expect(report.stable.length).toBe(1);
    expect(report.stable[0].names).toEqual(["rel", "rel"]);
  });

  test("a values change moves contentDigest and inputDigest together", () => {
    for (const replicaCount of [1, 3]) {
      HelmRender({
        name: "rel",
        chart: CHART_DIR,
        noCache: true,
        values: { replicaCount },
        capabilityProfile: PROFILE,
      } as Parameters<typeof HelmRender>[0]);
    }
    const [one, three] = getHelmRenderRecords();
    expect(one.contentDigest).not.toBe(three.contentDigest);
    expect(one.inputDigest).not.toBe(three.inputDigest);
    // Different inputs — no stability claim to make, and no false alarm.
    expect(renderStability(getHelmRenderRecords()).unstable).toEqual([]);
  });

  test("same inputs, different bytes — renderStability names the divergence", () => {
    HelmRender({
      name: "rel",
      chart: CHART_DIR,
      noCache: true,
      capabilityProfile: PROFILE,
    } as Parameters<typeof HelmRender>[0]);
    const [genuine] = getHelmRenderRecords();
    // A second record with the same inputs but different bytes — the shape an
    // unstable chart (randAlphaNum, timestamps) produces. The fixture is
    // deliberately deterministic, so fabricate the divergent twin.
    const divergent = { ...genuine, contentDigest: "sha256:" + "0".repeat(64) };
    const report = renderStability([genuine, divergent]);
    expect(report.stable).toEqual([]);
    expect(report.unstable.length).toBe(1);
    expect(report.unstable[0].inputDigest).toBe(genuine.inputDigest);
    expect(report.unstable[0].contentDigests).toEqual([genuine.contentDigest, divergent.contentDigest]);
  });
});

/**
 * End-to-end coalesced-values wiring (#1251, #1252): a real pinned build of
 * the fixture chart carries the probe's digest and valueSources into its
 * persisted `RenderManifest` (issue #1252 AC1), and a dead assignment in
 * the supplied values produces a WHM504 finding through the same real
 * build — not a hand-built probe record (AC3).
 */
describe.skipIf(!fixtureAvailable)("coalesced-values probe wired into the render path (#1251, #1252)", () => {
  const PROFILE = { name: "test", kubeVersion: "1.33.6" };
  let storeRoot: string;
  let origRoot: string | undefined;

  function makeCtx(): PostSynthContext {
    const outputs = new Map<string, string>();
    return {
      outputs,
      entities: new Map(),
      buildResult: { outputs, entities: new Map(), warnings: [], errors: [], sourceFileCount: 1 },
    };
  }

  beforeEach(() => {
    clearHelmRenderRecords();
    clearValuesProbeRecords();
    storeRoot = mkdtempSync(join(tmpdir(), "chant-helm-render-store-"));
    origRoot = process.env.CHANT_HELM_RENDER_ROOT;
    process.env.CHANT_HELM_RENDER_ROOT = storeRoot;
  });

  afterEach(() => {
    if (origRoot === undefined) delete process.env.CHANT_HELM_RENDER_ROOT;
    else process.env.CHANT_HELM_RENDER_ROOT = origRoot;
    rmSync(storeRoot, { recursive: true, force: true });
  });

  test("a pinned build of a clean chart records a digest and valueSources in the persisted RenderManifest", () => {
    HelmRender({
      name: "rel",
      chart: CHART_DIR,
      persist: true,
      values: { replicaCount: 3 },
      capabilityProfile: PROFILE,
    } as Parameters<typeof HelmRender>[0]);

    const [record] = getHelmRenderRecords();
    expect(record.coalescedValuesDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const manifest = loadRenderManifest(record.contentDigest!, { root: storeRoot });
    expect(manifest).toBeDefined();
    expect(manifest!.coalescedValuesDigest).toBe(record.coalescedValuesDigest);
    expect(manifest!.valueSources).toBeTruthy();
    // The supplied override is attributed to the values layer that won it.
    expect(manifest!.valueSources!["replicaCount"]).toBe("supplied file");

    // No dead assignments in this build — WHM504 has nothing to say.
    expect(getValuesProbeRecords()).toHaveLength(1);
    expect(whm504.check(makeCtx())).toEqual([]);
  });

  test("a dead assignment in a real pinned build fires WHM504 end-to-end", () => {
    HelmRender({
      name: "rel",
      chart: CHART_DIR,
      persist: true,
      // "totallyUnknownSubchart" names no dependency of the fixture chart
      // (which has the "tiny-sub" subchart, so it does have dependencies)
      // and no root default — the classic silently-ignored subchart typo.
      values: { totallyUnknownSubchart: { replicas: 9 } },
      capabilityProfile: PROFILE,
    } as Parameters<typeof HelmRender>[0]);

    const [record] = getHelmRenderRecords();
    expect(record.coalescedValuesDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const manifest = loadRenderManifest(record.contentDigest!, { root: storeRoot });
    expect(manifest!.coalescedValuesDigest).toBe(record.coalescedValuesDigest);

    // The real build path recorded the probe — WHM504 fires without any
    // test constructing a probe record by hand.
    expect(getValuesProbeRecords()).toHaveLength(1);
    const diags = whm504.check(makeCtx());
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("WHM504");
    expect(diags[0].entity).toBe("rel");
    expect(diags[0].message).toContain("totallyUnknownSubchart");
    expect(diags[0].message).toContain("target no subchart");
  });
});
