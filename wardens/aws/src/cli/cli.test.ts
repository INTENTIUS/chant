import { describe, expect, it } from "vitest";
import { parseAuditArgs, parseReconcileArgs, CliError } from "../cli.js";
import { isGovernanceVerb } from "@intentius/chant/governance";
import { CYCLE_REGISTRY } from "./registry.js";

describe("parseReconcileArgs", () => {
  it("requires --config and defaults to dry-run", () => {
    expect(() => parseReconcileArgs([])).toThrow(CliError);
    const a = parseReconcileArgs(["--config", "g.yml"]);
    expect(a).toMatchObject({ config: "g.yml", mode: "dry-run", cycles: [], allowGuardrailOverride: false });
  });

  it("parses all flags and rejects bad input", () => {
    const a = parseReconcileArgs(["--config", "g.yml", "--mode", "apply", "--cycles", "scps, org-units", "--allow-guardrail-override"]);
    expect(a).toMatchObject({ mode: "apply", cycles: ["scps", "org-units"], allowGuardrailOverride: true });
    expect(() => parseReconcileArgs(["--config", "g", "--mode", "yolo"])).toThrow(/--mode must be/);
    expect(() => parseReconcileArgs(["--config", "g", "--nope"])).toThrow(/unknown flag/);
  });
});

describe("parseAuditArgs (#793)", () => {
  it("requires --config and defaults to fail-on none", () => {
    expect(() => parseAuditArgs([])).toThrow(CliError);
    const a = parseAuditArgs(["--config", "g.yml"]);
    expect(a).toEqual({ config: "g.yml", failOn: "none" });
  });

  it("parses --fail-on and rejects bad thresholds", () => {
    expect(parseAuditArgs(["--config", "g.yml", "--fail-on", "merge-worthy"]).failOn).toBe("merge-worthy");
    expect(parseAuditArgs(["--config", "g.yml", "--fail-on", "any"]).failOn).toBe("any");
    expect(() => parseAuditArgs(["--config", "g", "--fail-on", "yolo"])).toThrow(/--fail-on must be/);
    expect(() => parseAuditArgs(["--config", "g", "--mode", "apply"])).toThrow(/unknown flag/);
  });
});

describe("governance verbs (#790)", () => {
  it("every registered cycle stamps a valid verb", () => {
    for (const [name, cycle] of Object.entries(CYCLE_REGISTRY)) {
      expect(isGovernanceVerb(cycle.verb), `cycle "${name}" stamps no governance verb`).toBe(true);
    }
  });
});
