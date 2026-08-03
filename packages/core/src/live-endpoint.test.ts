import { describe, test, expect } from "vitest";
import { applyLiveEndpoint, zeroResourcesWarning, endpointEnvVarsFor } from "./live-endpoint";
import type { EmulatorCapability } from "./op/emulator-lifecycle";

/** A lexicon standing in for one whose emulator names an endpoint var. */
function lexicon(name: string, ...vars: string[]): { name: string; emulator?: EmulatorCapability } {
  if (vars.length === 0) return { name };
  return {
    name,
    emulator: {
      spec: { name: `chant-${name}`, image: `${name}:0`, containerPort: 1, healthPath: "/h" },
      // Credentials come back alongside the endpoint, as they do for real:
      // only the vars carrying the endpoint itself should be injected.
      env: (endpoint) => ({
        ...Object.fromEntries(vars.map((v) => [v, endpoint])),
        [`${name.toUpperCase()}_ACCESS_KEY_ID`]: "test",
      }),
    },
  };
}
import type { EnvironmentDeclaration } from "./config";

describe("applyLiveEndpoint (#1166)", () => {
  test("no-op — and no notice — when the environment declares no endpoint at all", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = applyLiveEndpoint(["floci", "prod"], "floci", [lexicon("aws", "AWS_ENDPOINT_URL")], env);
    expect(result.notice).toBeUndefined();
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
    result.restore(); // always safe, even as a no-op
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
  });

  test("applies the declared endpoint to the ambient var of every observing lexicon that has one", () => {
    const environments: EnvironmentDeclaration[] = [{ name: "floci", endpoint: "http://localhost:4566" }];
    const env: NodeJS.ProcessEnv = {};
    const result = applyLiveEndpoint(environments, "floci", [lexicon("aws", "AWS_ENDPOINT_URL")], env);
    expect(env.AWS_ENDPOINT_URL).toBe("http://localhost:4566");
    expect(result.notice).toMatch(/environment "floci" declares endpoint http:\/\/localhost:4566/);
    expect(result.notice).toMatch(/AWS_ENDPOINT_URL/);
  });

  test("restore() removes exactly what it set, not a pre-existing value it didn't touch", () => {
    const environments: EnvironmentDeclaration[] = [{ name: "floci", endpoint: "http://localhost:4566" }];
    const env: NodeJS.ProcessEnv = {};
    const result = applyLiveEndpoint(environments, "floci", [lexicon("aws", "AWS_ENDPOINT_URL")], env);
    expect(env.AWS_ENDPOINT_URL).toBe("http://localhost:4566");
    result.restore();
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
  });

  test("ambient wins: an already-set var is left untouched, and the notice says so", () => {
    const environments: EnvironmentDeclaration[] = [{ name: "floci", endpoint: "http://localhost:4566" }];
    const env: NodeJS.ProcessEnv = { AWS_ENDPOINT_URL: "http://real-endpoint.example" };
    const result = applyLiveEndpoint(environments, "floci", [lexicon("aws", "AWS_ENDPOINT_URL")], env);
    expect(env.AWS_ENDPOINT_URL).toBe("http://real-endpoint.example"); // unchanged
    expect(result.notice).toMatch(/ambient AWS_ENDPOINT_URL already set/);
    result.restore();
    expect(env.AWS_ENDPOINT_URL).toBe("http://real-endpoint.example"); // restore never touches what it didn't set
  });

  test("a bare-string environment entry has no endpoint to apply", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = applyLiveEndpoint(["floci"], "floci", ["aws"], env);
    expect(result.notice).toBeUndefined();
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
  });

  test("only applies to lexicons actually observing, and only those with a known endpoint var", () => {
    const environments: EnvironmentDeclaration[] = [{ name: "floci", endpoint: "http://localhost:4566" }];
    const env: NodeJS.ProcessEnv = {};
    // k8s has no ambient-var knob (config-resolved instead) — nothing to set.
    const result = applyLiveEndpoint(environments, "floci", ["k8s"], env);
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
    expect(result.notice).toBeUndefined();
  });

  test("applies to fly's FLY_FLAPS_BASE_URL too, when fly is among the observing lexicons", () => {
    const environments: EnvironmentDeclaration[] = [{ name: "floci", endpoint: "http://localhost:4566" }];
    const env: NodeJS.ProcessEnv = {};
    const result = applyLiveEndpoint(environments, "floci", [lexicon("aws", "AWS_ENDPOINT_URL"), lexicon("fly", "FLY_FLAPS_BASE_URL")], env);
    expect(env.AWS_ENDPOINT_URL).toBe("http://localhost:4566");
    expect(env.FLY_FLAPS_BASE_URL).toBe("http://localhost:4566");
    result.restore();
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
    expect(env.FLY_FLAPS_BASE_URL).toBeUndefined();
  });

  test("mixed: one lexicon's var is applied, another's ambient value wins — both show up in the notice", () => {
    const environments: EnvironmentDeclaration[] = [{ name: "floci", endpoint: "http://localhost:4566" }];
    const env: NodeJS.ProcessEnv = { FLY_FLAPS_BASE_URL: "http://real-fly.example" };
    const result = applyLiveEndpoint(environments, "floci", [lexicon("aws", "AWS_ENDPOINT_URL"), lexicon("fly", "FLY_FLAPS_BASE_URL")], env);
    expect(env.AWS_ENDPOINT_URL).toBe("http://localhost:4566"); // applied
    expect(env.FLY_FLAPS_BASE_URL).toBe("http://real-fly.example"); // ambient wins
    expect(result.notice).toMatch(/applied to AWS_ENDPOINT_URL/);
    expect(result.notice).toMatch(/ambient FLY_FLAPS_BASE_URL already set/);
  });

  test("the endpoint vars come from the lexicon's own emulator, not a map in core (#1345)", () => {
    expect(endpointEnvVarsFor(lexicon("aws", "AWS_ENDPOINT_URL"))).toEqual(["AWS_ENDPOINT_URL"]);
  });

  test("credentials the emulator also needs are not treated as endpoint vars", () => {
    // `env()` returns keys and secrets beside the endpoint; injecting those
    // into the ambient shell for a `--live` read is not this function's job.
    expect(endpointEnvVarsFor(lexicon("aws", "AWS_ENDPOINT_URL"))).not.toContain("AWS_ACCESS_KEY_ID");
  });

  test("a lexicon with no emulator contributes no var — it resolves its target from config", () => {
    expect(endpointEnvVarsFor(lexicon("k8s"))).toEqual([]);
  });

  test("a lexicon declaring two emulators contributes both vars", () => {
    const fly = {
      name: "fly",
      emulator: [
        lexicon("mudflaps", "FLY_FLAPS_BASE_URL").emulator!,
        lexicon("spritzer", "SPRITES_BASE_URL").emulator!,
      ],
    };
    expect(endpointEnvVarsFor(fly).sort()).toEqual(["FLY_FLAPS_BASE_URL", "SPRITES_BASE_URL"]);
  });

  test("a name that isn't declared at all has no endpoint to apply", () => {
    const environments: EnvironmentDeclaration[] = [{ name: "floci", endpoint: "http://localhost:4566" }];
    const env: NodeJS.ProcessEnv = {};
    const result = applyLiveEndpoint(environments, "prod", [lexicon("aws", "AWS_ENDPOINT_URL")], env);
    expect(result.notice).toBeUndefined();
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
  });
});

describe("zeroResourcesWarning (#1166)", () => {
  test("undefined when nothing was declared to look for", () => {
    expect(zeroResourcesWarning("aws", "floci", 0, { resources: {}, unobserved: {} })).toBeUndefined();
  });

  test("undefined when resources were actually observed", () => {
    expect(
      zeroResourcesWarning("aws", "floci", 2, { resources: { a: {} }, unobserved: {} }),
    ).toBeUndefined();
  });

  test("undefined when the emptiness is already explained by #1089 unobserved", () => {
    expect(
      zeroResourcesWarning("aws", "floci", 2, { resources: {}, unobserved: { a: { reason: "no-binding" } } }),
    ).toBeUndefined();
  });

  test("warns with declared count and the check-endpoint hint when truly empty and unexplained", () => {
    expect(zeroResourcesWarning("aws", "floci", 3, { resources: {}, unobserved: {} })).toBe(
      'aws: 0 live resources for env "floci" (3 declared) — check the endpoint/credentials',
    );
  });
});
