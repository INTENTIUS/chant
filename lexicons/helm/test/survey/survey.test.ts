/**
 * Pinnability survey harness (#1231, epic #1228 Phase 0).
 *
 * Three layers, gated independently:
 *
 *   1. Classifier unit tests — pure, no helm, always run. They pin the two
 *      prototype bugs the epic preserved on purpose: lookup detection must
 *      parse template actions, not text (finding 9), and CRD routing must
 *      match a `crds/` path segment, not prefix (finding 10).
 *   2. Fixture surveys — need helm on PATH, no network. The committed
 *      umbrella fixture (#1232) exercises subchart CRDs, an aliased
 *      dependency and a conditional dependency; two more fixtures cover the
 *      control-flow-lookup refusal and the open-generated-input diff.
 *   3. The upstream-chart survey — needs helm AND network, so it is gated on
 *      CHANT_HELM_SURVEY like the other external-dependency suites. Run it
 *      with `just helm-survey`. Verdicts are asserted against expected.txt —
 *      a survey that only prints is a report; one that asserts is a
 *      regression test.
 */

import { describe, test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  countDifferingLines,
  extractActions,
  isCrdSource,
  routeBySource,
  scanLookups,
  splitDocuments,
  sourcePath,
} from "./classify";
import {
  parseCorpus,
  pullChart,
  renderChart,
  scanChart,
  surveyChart,
  formatRow,
  valuesFileFor,
} from "./survey";

const SURVEY_DIR = join(import.meta.dirname);
const FIXTURES = join(SURVEY_DIR, "fixtures");

