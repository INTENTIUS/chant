import { describe, it, expect } from "vitest";
import { parseReconcileArgs, CliError } from "../cli.js";

describe("parseReconcileArgs", () => {
  it("parses a valid invocation", () => {
    const a = parseReconcileArgs([
      "--config", "gov.yml",
      "--base-url", "https://forge.example.com",
      "--token-env", "FORGEJO_TOKEN",
      "--mode", "apply",
      "--cycles", "org-settings,teams",
    ]);
    expect(a.config).toBe("gov.yml");
    expect(a.baseUrl).toBe("https://forge.example.com");
    expect(a.tokenEnv).toBe("FORGEJO_TOKEN");
    expect(a.mode).toBe("apply");
    expect(a.cycles).toEqual(["org-settings", "teams"]);
    expect(a.allowGuardrailOverride).toBe(false);
  });

  it("accepts --base-url-env in place of --base-url", () => {
    const a = parseReconcileArgs(["--config", "g.yml", "--base-url-env", "FORGE_URL", "--token-env", "T"]);
    expect(a.baseUrlEnv).toBe("FORGE_URL");
    expect(a.baseUrl).toBeUndefined();
  });

  it("defaults mode to dry-run and parses the override flag", () => {
    const a = parseReconcileArgs(["--config", "g.yml", "--base-url", "u", "--token-env", "T", "--allow-guardrail-override"]);
    expect(a.mode).toBe("dry-run");
    expect(a.allowGuardrailOverride).toBe(true);
  });

  it("throws code 2 on missing config / instance url / token / bad mode / unknown flag", () => {
    const bad = (argv: string[]) => expect(() => parseReconcileArgs(argv)).toThrow(expect.objectContaining({ code: 2 }));
    bad(["--base-url", "u", "--token-env", "T"]); // no config
    bad(["--config", "g.yml", "--token-env", "T"]); // no base url
    bad(["--config", "g.yml", "--base-url", "u"]); // no token
    bad(["--config", "g.yml", "--base-url", "u", "--token-env", "T", "--mode", "nope"]);
    bad(["--config", "g.yml", "--base-url", "u", "--token-env", "T", "--bogus"]);
    expect(() => parseReconcileArgs(["--config", "u", "--token-env"])).toThrow(CliError);
  });
});
