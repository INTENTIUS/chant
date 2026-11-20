/**
 * #5335: with `respond: { "wave-refused": "summary" }` the GitLab wave jobs
 * and the pull request loop's apply job carry the summary's settings, with
 * the variable that holds the model's key named; GitLab gives every job its
 * CI/CD variables, so the key needs no mapping. With `diff` or `off` the
 * settings change nothing: the rendered files are the same bytes.
 */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { OpWavesSpec } from "@intentius/chant/op/op-waves";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabOpWavesPipeline } from "./generate-op-waves-pipeline";
import { generateGitlabPipeline } from "./generate-pipeline";

const spec: OpWavesSpec = { name: "plywood-up", op: "plywood-up", plan: ["./bin/plan", "{target}", "{plan}"], waves: [{ name: "prod", runs: [{ target: "app" }] }] };
const SUMMARY = { keyEnv: "MODEL_KEY", maxRuns: 5, maxCostUsd: 2.5 };
const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];

const waves = (s: OpWavesSpec) => generateGitlabOpWavesPipeline(s, { specFile: "waves.json" }).files.map((f) => f.yaml).join("\n---\n");
/** The parsed documents as one JSON text, to look for one variable's entry whatever the YAML quoting. */
const parsed = (yaml: string) => JSON.stringify(yaml.split("\n---\n").map((d) => parseYAML(d)));
const entry = (name: string, value: string) => `${JSON.stringify(name)}:${JSON.stringify(value)}`;
const loop = (prLoop: Record<string, unknown>) => generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyBeforeMerge: true, ...prLoop } }).yaml;

describe("the refused wave's summary on GitLab (#5335)", () => {
  test("the wave jobs carry the settings and name the key's variable", () => {
    const yaml = waves({ ...spec, respond: { "wave-refused": "summary" }, waveSummary: SUMMARY });
    expect(parsed(yaml)).toContain(entry("CHANT_WAVE_SUMMARY_KEY_ENV", "MODEL_KEY"));
    expect(parsed(yaml)).toContain(entry("CHANT_WAVE_SUMMARY_MAX_RUNS", "5"));
    expect(parsed(yaml)).toContain(entry("CHANT_WAVE_SUMMARY_MAX_COST_USD", "2.5"));
    expect(yaml).not.toContain("secrets.");
    expect(parsed(waves({ ...spec, respond: { "wave-refused": "summary" } }))).toContain(entry("CHANT_WAVE_SUMMARY_KEY_ENV", "ANTHROPIC_API_KEY"));
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
    expect(parsed(yaml)).toContain(entry("CHANT_WAVE_SUMMARY_KEY_ENV", "MODEL_KEY"));
    for (const mode of ["diff", "off"] as const) expect(loop({ respond: { "wave-refused": mode }, waveSummary: SUMMARY })).toBe(loop({ respond: { "wave-refused": mode } }));
    expect(loop({ waveSummary: SUMMARY })).toBe(loop({}));
  });
});
