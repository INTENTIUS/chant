/**
 * Unit tests for the pinnability classifier (#1234, epic #1228 Phase 1).
 *
 * Pure — no helm binary, no network. The two prototype-era regressions stay
 * pinned here (finding 9: actions not text; finding 10: crds/ segment not
 * prefix), plus the capability the promotion added: values-aware
 * reachability — a control-flow `lookup` behind a gate the supplied values
 * close is a recorded hazard, not a refusal, and flipping the value
 * re-classifies the (chart, values) pair.
 */

import { describe, test, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { extractActions, scopeActions } from "./actions";
import { UNKNOWN, callReachability, evaluateCondition, truthy } from "./conditions";
import { buildChartInstances, mergeValues } from "./values";
import { classifyChart } from "./classify";
import { countDifferingLines, isCrdSource, routeBySource } from "./render-stream";

/** Materialize a chart directory from a { relPath: content } map. */
function mkChart(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-pinnability-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

const MINIMAL_CHART = 'apiVersion: v2\nname: unit\ntype: application\nversion: 0.1.0\n';

describe("lookup detection parses template actions, not text (finding 9)", () => {
  test("prose in YAML comments is not a lookup hit", () => {
    // cert-manager has 52 textual "lookup" occurrences, all comment prose,
    // real template-action count 0. A text-matching gate refuses a chart
    // that is perfectly pinnable.
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "templates/cm.yaml": [
        "# the keys are used to lookup values from secrets",
        "apiVersion: v1",
        "kind: ConfigMap",
        "metadata:",
        "  name: {{ .Release.Name }}-cm",
      ].join("\n"),
    });
    const report = classifyChart(chart);
    expect(report.lookups.controlFlow).toEqual([]);
    expect(report.lookups.valuePosition).toEqual([]);
    expect(report.verdict).toBe("deterministic");
  });

  test("prose in template comment actions is not a lookup hit", () => {
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "templates/x.yaml": '{{/* lookup is documented here, not called */}}\nname: {{ .Values.name }}',
    });
    const report = classifyChart(chart);
    expect(report.lookups.controlFlow).toEqual([]);
    expect(report.lookups.valuePosition).toEqual([]);
  });

  test("a value named lookup* is not a lookup call", () => {
    // grafana's `persistence.lookupVolumeName` — the value is named after
    // the feature; only the function call counts (survey finding 2:
    // \blookup\b would false-positive on the very chart the refusal is about).
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "templates/pvc.yaml": "{{- if .Values.persistence.lookupVolumeName }}\nx: 1\n{{- end }}",
    });
    const report = classifyChart(chart);
    expect(report.lookups.controlFlow).toEqual([]);
    expect(report.lookups.valuePosition).toEqual([]);
  });

  test("lookup in an if action is control flow; in an output action it is value position", () => {
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "templates/cm.yaml": [
        '{{- if not (lookup "v1" "ConfigMap" "ns" "seen") }}',
        "kind: ConfigMap",
        "{{- end }}",
        'prior: {{ (lookup "v1" "Namespace" "" "default").metadata.name | default "none" }}',
      ].join("\n"),
    });
    const report = classifyChart(chart);
    expect(report.verdict).toBe("unpinnable");
    expect(report.lookups.controlFlow).toHaveLength(1);
    expect(report.lookups.controlFlow[0].line).toBe(1);
    expect(report.lookups.controlFlow[0].status).toBe("refused");
    expect(report.lookups.valuePosition).toHaveLength(1);
    expect(report.lookups.valuePosition[0].line).toBe(4);
    // The refusal is specific: construct and location.
    expect(report.reasons[0]).toContain("templates/cm.yaml:1");
  });
});

