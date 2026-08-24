/**
 * Pinnability survey harness (#1231, epic #1228 Phase 0), asserting the
 * verdicts of the PRODUCTION classifier (`src/pinnability`, #1234) — the
 * prototype it replaced lives on only as these regression surfaces.
 *
 * Two layers, gated independently:
 *
 *   1. Fixture surveys — need helm on PATH, no network. The committed
 *      umbrella fixture (#1232) exercises subchart CRDs, an aliased
 *      dependency and a conditional dependency; two more fixtures cover the
 *      control-flow-lookup refusal and the open-generated-input diff.
 *      (Pure classifier unit tests are colocated with the classifier in
 *      src/pinnability and run in the main suite.)
 *   2. The upstream-chart survey — needs helm AND network, so it is gated on
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
  classifyChart,
  isCrdSource,
  splitDocuments,
  sourcePath,
  routeBySource,
} from "../../src/pinnability";
import {
  parseCorpus,
  pullChart,
  renderChart,
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

  test("umbrella fixture classifies deterministic despite lookup prose in comments (finding 9)", () => {
    const row = surveyChart("umbrella-fixture", "0.1.0", umbrella);
    expect(row.report.verdict).toBe("deterministic");
    expect(row.report.lookups.controlFlow).toHaveLength(0);
    expect(row.report.lookups.valuePosition).toHaveLength(0);
    expect(row.report.hazards).toHaveLength(0);
    expect(row.unstableLines).toBe(0);
  });

  test("control-flow lookup is refused with the location named", () => {
    const row = surveyChart("lookup-fixture", "0.1.0", join(FIXTURES, "lookup-fixture"));
    expect(row.report.verdict).toBe("unpinnable");
    expect(row.report.reasons.join("\n")).toContain("templates/cm.yaml:1");
    // The value-position lookup in the same chart is not what refuses it.
    expect(row.report.lookups.controlFlow).toHaveLength(1);
    expect(row.report.lookups.controlFlow[0].status).toBe("refused");
    expect(row.report.lookups.valuePosition).toHaveLength(1);
  });

  test("open generated input: unstable as-is, byte-identical once the value is supplied (finding 6)", () => {
    const chart = join(FIXTURES, "genvalues-fixture");
    const open = surveyChart("genvalues-fixture", "0.1.0", chart);
    expect(open.report.verdict).toBe("pinnable");
    // The classifier names the open input statically — the suppliable path
    // is what the pinned-render pipeline turns into a declared input.
    const generated = open.report.closedInputs.filter((c) => c.kind === "generated-value");
    expect(generated).toHaveLength(1);
    expect(generated[0].fn).toBe("randAlphaNum");
    expect(generated[0].valuesPath).toBe("adminPassword");
    expect(generated[0].suppliable).toBe(true);
    // The secret line AND the derived checksum/secret annotation differ —
    // which is why hoisting the output instead of pinning the input breaks
    // the restart-on-change mechanism.
    expect(open.unstableLines).toBeGreaterThanOrEqual(4);

    const closed = join(tmpdir(), `chant-survey-genvalues-${process.pid}.yaml`);
    writeFileSync(closed, "adminPassword: pinned-input\n");
    const pinned = surveyChart("genvalues-fixture", "0.1.0", chart, closed);
    expect(pinned.unstableLines).toBe(0);
    expect(pinned.report.verdict).toBe("pinnable");
    // With the value supplied, the generator is dead: no open generated input.
    expect(pinned.report.closedInputs.filter((c) => c.kind === "generated-value")).toHaveLength(0);
    expect(renderChart(chart, closed)).toBe(renderChart(chart, closed));
  });

  test("gated control-flow lookup: hazard when the values leave it off, refusal when flipped on", () => {
    // The kube-prometheus-stack shape (survey finding 1): the bundled
    // grafana's control-flow lookup sits behind grafana.persistence.enabled,
    // off by default — the static-refuse verdict costs the umbrella;
    // values-aware reachability recovers it and records the hazard.
    const chart = join(FIXTURES, "gated-lookup-fixture");
    const off = classifyChart(chart);
    expect(off.verdict).toBe("pinnable");
    expect(off.hazards).toHaveLength(1);
    expect(off.hazards[0].chart).toBe("kid");
    expect(off.hazards[0].file).toBe("charts/kid/templates/pvc.yaml");
    expect(off.hazards[0].gates.map((g) => g.path)).toEqual(["kid.persistence.enabled"]);

    const on = classifyChart(chart, { values: { kid: { persistence: { enabled: true } } } });
    expect(on.verdict).toBe("unpinnable");
    expect(on.reasons.join("\n")).toContain("charts/kid/templates/pvc.yaml");

    // The gated render itself is deterministic and helm agrees the document
    // is absent — the hazard records a live construct, not a rendered one.
    const rendered = renderChart(chart);
    expect(rendered).not.toContain("PersistentVolumeClaim");
  });

  test("classifier sees subchart templates, not just the top level", () => {
    // The epic's prototype grepped only <chart>/templates and called
    // kube-prometheus-stack pinnable while its bundled grafana carries a
    // control-flow lookup. Guard the classifier against the same blind spot.
    const report = classifyChart(join(FIXTURES, "gated-lookup-fixture"));
    expect(report.lookups.controlFlow.some((l) => l.file.startsWith("charts/kid/templates/"))).toBe(
      true,
    );
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
