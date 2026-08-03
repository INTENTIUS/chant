/**
 * The documented `chant.config.ts` example compiles (#1344).
 *
 * It did not: `ChantConfig` is a closed interface, so `satisfies ChantConfig`
 * on a config carrying a `forgejo` key was `error TS2353: Object literal may
 * only specify known properties`. The lexicon augments `ChantConfig` with the
 * type derived from its own schema, so importing the package — which a project
 * configuring forgejo does anyway — brings the key into the interface.
 */

import { describe, test, expect } from "vitest";
import type { ChantConfig } from "@intentius/chant/config";
import { forgejoConfigSchema, type ForgejoConfig } from "./config";

describe("the forgejo config namespace (#1344)", () => {
  test("the documented example typechecks as a ChantConfig", () => {
    // The compile-time assertion is the point; the runtime one keeps vitest happy.
    const config = {
      lexicons: ["forgejo"],
      forgejo: {
        runnerLabels: { "ubuntu-latest": "docker", "ubuntu-22.04": "ubuntu-lts" },
        actionsRoot: "https://code.forgejo.org",
      },
    } satisfies ChantConfig;
    expect(config.forgejo.actionsRoot).toBe("https://code.forgejo.org");
  });

  test("an empty namespace is valid — every key is optional", () => {
    expect(forgejoConfigSchema.safeParse({}).success).toBe(true);
  });

  test("the schema accepts the documented shape", () => {
    const parsed = forgejoConfigSchema.safeParse({
      runnerLabels: { "ubuntu-latest": "docker" },
      actionsRoot: "https://code.forgejo.org",
    });
    expect(parsed.success).toBe(true);
  });

  test("a typo is rejected rather than silently defaulted", () => {
    // `runnerLabel` used to be accepted and ignored: the dialect fell back to
    // its defaults and said nothing.
    const parsed = forgejoConfigSchema.strict().safeParse({ runnerLabel: { a: "b" } });
    expect(parsed.success).toBe(false);
  });

  test("a wrong value type is rejected", () => {
    expect(forgejoConfigSchema.safeParse({ actionsRoot: 42 }).success).toBe(false);
  });

  test("the exported type is derived from the schema, not written twice", () => {
    const value: ForgejoConfig = { actionsRoot: "https://example.test" };
    expect(forgejoConfigSchema.safeParse(value).success).toBe(true);
  });
});