describe("CRD routing matches a crds/ segment, not prefix (finding 10)", () => {
  test("subchart CRD paths are CRD sources", () => {
    expect(isCrdSource("crds/topcrd.yaml")).toBe(true);
    expect(isCrdSource("charts/kid/crds/kidcrd.yaml")).toBe(true);
    expect(isCrdSource("charts/kidtwo/crds/kidcrd.yaml")).toBe(true);
  });

  test("templates paths are not, even when a file is named after crds", () => {
    expect(isCrdSource("templates/cm.yaml")).toBe(false);
    expect(isCrdSource("charts/kid/templates/cm.yaml")).toBe(false);
    expect(isCrdSource("templates/crds-readme.yaml")).toBe(false);
  });

  test("routeBySource splits a stream by origin", () => {
    const rendered = [
      "---",
      "# Source: umb/crds/parent.yaml",
      "kind: CustomResourceDefinition",
      "---",
      "# Source: umb/charts/kid/crds/kid.yaml",
      "kind: CustomResourceDefinition",
      "---",
      "# Source: umb/templates/cm.yaml",
      "kind: ConfigMap",
    ].join("\n");
    const routed = routeBySource(rendered);
    expect(routed.crds).toHaveLength(2);
    expect(routed.templates).toHaveLength(1);
  });

  test("countDifferingLines is 0 for identical renders and symmetric otherwise", () => {
    expect(countDifferingLines("a\nb", "a\nb")).toBe(0);
    expect(countDifferingLines("a\nx", "a\ny")).toBe(2);
  });
});

describe("condition evaluation", () => {
  const ctx = {
    values: { persistence: { enabled: false, type: "pvc", lookupVolumeName: true }, replicas: 0 },
    scope: [],
    dotValuesPath: null,
  } as const;

  test("Go truthiness: false, zero, empty string/collection are false", () => {
    expect(truthy(false)).toBe(false);
    expect(truthy(0)).toBe(false);
    expect(truthy("")).toBe(false);
    expect(truthy([])).toBe(false);
    expect(truthy({})).toBe(false);
    expect(truthy(undefined)).toBe(false);
    expect(truthy("no")).toBe(true); // a non-empty string, even "no", is truthy
    expect(truthy([0])).toBe(true);
  });

  test("a false values path names itself as the gate", () => {
    const r = evaluateCondition(".Values.persistence.enabled", ctx);
    expect(r.value).toBe(false);
    expect(r.gates).toEqual([{ path: "persistence.enabled", value: false }]);
  });

  test("grafana's outer pvc gate resolves false through and/not/eq", () => {
    const r = evaluateCondition(
      'and (not .Values.useStatefulSet) .Values.persistence.enabled (not .Values.persistence.existingClaim) (eq .Values.persistence.type "pvc")',
      ctx,
    );
    expect(r.value).toBe(false);
    expect(r.gates.map((g) => g.path)).toEqual(["persistence.enabled"]);
  });

  test("missing keys are nil and nil is false — helm's own semantics", () => {
    expect(evaluateCondition(".Values.not.there", ctx).value).toBe(false);
  });

  test("what the grammar cannot resolve is UNKNOWN, and unknown refuses rather than pins", () => {
    expect(evaluateCondition('include "chart.enabled" .', ctx).value).toBe(UNKNOWN);
    expect(evaluateCondition(".Values.replicas | mul 2", ctx).value).toBe(UNKNOWN);
    // ...but a known-false conjunct still decides an `and` containing unknowns.
    const r = evaluateCondition('and (include "x" .) .Values.persistence.enabled', ctx);
    expect(r.value).toBe(false);
  });

  test("pipeline default: a truthy value closes over the fallback", () => {
    expect(evaluateCondition(".Values.persistence.type | default \"none\"", ctx).value).toBe(true);
    expect(evaluateCondition(".Values.missing | default true", ctx).value).toBe(true);
    expect(evaluateCondition(".Values.missing | default false", ctx).value).toBe(false);
  });

  test("scope prefixes gate paths into root coordinates", () => {
    const r = evaluateCondition(".Values.persistence.enabled", { ...ctx, scope: ["grafana"] });
    expect(r.gates[0].path).toBe("grafana.persistence.enabled");
  });

  test("short-circuit reachability of a call inside and/or", () => {
    const lookupRe = /^lookup$/;
    // `and gate (lookup ...)` — a false gate before the call skips it.
    const gated = callReachability('and .Values.persistence.enabled (lookup "v1" "X" "" "y")', lookupRe, ctx);
    expect(gated.reachable).toBe(false);
    expect(gated.gates[0].path).toBe("persistence.enabled");
    // A true gate leaves the call live.
    const live = callReachability('and .Values.persistence.lookupVolumeName (lookup "v1" "X" "" "y")', lookupRe, ctx);
    expect(live.reachable).toBe(true);
    // `or` skips the call when an earlier operand is true.
    const orGated = callReachability('or .Values.persistence.lookupVolumeName (lookup "v1" "X" "" "y")', lookupRe, ctx);
    expect(orGated.reachable).toBe(false);
    // An unresolvable earlier operand never proves the call unreachable.
    const unknown = callReachability('and (include "x" .) (lookup "v1" "X" "" "y")', lookupRe, ctx);
    expect(unknown.reachable).toBe(true);
  });
});

