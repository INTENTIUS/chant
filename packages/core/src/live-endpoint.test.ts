import { describe, test, expect } from "vitest";
import { applyLiveEndpoint, zeroResourcesWarning, LEXICON_ENDPOINT_ENV_VAR } from "./live-endpoint";
import type { EnvironmentDeclaration } from "./config";

describe("applyLiveEndpoint (#1166)", () => {
  test("no-op — and no notice — when the environment declares no endpoint at all", () => {
    const env: NodeJS.ProcessEnv = {};
    const result = applyLiveEndpoint(["floci", "prod"], "floci", ["aws"], env);
    expect(result.notice).toBeUndefined();
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
    result.restore(); // always safe, even as a no-op
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
  });

  test("applies the declared endpoint to the ambient var of every observing lexicon that has one", () => {
    const environments: EnvironmentDeclaration[] = [{ name: "floci", endpoint: "http://localhost:4566" }];
    const env: NodeJS.ProcessEnv = {};
    const result = applyLiveEndpoint(environments, "floci", ["aws"], env);
    expect(env.AWS_ENDPOINT_URL).toBe("http://localhost:4566");
    expect(result.notice).toMatch(/environment "floci" declares endpoint http:\/\/localhost:4566/);
    expect(result.notice).toMatch(/AWS_ENDPOINT_URL/);
  });

  test("restore() removes exactly what it set, not a pre-existing value it didn't touch", () => {
    const environments: EnvironmentDeclaration[] = [{ name: "floci", endpoint: "http://localhost:4566" }];
    const env: NodeJS.ProcessEnv = {};
    const result = applyLiveEndpoint(environments, "floci", ["aws"], env);
    expect(env.AWS_ENDPOINT_URL).toBe("http://localhost:4566");
    result.restore();
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
  });

  test("ambient wins: an already-set var is left untouched, and the notice says so", () => {
    const environments: EnvironmentDeclaration[] = [{ name: "floci", endpoint: "http://localhost:4566" }];
    const env: NodeJS.ProcessEnv = { AWS_ENDPOINT_URL: "http://real-endpoint.example" };
    const result = applyLiveEndpoint(environments, "floci", ["aws"], env);
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
    const result = applyLiveEndpoint(environments, "floci", ["aws", "fly"], env);
    expect(env.AWS_ENDPOINT_URL).toBe("http://localhost:4566");
    expect(env.FLY_FLAPS_BASE_URL).toBe("http://localhost:4566");
    result.restore();
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
    expect(env.FLY_FLAPS_BASE_URL).toBeUndefined();
  });

  test("mixed: one lexicon's var is applied, another's ambient value wins — both show up in the notice", () => {
    const environments: EnvironmentDeclaration[] = [{ name: "floci", endpoint: "http://localhost:4566" }];
    const env: NodeJS.ProcessEnv = { FLY_FLAPS_BASE_URL: "http://real-fly.example" };
    const result = applyLiveEndpoint(environments, "floci", ["aws", "fly"], env);
    expect(env.AWS_ENDPOINT_URL).toBe("http://localhost:4566"); // applied
    expect(env.FLY_FLAPS_BASE_URL).toBe("http://real-fly.example"); // ambient wins
    expect(result.notice).toMatch(/applied to AWS_ENDPOINT_URL/);
    expect(result.notice).toMatch(/ambient FLY_FLAPS_BASE_URL already set/);
  });

  test("audited endpoint-knob registry: only aws and fly (gcp/k8s/azure/temporal resolve via config, not an ambient var)", () => {
    expect(LEXICON_ENDPOINT_ENV_VAR).toEqual({ aws: "AWS_ENDPOINT_URL", fly: "FLY_FLAPS_BASE_URL" });
  });

  test("a name that isn't declared at all has no endpoint to apply", () => {
    const environments: EnvironmentDeclaration[] = [{ name: "floci", endpoint: "http://localhost:4566" }];
    const env: NodeJS.ProcessEnv = {};
    const result = applyLiveEndpoint(environments, "prod", ["aws"], env);
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
