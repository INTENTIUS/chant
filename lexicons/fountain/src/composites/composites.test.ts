import { beforeEach, describe, expect, it } from "vitest";
import { WatchOp, isStewardDeclaration, stewardFormFor, type OpConfig } from "@intentius/chant/op";
import { ConciergeStack } from "./concierge-stack";
import { Steward, stewardForOp, __resetStewardsForTests } from "./steward";
import {
  Box,
  BOX_ALLOWED_VAULTS_METADATA_KEY,
  BOX_FOUNTAIN_CALLBACK_CAPABILITY,
  BOX_PORT_METADATA_KEY,
  BOX_SANDBOX_API_ACCESS_METADATA_KEY,
} from "./box";
import { postSynthChecks } from "../lint/post-synth/index";
import spec from "../spec/fountain-openapi.snapshot.json";
import { Environment, Vault } from "../generated/index";
import { fountainSerializer } from "../serializer";
import { buildGraphIr, resolveAttrRefs } from "@intentius/chant";
import type { Declarable } from "@intentius/chant";
import type { PostSynthContext } from "@intentius/chant/lint/post-synth";
import { runtimeModelValidCheck } from "../lint/post-synth/ftn016-runtime-model-valid";
import { acpRuntimeCommandCheck } from "../lint/post-synth/ftn023-acp-runtime-command";

describe("ConciergeStack", () => {
  it("defaults to deny-all egress, no vaults, and the ownership marker", () => {
    const { environment, agent } = ConciergeStack({
      name: "concierge",
      model: "anthropic/claude-sonnet-4-6",
    });

    const env = (environment as unknown as { props: Record<string, unknown> }).props;
    const a = (agent as unknown as { props: Record<string, unknown> }).props;
    expect(env.networking_type).toBe("limited");
    expect((env.networking_config as { allowed_hosts: string[] }).allowed_hosts).toEqual([]);
    expect((env.metadata as Record<string, unknown>)["managed-by"]).toBe("chant");
    expect(a.allowed_vault_ids).toEqual([]);
    expect(a.environment).toBe(environment);
    expect(a.runtime).toBe("claude");
  });

  it("loosening is explicit", () => {
    const { environment, agent } = ConciergeStack({
      name: "helper",
      model: "anthropic/claude-sonnet-4-6",
      allowedHosts: ["github.com"],
      allowedVaultIds: ["vault-1"],
      metadata: { team: "payments" },
    });

    const env = (environment as unknown as { props: Record<string, unknown> }).props;
    expect((env.networking_config as { allowed_hosts: string[] }).allowed_hosts).toEqual(["github.com"]);
    expect((agent as unknown as { props: Record<string, unknown> }).props.allowed_vault_ids).toEqual(["vault-1"]);
    expect((env.metadata as Record<string, unknown>).team).toBe("payments");
  });
});

// ── Steward ───────────────────────────────────────────────────────────────

const props = (entity: unknown): Record<string, unknown> =>
  (entity as { props: Record<string, unknown> }).props;

function op(name: string, schedule?: { cron: string; overlap?: string }): OpConfig {
  return {
    name,
    overview: `${name} overview`,
    phases: [],
    ...(schedule ? { schedule: schedule as OpConfig["schedule"] } : {}),
  };
}