describe("value coalescing and the chart instance tree", () => {
  test("mergeValues: parent overrides child, null deletes, arrays replace", () => {
    expect(mergeValues({ a: { b: 1, c: 2 } }, { a: { b: 9 } })).toEqual({ a: { b: 9, c: 2 } });
    expect(mergeValues({ a: 1, b: 2 }, { b: null })).toEqual({ a: 1 });
    expect(mergeValues({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  test("aliased dependencies get their own scope over one directory; conditions disable", () => {
    const chart = mkChart({
      "Chart.yaml": [
        "apiVersion: v2",
        "name: umb",
        "version: 0.1.0",
        "dependencies:",
        "  - name: kid",
        "    version: 0.1.0",
        "  - name: kid",
        "    version: 0.1.0",
        "    alias: kidtwo",
        "  - name: opt",
        "    version: 0.1.0",
        "    condition: opt.enabled",
      ].join("\n"),
      "values.yaml": "opt:\n  enabled: false\nkidtwo:\n  mode: aliased\n",
      "charts/kid/Chart.yaml": "apiVersion: v2\nname: kid\nversion: 0.1.0\n",
      "charts/kid/values.yaml": "mode: plain\n",
      "charts/kid/templates/cm.yaml": "x: {{ .Values.mode }}",
      "charts/opt/Chart.yaml": "apiVersion: v2\nname: opt\nversion: 0.1.0\n",
      "charts/opt/templates/cm.yaml": "x: 1",
    });
    const { instances, warnings } = buildChartInstances(chart);
    expect(warnings).toEqual([]);
    const byScope = new Map(instances.map((i) => [i.scope.join("."), i]));
    expect([...byScope.keys()].sort()).toEqual(["", "kid", "kidtwo", "opt"]);
    // Alias scoping: each instance sees its own value tree over the same dir.
    expect((byScope.get("kid")!.values as { mode: string }).mode).toBe("plain");
    expect((byScope.get("kidtwo")!.values as { mode: string }).mode).toBe("aliased");
    expect(byScope.get("kidtwo")!.dir).toBe(byScope.get("kid")!.dir);
    // The conditional dependency is disabled by the root values (finding 12).
    expect(byScope.get("opt")!.disabledBy).toBe("opt.enabled");
  });

  test("globals propagate into subchart trees", () => {
    const chart = mkChart({
      "Chart.yaml": "apiVersion: v2\nname: umb\nversion: 0.1.0\n",
      "values.yaml": "global:\n  region: eu\n",
      "charts/kid/Chart.yaml": "apiVersion: v2\nname: kid\nversion: 0.1.0\n",
      "charts/kid/templates/cm.yaml": "x: 1",
    });
    const { instances } = buildChartInstances(chart);
    const kid = instances.find((i) => i.scope.join(".") === "kid")!;
    expect((kid.values as { global: { region: string } }).global.region).toBe("eu");
  });

  test("an unvendored dependency is a warning, never a silent pass", () => {
    const chart = mkChart({
      "Chart.yaml": [
        "apiVersion: v2",
        "name: umb",
        "version: 0.1.0",
        "dependencies:",
        "  - name: ghost",
        "    version: 1.0.0",
      ].join("\n"),
      "templates/cm.yaml": "x: 1",
    });
    const report = classifyChart(chart);
    expect(report.warnings.join(" ")).toContain("ghost");
    expect(report.reasons.join(" ")).toContain("not scanned");
  });
});

describe("values-aware reachability (the epic's core insight: pinnability is a property of (chart, values))", () => {
  const gatedPvc = [
    "{{- if and .Values.persistence.enabled (not .Values.persistence.existingClaim) }}",
    "kind: PersistentVolumeClaim",
    '{{- if and (.Values.persistence.lookupVolumeName) (lookup "v1" "PersistentVolumeClaim" "ns" "n") }}',
    "volumeName: pinned",
    "{{- end }}",
    "{{- end }}",
  ].join("\n");

  function gatedChart(): string {
    return mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "values.yaml": "persistence:\n  enabled: false\n  lookupVolumeName: true\n",
      "templates/pvc.yaml": gatedPvc,
    });
  }

  test("a control-flow lookup the supplied values gate off is a hazard, not a refusal", () => {
    const report = classifyChart(gatedChart());
    expect(report.verdict).toBe("pinnable");
    expect(report.lookups.controlFlow).toHaveLength(1);
    expect(report.lookups.controlFlow[0].status).toBe("hazard");
    expect(report.hazards).toHaveLength(1);
    expect(report.hazards[0].file).toBe("templates/pvc.yaml");
    expect(report.hazards[0].line).toBe(3);
    expect(report.hazards[0].gates.map((g) => g.path)).toEqual(["persistence.enabled"]);
    expect(report.reasons.join("\n")).toContain("flipping it makes this render unpinnable");
  });

  test("flipping the gating value re-classifies the same chart to unpinnable", () => {
    const report = classifyChart(gatedChart(), {
      values: { persistence: { enabled: true } },
    });
    expect(report.verdict).toBe("unpinnable");
    expect(report.reasons.join("\n")).toContain("templates/pvc.yaml:3");
  });

  test("same-action short-circuit gating: `if and .Values.gate (lookup ...)`", () => {
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "values.yaml": "gate: false\n",
      "templates/cm.yaml": '{{- if and .Values.gate (lookup "v1" "ConfigMap" "ns" "n") }}\nx: 1\n{{- end }}',
    });
    const off = classifyChart(chart);
    expect(off.verdict).toBe("pinnable");
    expect(off.hazards[0].gates.map((g) => g.path)).toEqual(["gate"]);
    const on = classifyChart(chart, { values: { gate: true } });
    expect(on.verdict).toBe("unpinnable");
  });

  test("an unresolvable gate refuses: a gate we cannot prove closed is open", () => {
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "templates/cm.yaml": [
        '{{- if include "chart.someHelper" . }}',
        '{{- if lookup "v1" "ConfigMap" "ns" "n" }}',
        "x: 1",
        "{{- end }}",
        "{{- end }}",
      ].join("\n"),
    });
    const report = classifyChart(chart);
    expect(report.verdict).toBe("unpinnable");
    expect(report.reasons[0]).toContain("not provably gated off");
  });

  test("`with` rebinds the dot into the values tree for gate evaluation", () => {
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "values.yaml": "persistence:\n  enabled: false\n  size: 1Gi\n",
      "templates/pvc.yaml": [
        "{{- with .Values.persistence }}",
        '{{- if and .enabled (lookup "v1" "PersistentVolumeClaim" "ns" "n") }}',
        "x: 1",
        "{{- end }}",
        "{{- end }}",
      ].join("\n"),
    });
    const report = classifyChart(chart);
    expect(report.verdict).toBe("pinnable");
    expect(report.hazards[0].gates.map((g) => g.path)).toEqual(["persistence.enabled"]);
  });

  test("a subchart's gate is reported in root coordinates and flips from the root", () => {
    const files = {
      "Chart.yaml": [
        "apiVersion: v2",
        "name: umb",
        "version: 0.1.0",
        "dependencies:",
        "  - name: kid",
        "    version: 0.1.0",
      ].join("\n"),
      "charts/kid/Chart.yaml": "apiVersion: v2\nname: kid\nversion: 0.1.0\n",
      "charts/kid/values.yaml": "persistence:\n  enabled: false\n",
      "charts/kid/templates/pvc.yaml":
        '{{- if .Values.persistence.enabled }}\n{{- if lookup "v1" "P" "ns" "n" }}\nx: 1\n{{- end }}\n{{- end }}',
    };
    const off = classifyChart(mkChart(files));
    expect(off.verdict).toBe("pinnable");
    expect(off.hazards[0].chart).toBe("kid");
    expect(off.hazards[0].file).toBe("charts/kid/templates/pvc.yaml");
    expect(off.hazards[0].gates.map((g) => g.path)).toEqual(["kid.persistence.enabled"]);
    // Parent-overrides-child: the root values flip the subchart's gate.
    const on = classifyChart(mkChart(files), { values: { kid: { persistence: { enabled: true } } } });
    expect(on.verdict).toBe("unpinnable");
  });

  test("a condition-disabled dependency gates everything inside it (finding 12)", () => {
    const chart = mkChart({
      "Chart.yaml": [
        "apiVersion: v2",
        "name: umb",
        "version: 0.1.0",
        "dependencies:",
        "  - name: opt",
        "    version: 0.1.0",
        "    condition: opt.enabled",
      ].join("\n"),
      "values.yaml": "opt:\n  enabled: false\n",
      "charts/opt/Chart.yaml": "apiVersion: v2\nname: opt\nversion: 0.1.0\n",
      "charts/opt/templates/cm.yaml": '{{- if lookup "v1" "ConfigMap" "ns" "n" }}\nx: 1\n{{- end }}',
    });
    const report = classifyChart(chart);
    expect(report.verdict).toBe("pinnable");
    expect(report.hazards[0].chart).toBe("opt");
    expect(report.hazards[0].gates.map((g) => g.path)).toEqual(["opt.enabled"]);
  });

  test("an aliased instance left open refuses even when the plain instance is gated", () => {
    const chart = mkChart({
      "Chart.yaml": [
        "apiVersion: v2",
        "name: umb",
        "version: 0.1.0",
        "dependencies:",
        "  - name: kid",
        "    version: 0.1.0",
        "  - name: kid",
        "    version: 0.1.0",
        "    alias: kidtwo",
      ].join("\n"),
      "values.yaml": "kidtwo:\n  gate: true\n",
      "charts/kid/Chart.yaml": "apiVersion: v2\nname: kid\nversion: 0.1.0\n",
      "charts/kid/values.yaml": "gate: false\n",
      "charts/kid/templates/cm.yaml":
        '{{- if and .Values.gate (lookup "v1" "ConfigMap" "ns" "n") }}\nx: 1\n{{- end }}',
    });
    const report = classifyChart(chart);
    // One directory, two instances: kid is gated, kidtwo is live — the pair
    // (chart, values) is unpinnable because SOME instance reaches the lookup.
    expect(report.verdict).toBe("unpinnable");
    expect(report.lookups.controlFlow).toHaveLength(1);
    expect(report.reasons.join("\n")).toContain("kidtwo");
  });
});

