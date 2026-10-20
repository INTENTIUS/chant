import { describe, expect, it } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { Declarable } from "@intentius/chant";
// From the check modules, not the barrel — the barrel is generated and
// exports only the `postSynthChecks` array.
import { noUnrestrictedNetworkingCheck } from "./ftn011-no-unrestricted-networking";
import { substitutionResolvableCheck } from "./ftn013-substitution-resolvable";
import { vaultShadowingCheck } from "./ftn014-vault-shadowing";
import { mcpSecretEnvSubstitutionCheck } from "./ftn015-mcp-secret-env-substitution";
import { runtimeModelValidCheck } from "./ftn016-runtime-model-valid";
import { uniqueResourceNamesCheck } from "./ftn017-unique-resource-names";
import { acpRuntimeCommandCheck } from "./ftn023-acp-runtime-command";
import { setupTimeoutRangeCheck } from "./ftn024-setup-timeout-range";
import { removedUpstreamCheck } from "./ftn025-removed-upstream";

function ctx(entities: Record<string, Record<string, unknown>>): PostSynthContext {
  const map = new Map<string, Declarable>();
  for (const [name, props] of Object.entries(entities)) {
    map.set(name, { lexicon: "fountain", ...props } as unknown as Declarable);
  }
  return { outputs: new Map(), entities: map, buildResult: { warnings: [], errors: [] } } as unknown as PostSynthContext;
}

const ENV = "Fountain::V1::Environment";
const VAULT = "Fountain::V1::Vault";
const AGENT = "Fountain::V1::Agent";

describe("FTN011 no-unrestricted-networking", () => {
  it("warns on unrestricted, silent on limited", () => {
    expect(noUnrestrictedNetworkingCheck.check(ctx({ e: { entityType: ENV, networking_type: "unrestricted" } }))).toHaveLength(1);
    expect(noUnrestrictedNetworkingCheck.check(ctx({ e: { entityType: ENV, networking_type: "limited" } }))).toHaveLength(0);
  });
});

