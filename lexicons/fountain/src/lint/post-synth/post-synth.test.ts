import { describe, expect, it } from "vitest";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import type { Declarable } from "@intentius/chant";
import {
  noUnrestrictedNetworkingCheck,
  substitutionResolvableCheck,
  vaultShadowingCheck,
  mcpSecretEnvSubstitutionCheck,
  runtimeModelValidCheck,
  uniqueResourceNamesCheck,
} from "./index";

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