describe("capability references and generated inputs", () => {
  test(".Capabilities refs are listed per path and require a profile — the normal case, not an error", () => {
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "templates/ing.yaml": [
        '{{- if .Values.ingress.enabled }}',
        '{{- if .Capabilities.APIVersions.Has "networking.k8s.io/v1" }}',
        "apiVersion: networking.k8s.io/v1",
        "{{- end }}",
        "{{- end }}",
        "kube: {{ .Capabilities.KubeVersion.Version }}",
      ].join("\n"),
    });
    const report = classifyChart(chart);
    expect(report.verdict).toBe("pinnable");
    expect(report.requiresProfile).toHaveLength(2);
    expect(report.requiresProfile.map((r) => r.capability).sort()).toEqual([
      "APIVersions",
      "KubeVersion",
    ]);
    expect(report.requiresProfile.every((r) => r.file === "templates/ing.yaml")).toBe(true);
    expect(report.reasons.join("\n")).toContain("declare capability profile");
  });

  test("an open generated input is detected statically and its suppliable path named", () => {
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "values.yaml": 'adminPassword: ""\n',
      "templates/secret.yaml":
        "{{- $pw := .Values.adminPassword | default (randAlphaNum 16) }}\npassword: {{ $pw | b64enc }}",
    });
    const report = classifyChart(chart);
    expect(report.verdict).toBe("pinnable");
    const generated = report.closedInputs.filter((c) => c.kind === "generated-value");
    expect(generated).toHaveLength(1);
    expect(generated[0].fn).toBe("randAlphaNum");
    expect(generated[0].valuesPath).toBe("adminPassword");
    expect(generated[0].suppliable).toBe(true);
  });

  test("supplying the value closes the generated input", () => {
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "values.yaml": 'adminPassword: ""\n',
      "templates/secret.yaml":
        "{{- $pw := .Values.adminPassword | default (randAlphaNum 16) }}\npassword: {{ $pw | b64enc }}",
    });
    const report = classifyChart(chart, { values: { adminPassword: "pinned" } });
    expect(report.closedInputs.filter((c) => c.kind === "generated-value")).toHaveLength(0);
    // Still pinnable (not deterministic): the supplied values ARE a closed input.
    expect(report.verdict).toBe("pinnable");
    expect(report.closedInputs.map((c) => c.kind)).toContain("supplied-values");
  });

  test("a generator with no suppliable value is named for the double-render localizer (#1236)", () => {
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "templates/secret.yaml": "token: {{ randAlphaNum 32 | quote }}",
    });
    const report = classifyChart(chart);
    expect(report.verdict).toBe("pinnable");
    const generated = report.closedInputs.filter((c) => c.kind === "generated-value");
    expect(generated).toHaveLength(1);
    expect(generated[0].suppliable).toBe(false);
    expect(generated[0].detail).toContain("#1236");
  });

  test("a generator behind a closed gate cannot fire and is not an open input", () => {
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "values.yaml": "autoGenerate: false\n",
      "templates/secret.yaml":
        "{{- if .Values.autoGenerate }}\ntoken: {{ randAlphaNum 32 | quote }}\n{{- end }}",
    });
    const report = classifyChart(chart);
    expect(report.closedInputs.filter((c) => c.kind === "generated-value")).toHaveLength(0);
    expect(report.verdict).toBe("deterministic");
  });

  test("double-render evidence alone still classifies pinnable with the diff surfaced", () => {
    const chart = mkChart({
      "Chart.yaml": MINIMAL_CHART,
      "templates/cm.yaml": "x: 1",
    });
    const report = classifyChart(chart, { renderEvidence: { stable: false, unstableLines: 4 } });
    expect(report.verdict).toBe("pinnable");
    expect(report.reasons.join("\n")).toContain("double render differs on 4 lines");
  });
});