describe("Steward", () => {
  beforeEach(() => {
    __resetStewardsForTests();
  });

  const toolchain = () => new Environment({ name: "toolchain" });
  const creds = () => new Vault({ name: "prod-creds" });

  it("passes FTN016 and FTN023 now that acp is upstream's runtime, not chant's extension", () => {
    const { agent, teammate } = Steward({
      name: "prod-steward",
      environment: toolchain(),
      ops: [op("prod-watch", { cron: "*/10 * * * *" })],
    });
    const entities = new Map<string, Declarable>([
      ["agent", agent as unknown as Declarable],
      ["teammate", teammate as unknown as Declarable],
    ]);
    const ctx = { outputs: new Map(), entities, buildResult: { warnings: [], errors: [] } } as unknown as PostSynthContext;

    expect(runtimeModelValidCheck.check(ctx)).toEqual([]);
    expect(acpRuntimeCommandCheck.check(ctx)).toEqual([]);
  });

  it("returns an acp agent, a teammate, a schedule per scheduled op, and the webhook", () => {
    const environment = toolchain();
    const vault = creds();
    const { agent, teammate, schedules, webhook } = Steward({
      name: "prod-steward",
      environment,
      vault,
      ops: [op("prod-watch", { cron: "*/10 * * * *" }), op("prod-apply")],
      webhook: { url: "https://hooks.example.com/chant", event_types: ["conversation.turn.done"] },
    });

    const a = props(agent);
    expect(a.name).toBe("prod-steward");
    expect(a.runtime).toBe("acp");
    expect(a.runtime_command).toBe("chant acp --steward prod-steward");
    expect(a.sandbox_mode).toBe("persistent");
    expect(a.model).toBeUndefined();
    expect(a.skills).toBeUndefined();
    expect(a.permission_policy).toEqual({ default: "auto_allow" });
    expect((a.metadata as Record<string, unknown>)["managed-by"]).toBe("chant");
    expect(a.environment).toBe(environment);
    expect(a.allowed_vault_ids).toEqual([vault]);

    const t = props(teammate);
    expect(t.name).toBe("prod-steward");
    expect(t.agent).toBe(agent);
    expect(t.environment).toBe(environment);
    expect(t.vault).toBe(vault);

    // One schedule — `prod-apply` carries no cadence, so it gets none.
    expect(schedules).toHaveLength(1);
    const s = props(schedules[0]);
    expect(s.name).toBe("prod-steward-prod-watch");
    expect(s.teammate).toBe(teammate);
    expect(s.cron).toBe("*/10 * * * *");
    expect(s.prompt).toBe("chant run prod-watch");
    expect(s.one_off).toBe(false);
    expect(s.enabled).toBe(true);

    expect(props(webhook).url).toBe("https://hooks.example.com/chant");
    expect(props(webhook).event_types).toEqual(["conversation.turn.done"]);
  });

  it("scopes the vault allowlist to nothing when no vault is given, and omits the webhook", () => {
    const { agent, teammate, webhook } = Steward({
      name: "broker-steward",
      environment: toolchain(),
      ops: [],
    });
    expect(props(agent).allowed_vault_ids).toEqual([]);
    expect(props(teammate).vault).toBeUndefined();
    expect(webhook).toBeUndefined();
  });

  it("lists every op on the steward, scheduled or not, for the runtime lookup", () => {
    Steward({
      name: "prod-steward",
      environment: toolchain(),
      ops: [op("prod-watch", { cron: "*/10 * * * *" }), op("prod-apply")],
    });
    expect(stewardForOp("prod-watch")).toBe("prod-steward");
    expect(stewardForOp("prod-apply")).toBe("prod-steward");
    expect(stewardForOp("unrelated")).toBeUndefined();
  });

  // `WatchOp`/`ConvergeOp`/`ApplyOp` return an Op *declaration*, which keeps
  // its config behind `props`. That is what an author has in hand, so reading
  // through it is the composite's job rather than the caller's — before this,
  // `ops: [watch.op]` type-checked nowhere and silently produced no schedules.
  it("takes the Op declarations the composites return, not just bare configs", () => {
    const { op: watch } = WatchOp({ name: "prod-watch", env: "prod", schedule: "*/10 * * * *" });
    const { schedules } = Steward({
      name: "prod-steward",
      environment: toolchain(),
      ops: [watch],
    });
    expect(schedules).toHaveLength(1);
    expect(props(schedules[0]).name).toBe("prod-steward-prod-watch");
    expect(props(schedules[0]).cron).toBe("*/10 * * * *");
    expect(props(schedules[0]).prompt).toBe("chant run prod-watch");
    expect(stewardForOp("prod-watch")).toBe("prod-steward");
  });

  it("refuses a second steward on the same environment and vault", () => {
    const environment = toolchain();
    const vault = creds();
    Steward({ name: "first", environment, vault, ops: [] });
    expect(() => Steward({ name: "second", environment, vault, ops: [] })).toThrow(
      /"first" already stewards environment "toolchain"/,
    );
  });

  it("allows a second steward on a different environment", () => {
    Steward({ name: "first", environment: toolchain(), vault: creds(), ops: [] });
    expect(() =>
      Steward({
        name: "second",
        environment: new Environment({ name: "staging" }),
        vault: creds(),
        ops: [],
      }),
    ).not.toThrow();
  });

  it("refuses an op whose schedule overlap is not skip", () => {
    expect(() =>
      Steward({
        name: "prod-steward",
        environment: toolchain(),
        ops: [op("prod-watch", { cron: "*/10 * * * *", overlap: "buffer" })],
      }),
    ).toThrow(/overlap "buffer"/);
  });

  it("refuses a webhook url FTN022 would reject", () => {
    const bad = (url: string) =>
      Steward({ name: "prod-steward", environment: toolchain(), ops: [], webhook: { url } });

    expect(() => bad("http://hooks.example.com/chant")).toThrow(/not https/);
    expect(() => bad("https://169.254.169.254/chant")).toThrow(/private host/);
    expect(() => bad("not a url")).toThrow(/is not a URL/);
  });

  it("serializes to the manifest in dependency order", () => {
    const environment = toolchain();
    const vault = creds();
    const { agent, teammate, schedules, webhook } = Steward({
      name: "prod-steward",
      environment,
      vault,
      ops: [op("prod-watch", { cron: "*/10 * * * *" })],
      webhook: { url: "https://hooks.example.com/chant" },
    });

    const entities = new Map<string, Declarable>([
      ["prodHook", webhook as unknown as Declarable],
      ["schedule", schedules[0] as unknown as Declarable],
      ["teammate", teammate as unknown as Declarable],
      ["agent", agent as unknown as Declarable],
      ["vault", vault as unknown as Declarable],
      ["toolchain", environment as unknown as Declarable],
    ]);

    const yaml = fountainSerializer.serialize(entities) as string;
    const kinds = [...yaml.matchAll(/^kind: (\w+)$/gm)].map((m) => m[1]);
    expect(kinds).toEqual(["Environment", "Vault", "Agent", "Teammate", "Schedule", "Webhook"]);
    expect(yaml).toContain("teammate: prod-steward");
    expect(yaml).toContain("prompt: chant run prod-watch");
    // References serialize to the referenced resource's fountain name, not
    // to the chant export name the entities map is keyed on.
    expect(yaml).toContain("environment: toolchain");
    expect(yaml).toMatch(/allowed_vault_ids:\n\s+- prod-creds/);
  });
});

