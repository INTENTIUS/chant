import { describe, test, expect, beforeEach } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { whm503 } from "./whm503";
import {
  clearValuesProbeRecords,
  recordValuesProbe,
  type CoalescedValuesProbe,
  type DeadAssignment,
} from "../../values-probe";

function makeCtx(): PostSynthContext {
  const outputs = new Map<string, string>();
  return {
    outputs,
    entities: new Map(),
    buildResult: {
      outputs,
      entities: new Map(),
      warnings: [],
      errors: [],
      sourceFileCount: 1,
    },
  };
}

function probeWith(deadAssignments: DeadAssignment[]): CoalescedValuesProbe {
  return {
    instances: [{ scope: [], chartName: "app", values: {} }],
    disabled: [],
    digest: "sha256:" + "0".repeat(64),
    valueSources: {},
    deadAssignments,
    warnings: [],
  };
}

describe("WHM503: dead value assignments", () => {
  beforeEach(() => {
    clearValuesProbeRecords();
  });

  test("no probe records, no diagnostics", () => {
    expect(whm503.check(makeCtx())).toEqual([]);
  });

  test("a probe with no dead assignments passes", () => {
    recordValuesProbe({ name: "app", chartDir: "/tmp/app", probe: probeWith([]) });
    expect(whm503.check(makeCtx())).toEqual([]);
  });

  test("one warning per dead assignment, naming path, origin, and what shadowed it", () => {
    recordValuesProbe({
      name: "app",
      chartDir: "/tmp/app",
      probe: probeWith([
        {
          path: "web.tag",
          origin: "supplied file (values-prod.yaml)",
          reason: "shadowed",
          shadowedBy: "--set",
        },
        {
          path: "opt.size",
          origin: "supplied file (values-prod.yaml)",
          reason: "disabled-subchart",
          shadowedBy: "disabled subchart opt (condition opt.enabled is false)",
        },
        {
          path: "wbe",
          origin: "supplied file (values-prod.yaml)",
          reason: "unknown-subchart",
          shadowedBy: 'no dependency, chart default, or global named "wbe"',
        },
      ]),
    });
    const diags = whm503.check(makeCtx());
    expect(diags).toHaveLength(3);
    for (const d of diags) {
      expect(d.checkId).toBe("WHM503");
      expect(d.severity).toBe("warning");
      expect(d.entity).toBe("app");
      expect(d.lexicon).toBe("helm");
      expect(d.message).toContain("supplied file (values-prod.yaml)");
    }
    expect(diags[0].message).toContain('"web.tag"');
    expect(diags[0].message).toContain("shadowed by --set");
    expect(diags[1].message).toContain("disabled subchart opt (condition opt.enabled is false)");
    expect(diags[2].message).toContain('no dependency, chart default, or global named "wbe"');
  });

  test("reports across multiple probe records", () => {
    recordValuesProbe({
      name: "app-a",
      chartDir: "/tmp/a",
      probe: probeWith([{ path: "x", origin: "--set", reason: "shadowed", shadowedBy: "--set" }]),
    });
    recordValuesProbe({
      name: "app-b",
      chartDir: "/tmp/b",
      probe: probeWith([{ path: "y", origin: "supplied file", reason: "shadowed", shadowedBy: "--set" }]),
    });
    const diags = whm503.check(makeCtx());
    expect(diags.map((d) => d.entity)).toEqual(["app-a", "app-b"]);
  });
});