describe("action extraction and scoping", () => {
  test("line numbers are 1-based and survive trim markers", () => {
    const actions = extractActions("a\nb: {{ .Values.x }}\n{{- if .Values.y }}\nc\n{{- end }}", "f.yaml");
    expect(actions.map((a) => [a.line, a.kind])).toEqual([
      [2, "other"],
      [3, "if"],
      [5, "end"],
    ]);
  });

  test("scoping attaches enclosing frames, else branches negate prior conditions", () => {
    const actions = extractActions(
      ["{{- if .Values.a }}", "{{ .Values.inner }}", "{{- else }}", "{{ .Values.other }}", "{{- end }}"].join("\n"),
      "f.yaml",
    );
    const scoped = scopeActions(actions);
    const inner = scoped.find((s) => s.action.body === ".Values.inner")!;
    expect(inner.frames).toHaveLength(1);
    expect(inner.frames[0].conditions).toEqual([".Values.a"]);
    const other = scoped.find((s) => s.action.body === ".Values.other")!;
    expect(other.frames[0].conditions).toEqual([]);
    expect(other.frames[0].negatedConditions).toEqual([".Values.a"]);
  });

  test("unbalanced structure degrades toward fewer frames, never a crash", () => {
    const scoped = scopeActions(extractActions("{{- end }}\n{{ .Values.x }}", "f.yaml"));
    expect(scoped.find((s) => s.action.body === ".Values.x")!.frames).toEqual([]);
  });
});
