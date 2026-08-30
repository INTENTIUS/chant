/**
 * Unit tests for the double-render localizer (#1236, epic #1228 Phase 1).
 *
 * Pure — no helm binary, no network. The render function is faked with the
 * shapes the survey corpus proved real: a generated secret cascading into a
 * checksum annotation in another template (finding 6, grafana), a generator
 * reachable only through an include chain whose supply slot lives at the
 * include site (grafana's `adminPassword` else branch), an existing-secret
 * gate (harbor's `existingSecret` family), and instability no generator
 * explains — which must surface as unlocalized, never silently pinnable.
 * The end-to-end run against real helm renders lives in the survey harness
 * (test/survey/survey.test.ts).
 */

import { describe, test, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { classifyChart } from "./classify";
import { diffRenderPair, localizeOpenInputs } from "./localize";

/** Materialize a chart directory from a { relPath: content } map. */
function mkChart(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-localize-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

const MINIMAL_CHART = "apiVersion: v2\nname: unit\ntype: application\nversion: 0.1.0\n";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const b64 = (s: string): string => Buffer.from(s).toString("base64");

describe("diffRenderPair", () => {
  test("identical renders diff to nothing", () => {
    const r = "---\n# Source: unit/templates/cm.yaml\nkind: ConfigMap\ndata:\n  a: 1";
    expect(diffRenderPair(r, r).size).toBe(0);
  });

  test("line identity is source + key, stable across probe runs", () => {
    const doc = (v: string): string =>
      `---\n# Source: unit/templates/secret.yaml\nkind: Secret\nmetadata:\n  name: app\ndata:\n  admin-password: ${v}`;
    const diff = diffRenderPair(doc("aaa"), doc("bbb"));
    expect(diff.size).toBe(1);
    const occ = [...diff.values()][0];
    expect(occ.doc).toBe("templates/secret.yaml");
    expect(occ.docId).toBe("Secret/app");
    expect(occ.key).toBe("admin-password");
    expect(occ.line).toBe(6); // 1-based within the split document
    // The same location diffs to the same identity with different content.
    expect([...diffRenderPair(doc("ccc"), doc("ddd")).keys()]).toEqual([...diff.keys()]);
  });

  test("a document present in one render only diffs on every line", () => {
    const stable = "---\n# Source: unit/templates/cm.yaml\nkind: ConfigMap\ndata:\n  a: 1";
    const extra = `${stable}\n---\n# Source: unit/templates/secret.yaml\nkind: Secret\ndata:\n  b: 2`;
    const diff = diffRenderPair(extra, stable);
    expect(diff.size).toBeGreaterThan(0);
    for (const occ of diff.values()) expect(occ.doc).toBe("templates/secret.yaml");
  });
});

describe("localizeOpenInputs", () => {
  const cascadeChart = (): string =>
    mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "values.yaml": 'adminPassword: ""\nexistingSecret: ""\n',
      "templates/secret.yaml": [
        "{{- if not .Values.existingSecret }}",
        "apiVersion: v1",
        "kind: Secret",
        "metadata:",
        "  name: app-admin",
        "data:",
        "  admin-password: {{ .Values.adminPassword | default (randAlphaNum 16) | b64enc }}",
        "{{- end }}",
      ].join("\n"),
      "templates/deployment.yaml": [
        "apiVersion: apps/v1",
        "kind: Deployment",
        "metadata:",
        "  name: app",
        "spec:",
        "  template:",
        "    metadata:",
        "      annotations:",
        '        checksum/secret: {{ include (print $.Template.BasePath "/secret.yaml") . | sha256sum }}',
      ].join("\n"),
    });

  /** Fake helm: fresh password per render unless pinned; the checksum derives. */
  function cascadeRender(): (pins: Record<string, string>) => string {
    let nonce = 0;
    return (pins) => {
      const pw = pins.adminPassword ?? `random-${nonce++}`;
      const gated = (pins.existingSecret ?? "") !== "";
      const docs: string[] = [];
      if (!gated) {
        docs.push(
          `# Source: unit/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: app-admin\ndata:\n  admin-password: ${b64(pw)}`,
        );
      }
      docs.push(
        `# Source: unit/templates/deployment.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: app\nspec:\n  template:\n    metadata:\n      annotations:\n        checksum/secret: ${sha(gated ? "" : pw)}`,
      );
      return `---\n${docs.join("\n---\n")}\n`;
    };
  }

  test("a generated secret and its derived checksum group under one input (finding 6)", () => {
    const chart = cascadeChart();
    const report = classifyChart(chart);
    const loc = localizeOpenInputs(chart, report, { render: cascadeRender() });

    expect(loc.deterministic).toBe(false);
    expect(loc.differingLines).toBe(2);
    expect(loc.inputs).toHaveLength(1);
    const input = loc.inputs[0];
    expect(input.fn).toBe("randAlphaNum");
    expect(input.file).toBe("templates/secret.yaml");
    expect(input.suppliable).toBe(true);
    expect(input.valuesPath).toBe("adminPassword");
    expect(input.suggestedPin).toBe("adminPassword: <generate once and supply>");
    // The chart-provided slot that also closes the generator is named.
    expect(input.existingSlots).toEqual(["existingSecret"]);

    const keys = input.occurrences.map((o) => `${o.key}${o.derived ? " (derived)" : ""}`);
    expect(keys).toContain("admin-password");
    // The checksum line lives in ANOTHER template — grouped under the same
    // root input, flagged derived. Hoisting the secret output alone would
    // leave it pointing at bytes that never deploy.
    expect(keys).toContain("checksum/secret (derived)");
    const checksum = input.occurrences.find((o) => o.key === "checksum/secret");
    expect(checksum?.doc).toBe("templates/deployment.yaml");
    expect(checksum?.docId).toBe("Deployment/app");

    expect(loc.unlocalized).toEqual([]);
    expect(loc.stableWithAllPins).toBe(true);
  });

  test("a stable double render confirms deterministic without probing", () => {
    const chart = cascadeChart();
    const report = classifyChart(chart);
    const loc = localizeOpenInputs(chart, report, {
      render: () =>
        "---\n# Source: unit/templates/secret.yaml\nkind: Secret\ndata:\n  admin-password: fixed\n",
    });
    expect(loc.deterministic).toBe(true);
    expect(loc.differingLines).toBe(0);
    expect(loc.unlocalized).toEqual([]);
    // Two base renders, zero probes.
    expect(loc.renders).toBe(2);
    // The statically-named input is still reported, with its supply path.
    expect(loc.inputs).toHaveLength(1);
    expect(loc.inputs[0].occurrences).toEqual([]);
    expect(loc.inputs[0].valuesPath).toBe("adminPassword");
  });

  test("a generator inside a define finds its supply slot at the include site", () => {
    // grafana's shape: `randAlphaNum` lives in a helper with no values in
    // reach; the `{{- if .Values.adminPassword }} ... {{- else }}` that
    // decides whether it runs sits where the helper is INCLUDED.
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "values.yaml": 'adminPassword: ""\n',
      "templates/_helpers.tpl": [
        '{{- define "unit.password" -}}',
        "{{- (randAlphaNum 40) | b64enc | quote }}",
        "{{- end }}",
      ].join("\n"),
      "templates/secret.yaml": [
        "apiVersion: v1",
        "kind: Secret",
        "metadata:",
        "  name: app",
        "data:",
        "{{- if .Values.adminPassword }}",
        "  admin-password: {{ .Values.adminPassword | b64enc }}",
        "{{- else }}",
        '  admin-password: {{ include "unit.password" . }}',
        "{{- end }}",
      ].join("\n"),
    });
    const report = classifyChart(chart);
    const site = report.closedInputs.find((c) => c.kind === "generated-value");
    expect(site?.suppliable).toBe(false); // statically: nothing in the action

    let nonce = 0;
    const loc = localizeOpenInputs(chart, report, {
      render: (pins) =>
        `---\n# Source: unit/templates/secret.yaml\napiVersion: v1\nkind: Secret\nmetadata:\n  name: app\ndata:\n  admin-password: ${b64(pins.adminPassword ?? `random-${nonce++}`)}\n`,
    });
    expect(loc.inputs).toHaveLength(1);
    // Dynamically: the include-chain pin validated.
    expect(loc.inputs[0].suppliable).toBe(true);
    expect(loc.inputs[0].valuesPath).toBe("adminPassword");
    expect(loc.inputs[0].suggestedPin).toBe("adminPassword: <generate once and supply>");
    expect(loc.inputs[0].occurrences.map((o) => o.key)).toEqual(["admin-password"]);
    expect(loc.unlocalized).toEqual([]);
    expect(loc.stableWithAllPins).toBe(true);
  });

  test("instability no generator explains is unlocalized, never silently pinnable", () => {
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "values.yaml": 'adminPassword: ""\n',
      "templates/secret.yaml":
        "kind: Secret\ndata:\n  admin-password: {{ .Values.adminPassword | default (randAlphaNum 16) | b64enc }}",
      "templates/cm.yaml": "kind: ConfigMap\ndata:\n  stamp: static",
    });
    const report = classifyChart(chart);
    let nonce = 0;
    const loc = localizeOpenInputs(chart, report, {
      render: (pins) =>
        [
          `---\n# Source: unit/templates/secret.yaml\nkind: Secret\nmetadata:\n  name: app\ndata:\n  admin-password: ${b64(pins.adminPassword ?? `random-${nonce++}`)}`,
          // Varies per render and maps to NO generator site (the template
          // holds none) — the localizer must not attribute it anywhere.
          `# Source: unit/templates/cm.yaml\nkind: ConfigMap\nmetadata:\n  name: app-cm\ndata:\n  stamp: ${nonce++}\n`,
        ].join("\n---\n"),
    });
    expect(loc.inputs[0].occurrences.map((o) => o.key)).toEqual(["admin-password"]);
    expect(loc.unlocalized).toHaveLength(1);
    expect(loc.unlocalized[0].doc).toBe("templates/cm.yaml");
    expect(loc.unlocalized[0].key).toBe("stamp");
    expect(loc.stableWithAllPins).toBe(false);
  });
});