function helmAvailable(): boolean {
  try {
    execFileSync("helm", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasHelm = helmAvailable();
const runNetworkSurvey = hasHelm && !!process.env.CHANT_HELM_SURVEY;

describe("classifier: lookup detection parses template actions, not text (finding 9)", () => {
  test("prose in YAML comments is not a lookup hit", () => {
    // cert-manager has 52 textual "lookup" occurrences, all comment prose,
    // real template-action count 0. A text-matching gate refuses a chart
    // that is perfectly pinnable.
    const src = [
      "# the keys are used to lookup values from secrets",
      "apiVersion: v1",
      "kind: ConfigMap",
      "metadata:",
      "  name: {{ .Release.Name }}-cm",
    ].join("\n");
    const scan = scanLookups(extractActions(src, "cm.yaml"));
    expect(scan.controlFlow).toEqual([]);
    expect(scan.valuePosition).toEqual([]);
  });

  test("prose in template comment actions is not a lookup hit", () => {
    const src = '{{/* lookup is documented here, not called */}}\nname: {{ .Values.name }}';
    const scan = scanLookups(extractActions(src, "x.yaml"));
    expect(scan.controlFlow).toEqual([]);
    expect(scan.valuePosition).toEqual([]);
  });

  test("a value named lookup* is not a lookup call", () => {
    // grafana's `persistence.lookupVolumeName` — the value is named after
    // the feature; only the function call counts.
    const src = "{{- if .Values.persistence.lookupVolumeName }}\nx: 1\n{{- end }}";
    const scan = scanLookups(extractActions(src, "pvc.yaml"));
    expect(scan.controlFlow).toEqual([]);
    expect(scan.valuePosition).toEqual([]);
  });

  test("lookup in an if action is control flow; in an output action it is value position", () => {
    const src = [
      '{{- if not (lookup "v1" "ConfigMap" "ns" "seen") }}',
      "kind: ConfigMap",
      "{{- end }}",
      'prior: {{ (lookup "v1" "Namespace" "" "default").metadata.name | default "none" }}',
    ].join("\n");
    const scan = scanLookups(extractActions(src, "cm.yaml"));
    expect(scan.controlFlow).toHaveLength(1);
    expect(scan.controlFlow[0].line).toBe(1);
    expect(scan.valuePosition).toHaveLength(1);
    expect(scan.valuePosition[0].line).toBe(4);
  });
});

describe("classifier: CRD routing matches a crds/ segment, not prefix (finding 10)", () => {
  test("subchart CRD paths are CRD sources", () => {
    expect(isCrdSource("crds/topcrd.yaml")).toBe(true);
    expect(isCrdSource("charts/kid/crds/kidcrd.yaml")).toBe(true);
    expect(isCrdSource("charts/kidtwo/crds/kidcrd.yaml")).toBe(true);
  });

  test("templates paths are not, even when a directory is named crds", () => {
    expect(isCrdSource("templates/cm.yaml")).toBe(false);
    expect(isCrdSource("charts/kid/templates/cm.yaml")).toBe(false);
    // A file merely named after crds does not match the segment rule.
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

describe.skipIf(!hasHelm)("fixture surveys (helm, offline)", () => {
  const umbrella = join(FIXTURES, "umbrella-fixture");

  test("umbrella fixture routes CRDs at both levels, alias included (findings 10, 11)", () => {
    const rendered = renderChart(umbrella);
    const routed = routeBySource(rendered);
    // parent crds/ + the kid subchart's crds/ once per instance (kid, kidtwo).
    expect(routed.crds).toHaveLength(3);
    const sources = splitDocuments(rendered)
      .map((d) => sourcePath(d))
      .filter((p): p is string => p !== undefined && isCrdSource(p));
    expect(sources).toContain("crds/parentcrd.yaml");
    expect(sources).toContain("charts/kid/crds/kidcrd.yaml");
    expect(sources).toContain("charts/kidtwo/crds/kidcrd.yaml");
    // The aliased duplicate is 2 documents, 1 distinct name — helm dedupes
    // on install; the artifact must tolerate both without digest instability.
    const names = routed.crds
      .map((d) => d.match(/^ {2}name: (\S+)$/m)?.[1])
      .filter((n): n is string => n !== undefined);
    expect(new Set(names)).toEqual(new Set(["parentthings.example.com", "kidthings.example.com"]));
  });

  test("conditional dependency is a closed input: off by default, on via values (finding 12)", () => {
    const off = renderChart(umbrella);
    expect(off).not.toContain("who: opt");
    const on = renderChart(umbrella, undefined, ["--set", "opt.enabled=true"]);
    expect(on).toContain("who: opt");
  });

  test("umbrella fixture classifies deterministic-as-is despite lookup prose in comments (finding 9)", () => {
    const row = surveyChart("umbrella-fixture", "0.1.0", umbrella);
    expect(row.classification.verdict).toBe("deterministic-as-is");
    expect(row.lookupControl).toBe(0);
    expect(row.lookupValue).toBe(0);
    expect(row.unstableLines).toBe(0);
  });

  test("control-flow lookup is refused with the location named", () => {
    const row = surveyChart("lookup-fixture", "0.1.0", join(FIXTURES, "lookup-fixture"));
    expect(row.classification.verdict).toBe("unpinnable");
    expect(row.classification.reasons.join("\n")).toContain("templates/cm.yaml:1");
    // The value-position lookup in the same chart is not what refuses it.
    expect(row.lookupControl).toBe(1);
    expect(row.lookupValue).toBe(1);
  });

  test("open generated input: unstable as-is, byte-identical once the value is supplied (finding 6)", () => {
    const chart = join(FIXTURES, "genvalues-fixture");
    const open = surveyChart("genvalues-fixture", "0.1.0", chart);
    expect(open.classification.verdict).toBe("pinnable-with-closed-inputs");
    // The secret line AND the derived checksum/secret annotation differ —
    // which is why hoisting the output instead of pinning the input breaks
    // the restart-on-change mechanism.
    expect(open.unstableLines).toBeGreaterThanOrEqual(4);

    const closed = join(tmpdir(), `chant-survey-genvalues-${process.pid}.yaml`);
    writeFileSync(closed, "adminPassword: pinned-input\n");
    const pinned = surveyChart("genvalues-fixture", "0.1.0", chart, closed);
    expect(pinned.unstableLines).toBe(0);
    expect(pinned.classification.verdict).toBe("pinnable-with-closed-inputs");
    expect(renderChart(chart, closed)).toBe(renderChart(chart, closed));
  });

  test("scanChart sees subchart templates, not just the top level", () => {
    // The epic's prototype grepped only <chart>/templates and called
    // kube-prometheus-stack pinnable while its bundled grafana carries a
    // control-flow lookup. Guard the harness against the same blind spot.
    const kidChart = join(FIXTURES, "umbrella-fixture");
    const { actions } = scanChart(kidChart);
    expect(actions.some((a) => a.file.startsWith("charts/kid/templates/"))).toBe(true);
  });
});

describe.skipIf(!runNetworkSurvey)(
  "upstream-chart survey (helm + network, gated on CHANT_HELM_SURVEY)",
  () => {
    const corpus = parseCorpus(readFileSync(join(SURVEY_DIR, "charts.txt"), "utf8"));
    const expected = readFileSync(join(SURVEY_DIR, "expected.txt"), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const expectedByName = new Map(expected.map((l) => [l.split(/\s+/)[0], l]));

    test("expected.txt covers exactly the corpus", () => {
      expect([...expectedByName.keys()].sort()).toEqual(corpus.map((e) => e.name).sort());
    });

    test("traefik is present as the CRD regression case", () => {
      // 19 CRDs shipped in crds/ — the corpus must keep covering the
      // top-level CRD shape (the umbrella fixture covers the subchart one).
      expect(expectedByName.get("traefik")).toContain("crds=19");
    });

    for (const entry of corpus) {
      test(
        `${entry.name}@${entry.version} verdict matches expected.txt`,
        { timeout: 180_000 },
        () => {
          // A chart that cannot pull or render throws here: a harness
          // failure, never a silent omission (#1233).
          const chartDir = pullChart(entry);
          const row = surveyChart(
            entry.name,
            entry.version,
            chartDir,
            valuesFileFor(SURVEY_DIR, entry.name),
          );
          expect(formatRow(row)).toBe(expectedByName.get(entry.name));
        },
      );
    }
  },
);
