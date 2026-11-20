/**
 * #5335: with `respond: { "wave-refused": "summary" }` the Forgejo wave jobs
 * and the pull request loop's apply job carry the summary's settings and
 * the model's key from the secret of its name. With `diff` or `off` the
 * settings change nothing: the rendered files are the same bytes.
 */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateForgejoOpWavesPipeline } from "./generate-op-waves-pipeline";
import { generateForgejoPipeline } from "./generate-pipeline";

const spec: OpWavesSpec = { name: "plywood-up", op: "plywood-up", plan: ["./bin/plan", "{target}", "{plan}"], waves: [{ name: "prod", runs: [{ target: "app" }] }] };
const SUMMARY = { keyEnv: "MODEL_KEY", maxRuns: 5, maxCostUsd: 2.5 };
const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];

const waves = (s: OpWavesSpec) => generateForgejoOpWavesPipeline(s, { specFile: "waves.json" }).files.map((f) => f.yaml).join("\n---\n");
/** The parsed documents as one JSON text, to look for one variable's entry whatever the YAML quoting. */
const parsed = (yaml: string) => JSON.stringify(yaml.split("\n---\n").map((d) => parseYAML(d)));
const entry = (name: string, value: string) => `${JSON.stringify(name)}:${JSON.stringify(value)}`;
const loop = (prLoop: Record<string, unknown>) => generateForgejoPipeline(ESTATE, { env: "prod", prLoop: { applyBeforeMerge: true, ...prLoop } }).yaml;

describe("the refused wave's summary on Forgejo (#5335)", () => {
  test("the wave jobs carry the settings and the key's secret", () => {
    const yaml = waves({ ...spec, respond: { "wave-refused": "summary" }, waveSummary: SUMMARY });
    expect(parsed(yaml)).toContain(entry("MODEL_KEY", "${{ secrets.MODEL_KEY }}"));
    expect(parsed(yaml)).toContain(entry("CHANT_WAVE_SUMMARY_KEY_ENV", "MODEL_KEY"));
    expect(parsed(yaml)).toContain(entry("CHANT_WAVE_SUMMARY_MAX_RUNS", "5"));
    expect(parsed(yaml)).toContain(entry("CHANT_WAVE_SUMMARY_MAX_COST_USD", "2.5"));
    const plain = waves({ ...spec, respond: { "wave-refused": "summary" } });
    expect(parsed(plain)).toContain(entry("ANTHROPIC_API_KEY", "${{ secrets.ANTHROPIC_API_KEY }}"));
  });

  test("with diff or off the wave files are the same bytes", () => {
    for (const mode of ["diff", "off"] as const) {
      expect(waves({ ...spec, respond: { "wave-refused": mode }, waveSummary: SUMMARY })).toBe(waves({ ...spec, respond: { "wave-refused": mode } }));
    }
    expect(waves({ ...spec, waveSummary: SUMMARY })).toBe(waves(spec));
  });

  test("the pull request loop's apply job carries them with summary, and nothing else changes with diff or off", () => {
    const yaml = loop({ respond: { "wave-refused": "summary" }, waveSummary: SUMMARY });
    expect(parsed(yaml)).toContain(entry("CHANT_RESPOND", "wave-refused=summary"));
    expect(parsed(yaml)).toContain(entry("MODEL_KEY", "${{ secrets.MODEL_KEY }}"));
    expect(parsed(yaml)).toContain(entry("CHANT_WAVE_SUMMARY_KEY_ENV", "MODEL_KEY"));
    for (const mode of ["diff", "off"] as const) expect(loop({ respond: { "wave-refused": mode }, waveSummary: SUMMARY })).toBe(loop({ respond: { "wave-refused": mode } }));
    expect(loop({ waveSummary: SUMMARY })).toBe(loop({}));
  });

  test("settings that are not settings are refused", () => {
    expect(() => waves({ ...spec, respond: { "wave-refused": "summary" }, waveSummary: { keyEnv: "not a var" } })).toThrow(/key variable/);
  });
});
