/**
 * The `fountain.profiles` config namespace (#2124).
 *
 * Mirrors `lexicons/forgejo/src/config-augmentation.test.ts`: the documented
 * `chant.config.ts` example must typecheck as a `ChantConfig`, the schema
 * must reject an unrecognized key rather than silently accept it, and
 * `resolveProfile` is a pure precedence function the activities and the
 * opRuntime provider (#2126) can both call.
 */

import { describe, test, expect } from "vitest";
import type { ChantConfig } from "@intentius/chant/config";
import { fountainConfigSchema, resolveProfile, type FountainConfig } from "./config";

describe("the fountain config namespace (#2124)", () => {
  test("the documented example typechecks as a ChantConfig", () => {
    const config = {
      lexicons: ["fountain"],
      fountain: {
        profiles: {
          staging: {
            endpoint: "https://fountain-staging.example.com",
            token: { env: "FOUNTAIN_STAGING_TOKEN" },
            team: "staging-steward",
          },
          prod: {
            endpoint: "https://fountain.inevitable.fyi",
            token: { env: "FOUNTAIN_PROD_TOKEN" },
          },
        },
        defaultProfile: "staging",
      },
    } satisfies ChantConfig;
    expect(config.fountain.profiles.staging.endpoint).toBe("https://fountain-staging.example.com");
  });

  test("an empty namespace is valid — every key is optional", () => {
    expect(fountainConfigSchema.safeParse({}).success).toBe(true);
  });

  test("the schema accepts the documented shape", () => {
    const parsed = fountainConfigSchema.safeParse({
      profiles: {
        staging: { endpoint: "https://x", token: { env: "FOUNTAIN_STAGING_TOKEN" } },
      },
      defaultProfile: "staging",
    });
    expect(parsed.success).toBe(true);
  });

  test("an unknown key at the namespace top level is rejected, naming the key", () => {
    const parsed = fountainConfigSchema.safeParse({ profils: {} });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(JSON.stringify(parsed.error.issues)).toContain("profils");
    }
  });

  test("an unknown key inside a profile is rejected", () => {
    const parsed = fountainConfigSchema.safeParse({
      profiles: { staging: { endpoint: "https://x", token: { env: "T" }, teem: "oops" } },
    });
    expect(parsed.success).toBe(false);
  });

  test("a profile token must be { env }, not a bare string", () => {
    const parsed = fountainConfigSchema.safeParse({
      profiles: { staging: { endpoint: "https://x", token: "literal-value" } },
    });
    expect(parsed.success).toBe(false);
  });

  test("the exported type is derived from the schema, not written twice", () => {
    const value: FountainConfig = {
      profiles: { staging: { endpoint: "https://x", token: { env: "T" } } },
    };
    expect(fountainConfigSchema.safeParse(value).success).toBe(true);
  });
});

describe("resolveProfile (#2124)", () => {
  const config: Pick<ChantConfig, "fountain"> = {
    fountain: {
      profiles: {
        staging: { endpoint: "https://staging", token: { env: "STAGING_TOKEN" } },
        prod: { endpoint: "https://prod", token: { env: "PROD_TOKEN" } },
      },
      defaultProfile: "staging",
    },
  };

  test("returns the named profile when it exists", () => {
    expect(resolveProfile(config, "prod")).toEqual({
      endpoint: "https://prod",
      token: { env: "PROD_TOKEN" },
    });
  });

  test("falls back to defaultProfile when no name is given", () => {
    expect(resolveProfile(config, undefined)).toEqual({
      endpoint: "https://staging",
      token: { env: "STAGING_TOKEN" },
    });
  });

  test("falls back to defaultProfile when the named profile doesn't exist", () => {
    expect(resolveProfile(config, "no-such-profile")).toEqual({
      endpoint: "https://staging",
      token: { env: "STAGING_TOKEN" },
    });
  });

  test("returns undefined when there is no defaultProfile and no name matches", () => {
    const noDefault: Pick<ChantConfig, "fountain"> = {
      fountain: { profiles: config.fountain!.profiles },
    };
    expect(resolveProfile(noDefault, "no-such-profile")).toBeUndefined();
    expect(resolveProfile(noDefault, undefined)).toBeUndefined();
  });

  test("returns undefined when the project declares no fountain.profiles at all", () => {
    expect(resolveProfile(undefined, "staging")).toBeUndefined();
    expect(resolveProfile({}, "staging")).toBeUndefined();
    expect(resolveProfile({ fountain: {} }, "staging")).toBeUndefined();
  });
});
