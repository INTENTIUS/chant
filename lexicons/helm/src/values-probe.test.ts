/**
 * Coalesced-values probe (#1251) and its provenance products (#1252).
 *
 * Two layers:
 *
 * 1. Real-helm tests, gated on the binary like render.test.ts — the
 *    committed umbrella fixture (alias, globals, disabled dependency) plus
 *    a built provenance fixture with a parent override, a supplied file and
 *    a --set layer.
 * 2. Pure tests over `computeValueSources` / `findDeadAssignments` /
 *    `coalescedValuesDigest` — no helm, no fs.
 */

import { describe, test, expect, beforeAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  probeCoalescedValues,
  coalescedValuesDigest,
  computeValueSources,
  findDeadAssignments,
  rootCoalescedValues,
  getValuesProbeRecords,
  clearValuesProbeRecords,
  type CoalescedChartValues,
  type SuppliedValuesLayer,
  type ValuesAttributionInput,
} from "./values-probe";

const UMBRELLA = join(import.meta.dirname, "..", "test", "survey", "fixtures", "umbrella-fixture");

function helmAvailable(): boolean {
  try {
    execFileSync("helm", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const hasHelm = helmAvailable();

/** A parent chart overriding its child, with a global, a disabled dep, and a child default. */
const PROV_DIR = join(tmpdir(), "chant-values-probe-prov-fixture");

function setupProvenanceFixture(): void {
  rmSync(PROV_DIR, { recursive: true, force: true });
  mkdirSync(join(PROV_DIR, "templates"), { recursive: true });
  mkdirSync(join(PROV_DIR, "charts", "web", "templates"), { recursive: true });
  mkdirSync(join(PROV_DIR, "charts", "opt", "templates"), { recursive: true });
  writeFileSync(
    join(PROV_DIR, "Chart.yaml"),
    [
      "apiVersion: v2",
      "name: prov",
      "version: 0.1.0",
      "dependencies:",
      "  - name: web",
      "    version: 0.1.0",
      "  - name: opt",
      "    version: 0.1.0",
      "    condition: opt.enabled",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(PROV_DIR, "values.yaml"),
    ["web:", "  replicas: 2", "global:", "  region: eu", "opt:", "  enabled: false", ""].join("\n"),
  );
  writeFileSync(
    join(PROV_DIR, "templates", "cm.yaml"),
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-prov\ndata:\n  who: prov\n',
  );
  writeFileSync(join(PROV_DIR, "charts", "web", "Chart.yaml"), "apiVersion: v2\nname: web\nversion: 0.1.0\n");
  writeFileSync(join(PROV_DIR, "charts", "web", "values.yaml"), "replicas: 1\nport: 8080\ntag: default\n");
  writeFileSync(
    join(PROV_DIR, "charts", "web", "templates", "cm.yaml"),
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-web\ndata:\n  who: web\n',
  );
  writeFileSync(join(PROV_DIR, "charts", "opt", "Chart.yaml"), "apiVersion: v2\nname: opt\nversion: 0.1.0\n");
  writeFileSync(join(PROV_DIR, "charts", "opt", "values.yaml"), "size: small\n");
  writeFileSync(
    join(PROV_DIR, "charts", "opt", "templates", "cm.yaml"),
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}-opt\ndata:\n  who: opt\n',
  );
}

const PROV_SUPPLIED: SuppliedValuesLayer[] = [
  {
    origin: "supplied file",
    name: "values-prod.yaml",
    values: {
      web: { tag: "from-file" },
      opt: { size: "big" },
      notachart: { image: "typo" },
    },
  },
  { origin: "--set", values: { web: { tag: "from-set" } } },
];

describe.skipIf(!hasHelm)("probeCoalescedValues (real helm)", () => {
  beforeAll(() => {
    setupProvenanceFixture();
  });
  beforeEach(() => {
    clearValuesProbeRecords();
  });

  test("umbrella fixture: one instance per chart, alias included, root first", () => {
    const probe = probeCoalescedValues({ chartDir: UMBRELLA });
    expect(probe.instances.map((i) => i.scope)).toEqual([[], ["kid"], ["kidtwo"]]);
    expect(probe.instances.map((i) => i.chartName)).toEqual(["umbrella-fixture", "kid", "kidtwo"]);
  });

  test("umbrella fixture: disabled dependency is reported with its condition, not as an instance", () => {
    const probe = probeCoalescedValues({ chartDir: UMBRELLA });
    expect(probe.disabled).toEqual([{ scope: ["opt"], name: "opt", condition: "opt.enabled" }]);
    // The root document still carries the disabled dependency's subtree
    // (epic findings 14, 15) — an installed release would omit it.
    expect(rootCoalescedValues(probe)).toMatchObject({ opt: { enabled: false } });
  });

  test("umbrella fixture: supplied values reach the right scopes, globals propagate everywhere", () => {
    const probe = probeCoalescedValues({
      chartDir: UMBRELLA,
      supplied: [
        {
          origin: "supplied file",
          values: { kidtwo: { extra: "fromparent" }, global: { g1: "rootg" }, kid: { unused: "dead" } },
        },
      ],
    });
    const byScope = new Map(probe.instances.map((i) => [i.scope.join("."), i.values]));
    expect(byScope.get("kid")).toEqual({ unused: "dead", global: { g1: "rootg" } });
    expect(byScope.get("kidtwo")).toEqual({ extra: "fromparent", global: { g1: "rootg" } });
    expect(byScope.get("")).toMatchObject({ global: { g1: "rootg" } });
    expect(probe.valueSources["kid.unused"]).toBe("supplied file");
    expect(probe.valueSources["kid.global.g1"]).toBe("supplied file");
    expect(probe.valueSources["kidtwo.extra"]).toBe("supplied file");
    expect(probe.valueSources["opt.enabled"]).toBe("chart default");
    // Enabled child scopes are attributed through their own instances, not
    // through the copies helm pushes back into the parent tree.
    expect(probe.valueSources["kid.global.g1"]).toBeDefined();
    expect(probe.valueSources["kidtwo.global.g1"]).toBe("supplied file");
  });

  test("provenance fixture: valueSources attributes all four layer kinds", () => {
    const probe = probeCoalescedValues({ chartDir: PROV_DIR, supplied: PROV_SUPPLIED });
    expect(probe.valueSources["web.replicas"]).toBe("parent override");
    expect(probe.valueSources["web.port"]).toBe("chart default");
    expect(probe.valueSources["web.tag"]).toBe("--set");
    expect(probe.valueSources["web.global.region"]).toBe("parent override");
    expect(probe.valueSources["global.region"]).toBe("chart default");
    expect(probe.valueSources["opt.size"]).toBe("supplied file");
  });

  test("provenance fixture: dead assignments — shadowed, disabled subchart, unknown subchart", () => {
    const probe = probeCoalescedValues({ chartDir: PROV_DIR, supplied: PROV_SUPPLIED });
    const byPath = new Map(probe.deadAssignments.map((d) => [d.path, d]));
    expect(byPath.get("web.tag")).toMatchObject({
      reason: "shadowed",
      origin: "supplied file (values-prod.yaml)",
      shadowedBy: "--set",
    });
    expect(byPath.get("opt.size")).toMatchObject({
      reason: "disabled-subchart",
      shadowedBy: expect.stringContaining("opt.enabled"),
    });
    expect(byPath.get("notachart")).toMatchObject({ reason: "unknown-subchart" });
    expect(probe.deadAssignments).toHaveLength(3);
  });

  test("provenance fixture: no supplied values, no dead assignments", () => {
    const probe = probeCoalescedValues({ chartDir: PROV_DIR });
    expect(probe.deadAssignments).toEqual([]);
  });

  test("digest is stable across runs and moves with supplied values", () => {
    const a = probeCoalescedValues({ chartDir: PROV_DIR, supplied: PROV_SUPPLIED });
    const b = probeCoalescedValues({ chartDir: PROV_DIR, supplied: PROV_SUPPLIED });
    const c = probeCoalescedValues({
      chartDir: PROV_DIR,
      supplied: [{ origin: "supplied file", values: { web: { replicas: 9 } } }],
    });
    expect(a.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).not.toBe(c.digest);
  });

  test("root coalesced values match helm's file-merge semantics on shared keys", () => {
    const probe = probeCoalescedValues({ chartDir: PROV_DIR, supplied: PROV_SUPPLIED });
    const root = rootCoalescedValues(probe);
    // Supplied over defaults, later layer over earlier — what
    // `helm get values --all` reports for an installed release.
    expect(root).toMatchObject({
      global: { region: "eu" },
      opt: { enabled: false, size: "big" },
      notachart: { image: "typo" },
      web: { replicas: 2, port: 8080, tag: "from-set" },
    });
  });

  test("the source chart is never touched and no probe file survives", () => {
    probeCoalescedValues({ chartDir: PROV_DIR, supplied: PROV_SUPPLIED });
    expect(existsSync(join(PROV_DIR, "templates", "chant-values-probe.yaml"))).toBe(false);
    expect(existsSync(join(PROV_DIR, "charts", "web", "templates", "chant-values-probe.yaml"))).toBe(false);
    // The real templates are intact — the probe worked on a copy.
    expect(existsSync(join(PROV_DIR, "templates", "cm.yaml"))).toBe(true);
    // A plain render of the source chart carries no probe document.
    const rendered = execFileSync("helm", ["template", "check", PROV_DIR], { encoding: "utf8" });
    expect(rendered).not.toContain("chantValuesProbe");
  });

  test("every probe run is recorded for WHM503", () => {
    expect(getValuesProbeRecords()).toHaveLength(0);
    probeCoalescedValues({ chartDir: PROV_DIR, name: "prov-probe" });
    const records = getValuesProbeRecords();
    expect(records).toHaveLength(1);
    expect(records[0].name).toBe("prov-probe");
    expect(records[0].chartDir).toBe(PROV_DIR);
  });
});

describe("probeCoalescedValues (fake helm)", () => {
  beforeAll(() => {
    setupProvenanceFixture();
  });
  beforeEach(() => {
    clearValuesProbeRecords();
  });

  test("parses probe documents, maps scopes from Source paths, reports pruned dependencies", () => {
    const fakeOut = [
      "---",
      "# Source: prov/charts/web/templates/chant-values-probe.yaml",
      "chantValuesProbe: v1",
      "chart: web",
      "values:",
      "  replicas: 2",
      "---",
      "# Source: prov/templates/chant-values-probe.yaml",
      "chantValuesProbe: v1",
      "chart: prov",
      "values:",
      "  web:",
      "    replicas: 2",
      "  opt:",
      "    enabled: false",
      "  global:",
      "    region: eu",
      "",
    ].join("\n");
    const seen: string[][] = [];
    const probe = probeCoalescedValues({
      chartDir: PROV_DIR,
      runHelm: (args) => {
        seen.push(args);
        return fakeOut;
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0][0]).toBe("template");
    expect(probe.instances.map((i) => i.scope)).toEqual([[], ["web"]]);
    expect(probe.instances[1].chartName).toBe("web");
    expect(probe.disabled).toEqual([{ scope: ["opt"], name: "opt", condition: "opt.enabled" }]);
    expect(probe.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(probe.valueSources["web.replicas"]).toBe("parent override");
    expect(getValuesProbeRecords()).toHaveLength(1);
  });

  test("a render with no probe document is an error", () => {
    expect(() => probeCoalescedValues({ chartDir: PROV_DIR, runHelm: () => "---\nkind: ConfigMap\n" })).toThrow(
      /no probe document/,
    );
  });
});

describe("coalescedValuesDigest (pure)", () => {
  test("independent of instance order and of key order inside values", () => {
    const a: CoalescedChartValues[] = [
      { scope: [], chartName: "root", values: { x: 1, y: { z: 2 } } },
      { scope: ["kid"], chartName: "kid", values: { p: true } },
    ];
    const b: CoalescedChartValues[] = [
      { scope: ["kid"], chartName: "kid", values: { p: true } },
      { scope: [], chartName: "root", values: { y: { z: 2 }, x: 1 } },
    ];
    expect(coalescedValuesDigest(a)).toBe(coalescedValuesDigest(b));
    const c: CoalescedChartValues[] = [{ scope: [], chartName: "root", values: { x: 1 } }];
    expect(coalescedValuesDigest(a)).not.toBe(coalescedValuesDigest(c));
  });
});

describe("computeValueSources / findDeadAssignments (pure)", () => {
  const defaults: Record<string, Record<string, unknown>> = {
    "": { web: { replicas: 2 }, global: { region: "eu" }, opt: { enabled: false } },
    web: { replicas: 1, port: 8080 },
  };
  const input = (supplied: SuppliedValuesLayer[]): ValuesAttributionInput => ({
    instances: [
      {
        scope: [],
        chartName: "root",
        values: { web: { replicas: 2, port: 8080 }, global: { region: "eu" }, opt: { enabled: false } },
      },
      { scope: ["web"], chartName: "web", values: { replicas: 2, port: 8080, global: { region: "eu" } } },
    ],
    supplied,
    defaultsFor: (scope) => defaults[scope.join(".")],
  });

  test("attributes chart default, parent override, and propagated global", () => {
    const sources = computeValueSources(input([]));
    expect(sources).toEqual({
      "global.region": "chart default",
      "opt.enabled": "chart default",
      "web.replicas": "parent override",
      "web.port": "chart default",
      "web.global.region": "parent override",
    });
  });

  test("a supplied layer wins over authored layers, last supplied layer first", () => {
    const supplied: SuppliedValuesLayer[] = [
      { origin: "supplied file", values: { web: { replicas: 5 } } },
      { origin: "--set", values: { web: { replicas: 7 } } },
    ];
    const attribution = input(supplied);
    // Coalesced tree reflects the winning --set value.
    (attribution.instances[1].values as Record<string, unknown>).replicas = 7;
    ((attribution.instances[0].values as Record<string, Record<string, unknown>>).web).replicas = 7;
    const sources = computeValueSources(attribution);
    expect(sources["web.replicas"]).toBe("--set");
    const dead = findDeadAssignments(attribution, []);
    expect(dead).toEqual([
      { path: "web.replicas", origin: "supplied file", reason: "shadowed", shadowedBy: "--set" },
    ]);
  });

  test("a path no layer explains reports as computed", () => {
    const attribution = input([]);
    (attribution.instances[0].values as Record<string, unknown>).imported = "by-import-values";
    const sources = computeValueSources(attribution);
    expect(sources["imported"]).toBe("computed");
  });

  test("map-into-map across supplied layers merges — not a shadow", () => {
    const supplied: SuppliedValuesLayer[] = [
      { origin: "supplied file", values: { web: { extra: { a: 1 } } } },
      { origin: "--set", values: { web: { extra: { b: 2 } } } },
    ];
    expect(findDeadAssignments(input(supplied), [])).toEqual([]);
  });

  test("a supplied value under a disabled dependency scope is dead", () => {
    const supplied: SuppliedValuesLayer[] = [
      { origin: "supplied file", name: "values.yaml", values: { opt: { size: "big" } } },
    ];
    const dead = findDeadAssignments(input(supplied), [{ scope: ["opt"], name: "opt", condition: "opt.enabled" }]);
    expect(dead).toEqual([
      {
        path: "opt.size",
        origin: "supplied file (values.yaml)",
        reason: "disabled-subchart",
        shadowedBy: "disabled subchart opt (condition opt.enabled is false)",
      },
    ]);
  });

  test("a values map under a key naming no subchart is dead — once per key", () => {
    const supplied: SuppliedValuesLayer[] = [
      { origin: "supplied file", values: { wbe: { replicas: 3, tag: "x" } } },
    ];
    const dead = findDeadAssignments(input(supplied), []);
    expect(dead).toEqual([
      {
        path: "wbe",
        origin: "supplied file",
        reason: "unknown-subchart",
        shadowedBy: 'no dependency, chart default, or global named "wbe"',
      },
    ]);
  });

  test("a scalar under an unknown key, or a chart with no dependencies, is not flagged", () => {
    // Scalar top-level key: templates may read arbitrary .Values — only a
    // MAP under an unknown key reads as a mistyped subchart name.
    const scalar: SuppliedValuesLayer[] = [{ origin: "supplied file", values: { extraFlag: true } }];
    expect(findDeadAssignments(input(scalar), [])).toEqual([]);
    // No dependencies at all: nothing to mistarget.
    const noDeps: ValuesAttributionInput = {
      instances: [{ scope: [], chartName: "solo", values: { anything: { nested: 1 } } }],
      supplied: [{ origin: "supplied file", values: { anything: { nested: 1 } } }],
      defaultsFor: () => ({}),
    };
    expect(findDeadAssignments(noDeps, [])).toEqual([]);
  });
});
