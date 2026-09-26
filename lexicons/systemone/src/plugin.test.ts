import { describe, expect, it, vi } from "vitest";
import { isLexiconPlugin } from "@intentius/chant/lexicon";
import { validateLexiconConfig } from "@intentius/chant/lexicon-config";
import type { ChantConfig } from "@intentius/chant/config";
import { systemonePlugin } from "./plugin";
import { systemoneConfigSchema } from "./config";
import * as activities from "./op/activities";
import * as contracts from "./op/activity-contracts";

describe("systemone plugin", () => {
  it("is a valid LexiconPlugin named systemone, with the SYS prefix", () => {
    expect(isLexiconPlugin(systemonePlugin)).toBe(true);
    expect(systemonePlugin.name).toBe("systemone");
    expect(systemonePlugin.serializer.rulePrefix).toBe("SYS");
    expect(systemonePlugin.configSchema).toBe(systemoneConfigSchema);
  });

  it("returns SYS001 and SYS010", () => {
    expect(systemonePlugin.lintRules?.().map((r) => r.id)).toEqual(["SYS001"]);
    expect(systemonePlugin.postSynthChecks?.().map((c) => c.id)).toEqual(["SYS010"]);
  });

  it("registers the LSP providers and docs", () => {
    expect(typeof systemonePlugin.completionProvider).toBe("function");
    expect(typeof systemonePlugin.hoverProvider).toBe("function");
    expect(typeof systemonePlugin.docs).toBe("function");
  });

  it("loads the chant-systemone skill", () => {
    const skills = systemonePlugin.skills?.() ?? [];
    expect(skills.map((s) => s.name)).toEqual(["chant-systemone"]);
    expect(skills[0].content).toContain("decide");
  });

  it("exports exactly one activity, decide, with a contract of the same name", () => {
    expect(Object.keys(activities).filter((k) => typeof (activities as Record<string, unknown>)[k] === "function")).toEqual(["decide"]);
    expect(contracts.decide.name).toBe("decide");
  });

  it("the decide contract refuses a literal key and an unknown arg", () => {
    expect(contracts.decide.args.safeParse({ point: "p", backends: { s: { url: "https://x", key: { env: "K" } } } }).success).toBe(true);
    expect(contracts.decide.args.safeParse({ point: "p", backends: { s: { url: "https://x", key: "sk-literal" } } }).success).toBe(false);
    expect(contracts.decide.args.safeParse({ point: "p", pont: "typo" }).success).toBe(false);
  });
});

describe("the build path", () => {
  it("turns each configured backend into an entity, and calls no backend doing it (ws-052)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    try {
      const config = { systemone: { backends: { systemone: { url: "https://api.typesafe.ai", key: { env: "TYPESAFE_API_KEY" } } } } };
      const { entities } = await systemonePlugin.buildRoots!({ projectRoot: process.cwd(), config });
      expect([...entities.keys()]).toEqual(["backend/systemone"]);
      expect(entities.get("backend/systemone")).toMatchObject({ lexicon: "systemone", entityType: "Systemone::Backend", props: { url: "https://api.typesafe.ai", key: { env: "TYPESAFE_API_KEY" } } });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("contributes an audit catalog entry for every post-synth check", () => {
    const catalog = systemonePlugin.auditCatalog?.() ?? {};
    expect(Object.keys(catalog)).toEqual((systemonePlugin.postSynthChecks?.() ?? []).map((c) => c.id));
  });
});

describe("systemone config namespace", () => {
  const validate = (config: Record<string, unknown>) => validateLexiconConfig([systemonePlugin], config as unknown as ChantConfig);

  it("accepts env and brokered keys, and a keyless local backend", () => {
    expect(
      validate({
        systemone: {
          backends: {
            systemone: { url: "https://api.typesafe.ai", key: { env: "TYPESAFE_API_KEY" } },
            studio: { url: "http://127.0.0.1:7071", key: { capability: "inference", member: "box" }, timeoutMs: 5000 },
            local: { url: "http://127.0.0.1:8080" },
          },
        },
      }),
    ).toEqual([]);
  });

  it("refuses a literal key and an unknown field", () => {
    expect(validate({ systemone: { backends: { s: { url: "https://x", key: "sk-literal" } } } }).length).toBeGreaterThan(0);
    expect(validate({ systemone: { backends: { s: { url: "https://x", token: { env: "K" } } } } }).length).toBeGreaterThan(0);
  });
});
