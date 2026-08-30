/**
 * Wrapper-chart materialization (#1242).
 *
 * The wrapper is what the pinned install path hands to `helm upgrade
 * --install`, so the tests pin its two safety properties: CRD-origin
 * documents land verbatim in `crds/` (uninstall-safe, epic finding 4), and
 * every other document ships byte-for-byte through a `.Files.Get` shim —
 * never placed directly in `templates/`, where helm would re-template
 * recorded bytes (alertmanager-style `{{ $labels }}` content is the live
 * case).
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { routeRender } from "./render-wrapper";
import { materializeWrapperChart, wrapperChartName } from "./wrapper-chart";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "chant-wrapper-chart-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stream = [
  "---",
  "# Source: umb/charts/kid/crds/kidcrd.yaml",
  "apiVersion: apiextensions.k8s.io/v1",
  "kind: CustomResourceDefinition",
  "metadata:",
  "  name: kidthings.example.com",
  "spec:",
  "  group: example.com",
  "  names:",
  "    kind: KidThing",
  "---",
  "# Source: umb/templates/hook-job.yaml",
  "apiVersion: batch/v1",
  "kind: Job",
  "metadata:",
  "  name: setup",
  "  annotations:",
  '    "helm.sh/hook": pre-install',
  "---",
  "# Source: umb/templates/cm.yaml",
  "apiVersion: v1",
  "kind: ConfigMap",
  "metadata:",
  "  name: alerts",
  "data:",
  '  template: "summary: {{ $labels.instance }} down"',
].join("\n");

describe("wrapperChartName", () => {
  test("keeps a bare chart name, sanitizes a local path, never returns empty", () => {
    expect(wrapperChartName("cert-manager")).toBe("cert-manager");
    expect(wrapperChartName("./charts/My_Web App")).toBe("my-web-app");
    expect(wrapperChartName("../")).toBe("pinned-chart");
  });
});

describe("materializeWrapperChart", () => {
  test("routes CRDs to crds/ verbatim and ships template docs through .Files.Get shims", () => {
    const routed = routeRender(stream, { chart: "umb", chartVersion: "0.1.0" });
    const wrapper = materializeWrapperChart(routed, dir);

    expect(wrapper.chartName).toBe("umb");
    expect(wrapper.chartVersion).toBe("0.1.0");

    const chartYaml = readFileSync(join(dir, "Chart.yaml"), "utf8");
    expect(chartYaml).toContain("name: umb");
    expect(chartYaml).toContain("version: 0.1.0");

    // CRD: verbatim bytes in crds/, where uninstall leaves them alone.
    expect(wrapper.crdFiles).toHaveLength(1);
    const crd = readFileSync(join(dir, wrapper.crdFiles[0]), "utf8");
    expect(crd).toBe(routed.crds[0].text + "\n");

    // Non-CRD docs: exact bytes in manifests/, one shim each in templates/.
    expect(wrapper.manifestFiles).toHaveLength(2);
    const manifestTexts = wrapper.manifestFiles.map((rel) => readFileSync(join(dir, rel), "utf8"));
    for (const doc of [...routed.main, ...routed.hooks]) {
      expect(manifestTexts).toContain(doc.text + "\n");
    }
    const shims = readdirSync(join(dir, "templates"));
    expect(shims).toHaveLength(2);
    for (const shim of shims) {
      const text = readFileSync(join(dir, "templates", shim), "utf8");
      expect(text).toMatch(/^\{\{ \.Files\.Get "manifests\/[a-z0-9-]+\.yaml" \}\}\n$/);
    }

    // The template-looking bytes survive untouched in the manifest file —
    // the reason the shim indirection exists.
    expect(manifestTexts.join("")).toContain("{{ $labels.instance }}");
    expect(wrapper.hookCount).toBe(1);
  });

  test("a CRD-only render writes no templates/ or manifests/ directories", () => {
    const crdOnly = stream.split("---").slice(0, 2).join("---");
    const routed = routeRender(crdOnly, { chart: "ops", chartVersion: null });
    const wrapper = materializeWrapperChart(routed, dir);
    expect(wrapper.chartVersion).toBe("0.0.0"); // helm needs a version; a version-less local render falls back
    expect(wrapper.manifestFiles).toHaveLength(0);
    expect(existsSync(join(dir, "templates"))).toBe(false);
    expect(existsSync(join(dir, "manifests"))).toBe(false);
  });
});