// ── Steward: the declaration core reads, and its form (#2731) ─────────────

describe("Steward declaration and form", () => {
  beforeEach(() => {
    __resetStewardsForTests();
  });

  const toolchain = () => new Environment({ name: "toolchain" });

  it("returns the declaration core reads: name, every op, and fountain as the default form", () => {
    const { declaration } = Steward({
      name: "box-steward",
      environment: toolchain(),
      ops: [op("box-converge", { cron: "* * * * *" }), op("box-release")],
    });
    expect(isStewardDeclaration(declaration)).toBe(true);
    expect(declaration.name).toBe("box-steward");
    expect(declaration.ops.map((o) => o.name)).toEqual(["box-converge", "box-release"]);
    expect(declaration.form).toEqual({ default: "fountain", environments: {} });
    expect(stewardFormFor(declaration, "prod")).toBe("fountain");
  });

  it("names the environments where the same steward runs locally", () => {
    const { declaration, schedules } = Steward({
      name: "box-steward",
      environment: toolchain(),
      ops: [op("box-converge", { cron: "* * * * *" })],
      form: { default: "fountain", environments: { minimal: "local", spritzer: "local" } },
    });
    expect(stewardFormFor(declaration, "fountain-k3d")).toBe("fountain");
    expect(stewardFormFor(declaration, "minimal")).toBe("local");
    expect(stewardFormFor(declaration, "spritzer")).toBe("local");
    // The Fountain resources are declared whatever the form: which environment
    // they run in is the deploy's business, not the declaration's.
    expect(schedules).toHaveLength(1);
  });

  it("refuses a form that is local everywhere, which needs none of the Fountain resources", () => {
    expect(() =>
      Steward({ name: "box-steward", environment: toolchain(), ops: [], form: "local" }),
    ).toThrow(/local" in every environment/);
  });

  it("refuses an op listed twice, which would run twice per fire", () => {
    const converge = op("box-converge", { cron: "* * * * *" });
    expect(() =>
      Steward({ name: "box-steward", environment: toolchain(), ops: [converge, converge] }),
    ).toThrow(/listed twice/);
  });

  it("records the brokered capabilities, and refuses them beside a vault (#2726)", () => {
    const { declaration } = Steward({ name: "box-steward", environment: toolchain(), ops: [], capabilities: ["fountain"] });
    expect(declaration.capabilities).toEqual(["fountain"]);
    expect(declaration.vault).toBeNull();
    __resetStewardsForTests();
    expect(
      Steward({ name: "prod-steward", environment: toolchain(), vault: new Vault({ name: "prod-creds" }), ops: [] }).declaration.vault,
    ).toBe("prod-creds");
    __resetStewardsForTests();
    expect(() =>
      Steward({ name: "x", environment: toolchain(), vault: new Vault({ name: "v" }), ops: [], capabilities: ["fountain"] }),
    ).toThrow(/holds no credential/);
  });

  it("refuses an unknown form", () => {
    expect(() =>
      Steward({ name: "box-steward", environment: toolchain(), ops: [], form: "cloud" as never }),
    ).toThrow(/"local" or "fountain"/);
  });
});

// ── Box ───────────────────────────────────────────────────────────────────

describe("Box", () => {
  const base = {
    name: "studio-box",
    repo: { url: "https://github.com/arugula-salad/studio" },
    setupScript: "#!/bin/bash\nexec ~/box/provision-template.sh\n",
    model: "anthropic/claude-sonnet-4-5",
    permissionPolicy: { default: "auto_allow" as const },
  };

  it("declares a closed Environment and a persistent claude Agent, with the port in metadata", () => {
    const { environment, agent, vault, port } = Box(base);

    const env = props(environment);
    expect(env.name).toBe("studio-box-env");
    expect(env.repositories).toEqual([{ url: "https://github.com/arugula-salad/studio", mount_path: "/workspace/app" }]);
    expect(env.setup_script).toBe(base.setupScript);
    expect(env.networking_type).toBe("limited");
    expect(env.networking_config).toEqual({ allowed_hosts: [] });
    expect(env.metadata).toEqual({ "managed-by": "chant", [BOX_PORT_METADATA_KEY]: 8080 });

    const a = props(agent);
    expect(a.name).toBe("studio-box");
    expect(a.runtime).toBe("claude");
    expect(a.model).toBe("anthropic/claude-sonnet-4-5");
    expect(a.sandbox_mode).toBe("persistent");
    expect(a.environment).toBe(environment);
    expect(a.permission_policy).toEqual({ default: "auto_allow" });
    expect(a.allowed_vault_ids).toEqual([]);
    expect(a.sandbox_provider).toBeUndefined();
    expect(a.metadata).toEqual({
      "managed-by": "chant",
      "box-port": 8080,
      [BOX_ALLOWED_VAULTS_METADATA_KEY]: [],
      [BOX_SANDBOX_API_ACCESS_METADATA_KEY]: "owner",
    });

    expect(vault).toBeUndefined();
    expect(port).toBe(8080);
  });

  it("declares the shared vault and scopes the agent to it, named in the read contract", () => {
    const { agent, vault } = Box({
      ...base,
      vault: { secrets: [{ key: "STUDIO_SECRET", value: "${STUDIO_SECRET}" }] },
    });
    expect(props(vault).name).toBe("studio-box-secrets");
    expect(props(vault).secrets).toEqual([{ key: "STUDIO_SECRET", value: "${STUDIO_SECRET}" }]);
    expect(props(vault).metadata).toEqual({ "managed-by": "chant" });
    expect(props(agent).allowed_vault_ids).toEqual([vault]);
    expect((props(agent).metadata as Record<string, unknown>)[BOX_ALLOWED_VAULTS_METADATA_KEY]).toEqual([
      "studio-box-secrets",
    ]);
  });

  it("resolves an explicit allowedVaults list to names in the read contract", () => {
    const { agent } = Box({ ...base, allowedVaults: ["other-secrets", "studio-box-secrets"] });
    expect(props(agent).allowed_vault_ids).toEqual(["other-secrets", "studio-box-secrets"]);
    expect((props(agent).metadata as Record<string, unknown>)[BOX_ALLOWED_VAULTS_METADATA_KEY]).toEqual([
      "other-secrets",
      "studio-box-secrets",
    ]);
  });

  it("loosening is a visible parameter", () => {
    const open = Box({
      ...base,
      runtime: "codex",
      model: "openai/gpt-5",
      port: 3000,
      unrestrictedNetworking: true,
      allowedVaults: "any",
      sandboxProvider: "e2b",
      repo: { url: "https://github.com/o/app", mountPath: "/srv/app", ref: "v1", secretKey: "GH_TOKEN" },
      envVars: { NODE_ENV: "production" },
      packages: { apt: ["podman"] },
      setupTimeoutSeconds: 900,
      metadata: { team: "studio" },
    });
    const env = props(open.environment);
    expect(env.networking_type).toBe("unrestricted");
    expect(env.networking_config).toBeUndefined();
    expect(env.repositories).toEqual([{ url: "https://github.com/o/app", mount_path: "/srv/app", ref: "v1", secret_key: "GH_TOKEN" }]);
    expect(env.env_vars).toEqual({ NODE_ENV: "production" });
    expect(env.packages).toEqual({ apt: ["podman"] });
    expect(env.setup_timeout_seconds).toBe(900);
    expect(env.metadata).toEqual({ "managed-by": "chant", team: "studio", "box-port": 3000 });
    const a = props(open.agent);
    expect(a.runtime).toBe("codex");
    expect(a.model).toBe("openai/gpt-5");
    expect(a.sandbox_provider).toBe("e2b");
    // "any" leaves the manifest's own list unset: fountain reads that as any
    // vault the tenant owns. The read contract still names it explicitly.
    expect("allowed_vault_ids" in a).toBe(false);
    expect((a.metadata as Record<string, unknown>)[BOX_ALLOWED_VAULTS_METADATA_KEY]).toBe("any");
    expect(open.port).toBe(3000);

    const listed = Box({ ...base, allowedHosts: ["registry.npmjs.org"] });
    expect(props(listed.environment).networking_config).toEqual({ allowed_hosts: ["registry.npmjs.org"] });
  });

  it("builds with no repo — no clone, the Environment declares no repositories", () => {
    const { environment, agent, port } = Box({
      name: "blank-slate",
      setupScript: "#!/bin/bash\nnpm install\n",
      model: "anthropic/claude-sonnet-4-5",
      permissionPolicy: { default: "auto_allow" as const },
      sandboxProvider: "runner",
    });
    const env = props(environment);
    expect("repositories" in env).toBe(false);
    expect(env.setup_script).toBe("#!/bin/bash\nnpm install\n");
    const a = props(agent);
    expect(a.sandbox_provider).toBe("runner");
    expect(port).toBe(8080);
  });

  it("refuses what it cannot mean", () => {
    expect(() => Box({ ...base, port: 0 })).toThrow(/not a TCP port/);
    expect(() => Box({ ...base, port: 8080.5 })).toThrow(/not a TCP port/);
    expect(() => Box({ ...base, unrestrictedNetworking: true, allowedHosts: ["github.com"] })).toThrow(
      /allowedHosts and unrestrictedNetworking/,
    );
    expect(() => Box({ ...base, setupScript: "  " })).toThrow(/setupScript is empty/);
    // fountain v0.21.0 refuses an Agent with no model at apply (#2776); an
    // untyped caller finds out at build instead.
    const { model: _model, ...noModel } = base;
    expect(() => Box(noModel as unknown as Parameters<typeof Box>[0])).toThrow(
      /Box "studio-box": model is required — fountain v0\.21\.0 refuses an Agent with no model for the claude runtime/,
    );
    expect(() => Box({ ...base, model: " " })).toThrow(/model is required/);
  });

  it("serializes to a manifest whose specs the pinned API accepts, clean under every post-synth check", () => {
    const { environment, agent, vault } = Box({
      ...base,
      allowedHosts: ["registry.npmjs.org", "github.com"],
      vault: { secrets: [{ key: "STUDIO_SECRET", value: "${STUDIO_SECRET}" }] },
    });
    const entities = new Map<string, Declarable>([
      ["boxAgent", agent as unknown as Declarable],
      ["boxVault", vault as unknown as Declarable],
      ["boxEnv", environment as unknown as Declarable],
    ]);

    const yaml = fountainSerializer.serialize(entities) as string;
    expect([...yaml.matchAll(/^kind: (\w+)$/gm)].map((m) => m[1])).toEqual(["Environment", "Vault", "Agent"]);
    expect(yaml).toContain("environment: studio-box-env");
    expect(yaml).toMatch(/allowed_vault_ids:\n\s+- studio-box-secrets/);
    expect(yaml).toContain("box-port: 8080");

    // Every spec key is a field of the pinned create request, or one of the
    // two manifest-level forms fountainApply and `fountain apply -f` resolve:
    // a name reference to the agent's environment, and inline secrets.
    const schemas = (spec as unknown as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } })
      .components.schemas;
    const manifestOnly = new Set(["environment", "secrets"]);
    for (const [kind, entity] of [
      ["EnvironmentRequest", environment],
      ["VaultRequest", vault],
      ["AgentRequest", agent],
    ] as const) {
      const fields = Object.keys(schemas[kind].properties);
      for (const key of Object.keys(props(entity))) {
        if (key === "name" || manifestOnly.has(key)) continue;
        expect(fields, `${kind} has no field ${key}`).toContain(key);
      }
    }

    const ctx = { outputs: new Map(), entities, buildResult: { warnings: [], errors: [] } } as unknown as PostSynthContext;
    const diagnostics = postSynthChecks.flatMap((c) => c.check(ctx));
    expect(diagnostics).toEqual([]);
  });

  it("a no-repo, sandboxProvider: runner box builds a manifest whose every field exists in the pinned spec, clean under every post-synth check", () => {
    const { environment, agent } = Box({
      name: "blank-slate",
      setupScript: "#!/bin/bash\nnpm install\n",
      model: "anthropic/claude-sonnet-4-5",
      permissionPolicy: { default: "auto_allow" as const },
      sandboxProvider: "runner",
    });
    const entities = new Map<string, Declarable>([
      ["boxAgent", agent as unknown as Declarable],
      ["boxEnv", environment as unknown as Declarable],
    ]);

    const yaml = fountainSerializer.serialize(entities) as string;
    expect([...yaml.matchAll(/^kind: (\w+)$/gm)].map((m) => m[1])).toEqual(["Environment", "Agent"]);
    expect(yaml).not.toContain("repositories:");
    expect(yaml).toContain("sandbox_provider: runner");

    const schemas = (spec as unknown as { components: { schemas: Record<string, { properties: Record<string, unknown> }> } })
      .components.schemas;
    const manifestOnly = new Set(["environment", "secrets"]);
    for (const [kind, entity] of [
      ["EnvironmentRequest", environment],
      ["AgentRequest", agent],
    ] as const) {
      const fields = Object.keys(schemas[kind].properties);
      for (const key of Object.keys(props(entity))) {
        if (key === "name" || manifestOnly.has(key)) continue;
        expect(fields, `${kind} has no field ${key}`).toContain(key);
      }
    }

    const ctx = { outputs: new Map(), entities, buildResult: { warnings: [], errors: [] } } as unknown as PostSynthContext;
    const diagnostics = postSynthChecks.flatMap((c) => c.check(ctx));
    expect(diagnostics).toEqual([]);
  });

  it("shows the agent's sandbox provider and allowed vaults on the graph node (#2759)", () => {
    const { agent, environment } = Box({
      ...base,
      sandboxProvider: "runner",
      allowedVaults: "any",
    });
    const entities = new Map<string, Declarable>([
      ["boxAgent", agent as unknown as Declarable],
      ["boxEnv", environment as unknown as Declarable],
    ]);
    resolveAttrRefs(entities);

    const ir = buildGraphIr(entities);
    const agentNode = ir.nodes.find((n) => n.id === "boxAgent")!;
    expect(agentNode.attrs.sandbox_provider).toBe("runner");
    // "any" leaves the manifest's allowed_vault_ids unset, so it's the
    // metadata marker a graph reader checks, not an absent key it has to
    // interpret.
    expect(agentNode.attrs.allowed_vault_ids).toBeUndefined();
    expect((agentNode.attrs.metadata as Record<string, unknown>)[BOX_ALLOWED_VAULTS_METADATA_KEY]).toBe("any");
    // fountain's callback token (#2780): the graph node says the sandbox gets one, and its scope.
    expect((agentNode.attrs.metadata as Record<string, unknown>)[BOX_SANDBOX_API_ACCESS_METADATA_KEY]).toBe("owner");
  });

  it("records fountain's callback token in the built manifest, and names the capability the box block declares for it (#2780)", () => {
    const { environment, agent } = Box(base);
    const entities = new Map<string, Declarable>([
      ["boxAgent", agent as unknown as Declarable],
      ["boxEnv", environment as unknown as Declarable],
    ]);
    resolveAttrRefs(entities);
    const manifest = fountainSerializer.serialize(entities) as string;
    expect(manifest).toMatch(/kind: Agent[\s\S]*box-sandbox-api-access: owner/);
    expect(BOX_FOUNTAIN_CALLBACK_CAPABILITY).toEqual({ name: "fountain-callback", broker: "fountain", scope: ["owner"] });
  });
});