describe("FTN013 substitution-resolvable", () => {
  const env = { entityType: ENV, name: "e", env_vars: { DECLARED: "x" }, secrets: [{ key: "SECRET_ONE", value: "v" }] };

  it("warns on an unresolvable reference", () => {
    const diags = substitutionResolvableCheck.check(
      ctx({ e: env, a: { entityType: AGENT, environment: "e", mcp_servers: { s: { env: { T: "${MISSING}" } } } } }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("MISSING");
  });

  it("resolves against env_vars and secrets keys", () => {
    const diags = substitutionResolvableCheck.check(
      ctx({ e: env, a: { entityType: AGENT, environment: "e", mcp_servers: { s: { env: { A: "${DECLARED}", B: "${SECRET_ONE}" } } } } }),
    );
    expect(diags).toHaveLength(0);
  });

  it("silent when the environment is external", () => {
    const diags = substitutionResolvableCheck.check(
      ctx({ a: { entityType: AGENT, environment: "not-declared-here", mcp_servers: { s: { env: { T: "${X}" } } } } }),
    );
    expect(diags).toHaveLength(0);
  });
});

describe("FTN014 vault-shadowing", () => {
  it("warns when a vault key collides with an environment key", () => {
    const diags = vaultShadowingCheck.check(
      ctx({
        e: { entityType: ENV, env_vars: { DATABASE_URL: "prod" } },
        v: { entityType: VAULT, secrets: [{ key: "DATABASE_URL", value: "staging" }] },
      }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("DATABASE_URL");
  });

  it("silent without collisions", () => {
    const diags = vaultShadowingCheck.check(
      ctx({
        e: { entityType: ENV, env_vars: { A: "1" } },
        v: { entityType: VAULT, secrets: [{ key: "B", value: "2" }] },
      }),
    );
    expect(diags).toHaveLength(0);
  });
});

describe("FTN015 mcp-secret-env-substitution", () => {
  it("errors on a literal under a secret-shaped key", () => {
    const diags = mcpSecretEnvSubstitutionCheck.check(
      ctx({ a: { entityType: AGENT, mcp_servers: { gh: { env: { GITHUB_TOKEN: "literal" } } } } }),
    );
    expect(diags).toHaveLength(1);
  });

  it("accepts ${VAR} references and non-secret keys", () => {
    const diags = mcpSecretEnvSubstitutionCheck.check(
      ctx({ a: { entityType: AGENT, mcp_servers: { gh: { env: { GITHUB_TOKEN: "${GH}", LOG_LEVEL: "debug" } } } } }),
    );
    expect(diags).toHaveLength(0);
  });
});

describe("FTN016 runtime-model-valid", () => {
  it("errors on unknown runtime and malformed model", () => {
    const diags = runtimeModelValidCheck.check(
      ctx({ a: { entityType: AGENT, runtime: "cursor", model: "not-canonical" } }),
    );
    expect(diags).toHaveLength(2);
  });

  it("silent on valid values", () => {
    const diags = runtimeModelValidCheck.check(
      ctx({ a: { entityType: AGENT, runtime: "claude", model: "anthropic/claude-sonnet-4-6" } }),
    );
    expect(diags).toHaveLength(0);
  });

  it("accepts the acp runtime with no model", () => {
    const diags = runtimeModelValidCheck.check(
      ctx({ a: { entityType: AGENT, runtime: "acp", runtime_command: "chant acp" } }),
    );
    expect(diags).toHaveLength(0);
  });

  it("errors on a conversational runtime with no model, as Managoat refuses it at apply (#2776)", () => {
    for (const runtime of ["claude", "codex", "gemini"]) {
      const diags = runtimeModelValidCheck.check(ctx({ a: { entityType: AGENT, runtime } }));
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain(`runtime "${runtime}" and no model`);
      expect(diags[0].message).toContain("Managoat refuses it at apply");
    }
    expect(runtimeModelValidCheck.check(ctx({ a: { entityType: AGENT, runtime: "claude", model: "" } }))).toHaveLength(1);
  });

  it("errors when an acp agent carries a model", () => {
    const diags = runtimeModelValidCheck.check(
      ctx({ a: { entityType: AGENT, runtime: "acp", model: "anthropic/claude-sonnet-4-6" } }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("acp");
  });
});

describe("FTN017 unique-resource-names", () => {
  it("errors when two entities of a kind share a fountain name", () => {
    const diags = uniqueResourceNamesCheck.check(
      ctx({
        a: { entityType: ENV, name: "same" },
        b: { entityType: ENV, name: "same" },
      }),
    );
    expect(diags).toHaveLength(1);
  });

  it("allows the same name across kinds", () => {
    const diags = uniqueResourceNamesCheck.check(
      ctx({
        a: { entityType: ENV, name: "same" },
        b: { entityType: VAULT, name: "same" },
      }),
    );
    expect(diags).toHaveLength(0);
  });
});

describe("FTN023 acp-runtime-command", () => {
  it("errors on an acp agent with no runtime_command", () => {
    const diags = acpRuntimeCommandCheck.check(ctx({ a: { entityType: AGENT, name: "s", runtime: "acp" } }));
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("runtime_command");
  });

  it("errors on a runtime_command anywhere else", () => {
    const diags = acpRuntimeCommandCheck.check(
      ctx({ a: { entityType: AGENT, name: "s", runtime: "claude", runtime_command: "chant acp" } }),
    );
    expect(diags).toHaveLength(1);
  });

  it("is silent on the pair, and on a plain claude agent", () => {
    expect(
      acpRuntimeCommandCheck.check(ctx({ a: { entityType: AGENT, runtime: "acp", runtime_command: "chant acp" } })),
    ).toHaveLength(0);
    expect(
      acpRuntimeCommandCheck.check(ctx({ a: { entityType: AGENT, runtime: "claude", model: "anthropic/x" } })),
    ).toHaveLength(0);
  });
});

describe("FTN024 setup-timeout-range", () => {
  const env = (setup_timeout_seconds: unknown) =>
    ctx({ e: { entityType: ENV, name: "e", networking_type: "limited", setup_timeout_seconds } });

  it.each([0, 901, 12.5, -1, "120"])("errors on %j", (value) => {
    const diags = setupTimeoutRangeCheck.check(env(value));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("FTN024");
    expect(diags[0].message).toContain("1 to 900");
  });

  it.each([1, 120, 900])("is silent on %j", (value) => {
    expect(setupTimeoutRangeCheck.check(env(value))).toHaveLength(0);
  });

  it("is silent when the field is absent, and on other kinds", () => {
    expect(setupTimeoutRangeCheck.check(ctx({ e: { entityType: ENV, name: "e" } }))).toHaveLength(0);
    expect(
      setupTimeoutRangeCheck.check(ctx({ v: { entityType: VAULT, name: "v", setup_timeout_seconds: 901 } })),
    ).toHaveLength(0);
  });
});

describe("FTN025 removed-upstream (managoat/managoat#2793)", () => {
  it.each([
    ["Fountain::V1::Teammate", "Teammate", "no team"],
    ["Fountain::V1::Schedule", "Schedule", "no scheduler"],
    ["Fountain::V1::Webhook", "Webhook", "no webhooks"],
  ])("errors on a %s, naming what replaced it", (entityType, kind, replacement) => {
    const diags = removedUpstreamCheck.check(ctx({ old: { entityType, name: "old" } }));
    expect(diags).toHaveLength(1);
    expect(diags[0].checkId).toBe("FTN025");
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toContain(`${kind} "old" is a kind Managoat removed`);
    expect(diags[0].message).toContain(replacement);
  });

  it("errors on sandbox_mode persistent, and points at channel_id and --on e2b", () => {
    const diags = removedUpstreamCheck.check(
      ctx({ a: { entityType: AGENT, name: "a", runtime: "claude", model: "anthropic/x", sandbox_mode: "persistent" } }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('sandbox_mode "persistent"');
    expect(diags[0].message).toContain("channel_id");
    expect(diags[0].message).toContain("--on e2b");
  });

  it.each(["daytona", "runner"])("errors on sandbox_provider %s", (provider) => {
    const diags = removedUpstreamCheck.check(
      ctx({ a: { entityType: AGENT, name: "a", runtime: "claude", model: "anthropic/x", sandbox_provider: provider } }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain(`sandbox_provider "${provider}"`);
  });

  it("errors on the opencode runtime, which FTN016 leaves to it rather than report twice", () => {
    const agent = ctx({ a: { entityType: AGENT, name: "a", runtime: "opencode", model: "anthropic/x" } });
    const diags = removedUpstreamCheck.check(agent);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('runtime "opencode"');
    expect(runtimeModelValidCheck.check(agent)).toHaveLength(0);
  });

  it("is silent on an ephemeral agent on a current provider, and on the declarable kinds", () => {
    expect(
      removedUpstreamCheck.check(
        ctx({
          a: { entityType: AGENT, name: "a", runtime: "claude", model: "anthropic/x", sandbox_mode: "ephemeral", sandbox_provider: "e2b" },
          e: { entityType: ENV, name: "e" },
          v: { entityType: VAULT, name: "v" },
        }),
      ),
    ).toHaveLength(0);
  });
});
