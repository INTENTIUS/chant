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
import { scheduleCronSyntaxCheck } from "./ftn020-schedule-cron-syntax";
import { typedReferencesResolveCheck } from "./ftn021-typed-references-resolve";
import { webhookUrlPublicHttpsCheck } from "./ftn022-webhook-url-public-https";
import { acpRuntimeCommandCheck } from "./ftn023-acp-runtime-command";

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
const TEAMMATE = "Fountain::V1::Teammate";
const SCHEDULE = "Fountain::V1::Schedule";
const WEBHOOK = "Fountain::V1::Webhook";

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

describe("FTN020 schedule-cron-syntax", () => {
  it("errors on an expression fountain would store and never fire", () => {
    const diags = scheduleCronSyntaxCheck.check(
      ctx({ s: { entityType: SCHEDULE, name: "nightly", cron: "every night" } }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("every night");
  });

  it("errors on too few fields", () => {
    expect(scheduleCronSyntaxCheck.check(ctx({ s: { entityType: SCHEDULE, cron: "0 3 * *" } }))).toHaveLength(1);
  });

  it("accepts five and six fields", () => {
    for (const cron of ["0 3 * * *", "0 9 * * 1-5", "*/30 0 3 * * *"]) {
      expect(scheduleCronSyntaxCheck.check(ctx({ s: { entityType: SCHEDULE, cron } })), cron).toHaveLength(0);
    }
  });

  // #2195: the rule is core's `isValidCronExpression`, which takes no
  // nickname. `cronMatches` cannot evaluate one either, so a cadence written
  // that way is one chant never fires.
  it("rejects the @nickname shorthands, including @daily and @reboot", () => {
    for (const cron of ["@daily", "@hourly", "@midnight", "@yearly", "@reboot"]) {
      expect(scheduleCronSyntaxCheck.check(ctx({ s: { entityType: SCHEDULE, cron } })), cron).toHaveLength(1);
    }
  });
});

describe("FTN021 typed-references-resolve", () => {
  it("errors when a Teammate names an agent the build does not declare", () => {
    const diags = typedReferencesResolveCheck.check(
      ctx({
        a: { entityType: AGENT, name: "steward" },
        t: { entityType: TEAMMATE, name: "seat", agent: "stewrad" },
      }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("stewrad");
  });

  it("errors when a Schedule names a teammate the build does not declare", () => {
    const diags = typedReferencesResolveCheck.check(
      ctx({ s: { entityType: SCHEDULE, name: "nightly", teammate: "nobody" } }),
    );
    expect(diags).toHaveLength(1);
  });

  it("resolves against the declared name and the export name alike", () => {
    const byDeclaredName = typedReferencesResolveCheck.check(
      ctx({
        stewardAgent: { entityType: AGENT, name: "steward" },
        t: { entityType: TEAMMATE, agent: "steward" },
      }),
    );
    const byExportName = typedReferencesResolveCheck.check(
      ctx({
        stewardAgent: { entityType: AGENT, name: "steward" },
        t: { entityType: TEAMMATE, agent: "stewardAgent" },
      }),
    );
    expect(byDeclaredName).toHaveLength(0);
    expect(byExportName).toHaveLength(0);
  });

  it("is silent on the typed form, where the declaration is the reference", () => {
    const agent = { entityType: AGENT, name: "steward" };
    const diags = typedReferencesResolveCheck.check(ctx({ a: agent, t: { entityType: TEAMMATE, agent } }));
    expect(diags).toHaveLength(0);
  });
});

describe("FTN022 webhook-url-public-https", () => {
  it("errors on http", () => {
    const diags = webhookUrlPublicHttpsCheck.check(
      ctx({ w: { entityType: WEBHOOK, name: "hook", url: "http://example.com/hooks" } }),
    );
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("not https");
  });

  it("errors on loopback, RFC1918, and the cloud metadata address", () => {
    for (const url of [
      "https://localhost/hooks",
      "https://127.0.0.1/hooks",
      "https://10.0.3.7/hooks",
      "https://192.168.1.9/hooks",
      "https://172.20.0.4/hooks",
      "https://169.254.169.254/latest/meta-data/",
    ]) {
      const diags = webhookUrlPublicHttpsCheck.check(ctx({ w: { entityType: WEBHOOK, name: "hook", url } }));
      expect(diags.length, url).toBeGreaterThan(0);
    }
  });

  it("is silent on an https public endpoint", () => {
    const diags = webhookUrlPublicHttpsCheck.check(
      ctx({ w: { entityType: WEBHOOK, name: "hook", url: "https://example.com/hooks/fountain" } }),
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
