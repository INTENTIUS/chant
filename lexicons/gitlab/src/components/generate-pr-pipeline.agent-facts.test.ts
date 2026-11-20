/**
 * #5399: the pull request loop's apply job carries the agent facts' settings
 * on Gitlab, as a wave job does: `CHANT_AGENT_FACTS` and the relay key. A loop
 * that sets neither agentFacts nor a summary renders as the same bytes.
 */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { generateGitlabPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "net", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "net" }] }] }];
const loop = (prLoop: Record<string, unknown>) => generateGitlabPipeline(ESTATE, { env: "prod", prLoop: { applyBeforeMerge: true, ...prLoop } }).yaml;
const parsed = (yaml: string) => JSON.stringify(parseYAML(yaml));
const entry = (name: string, value: string) => `${JSON.stringify(name)}:${JSON.stringify(value)}`;

describe("the pull request apply job's agent facts on Gitlab (#5399)", () => {
  test("carries the facts and the relay key", () => {
    const yaml = loop({ agentFacts: { relayKeyEnv: "OPS_RELAY" } });
    expect(parsed(yaml)).toContain(entry("CHANT_AGENT_FACTS", "apply-failed"));
    expect(parsed(yaml)).toContain(entry("CHANT_RELAY_KEY", "$OPS_RELAY"));
    expect(parsed(loop({ agentFacts: {} }))).toContain(entry("CHANT_AGENT_FACTS", "apply-failed"));
  });

  test("with neither agentFacts nor a summary set, the loop is the same bytes", () => {
    expect(loop({ agentFacts: undefined, waveSummary: undefined })).toBe(loop({}));
    expect(loop({ respond: { "wave-refused": "diff" } })).toBe(loop({ respond: { "wave-refused": "diff" }, waveSummary: { keyEnv: "K" } }));
    expect(loop({})).not.toContain("CHANT_AGENT_FACTS");
  });

  test("both settings together put both on the apply job", () => {
    const yaml = loop({ agentFacts: {}, respond: { "wave-refused": "summary" }, waveSummary: { keyEnv: "MODEL_KEY" } });
    expect(parsed(yaml)).toContain(entry("CHANT_AGENT_FACTS", "apply-failed"));
    expect(parsed(yaml)).toContain(entry("CHANT_WAVE_SUMMARY_KEY_ENV", "MODEL_KEY"));
  });

  test("a relay key that is not a variable name is refused", () => {
    expect(() => loop({ agentFacts: { relayKeyEnv: "not a var" } })).toThrow(/relayKeyEnv/);
  });
});
