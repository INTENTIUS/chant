/**
 * The `k8s` cluster-binding block typechecks under `satisfies ChantConfig`
 * (#1455), and its schema rejects the typos that land a read on the wrong
 * cluster (#1344).
 *
 * #1455's reproduction is the first test, verbatim: `ChantConfig` did not
 * declare the `k8s` key the lexicon reads, so the one block that stops a live
 * read hitting the wrong cluster was also the one block that could not
 * typecheck — and the path of least resistance was dropping `satisfies
 * ChantConfig`, which silently gives up checking on everything else in the
 * file. The lexicon's module augmentation (declared in `./config.ts` and
 * `./config-schema.ts`) is what makes it compile; this file is the forgejo
 * lexicon's `config-augmentation.test.ts` guard, ported.
 */

import { describe, test, expect } from "vitest";
import type { ChantConfig } from "@intentius/chant";
import type { K8sChantConfig } from "./config";
import { k8sConfigSchema } from "./config-schema";

describe("the k8s config namespace (#1455, #1344)", () => {
  test("the issue's reproduction typechecks as a ChantConfig", () => {
    // The compile-time assertion is the point; the runtime one keeps vitest happy.
    const config = {
      lexicons: ["k8s"],
      environments: ["local"],
      k8s: {
        profiles: { local: { context: "k3d-fountain-local" } },
      } satisfies K8sChantConfig,
    } satisfies ChantConfig;
    expect(config.k8s.profiles.local.context).toBe("k3d-fountain-local");
  });

  test("an empty namespace is valid — every key is optional", () => {
    expect(k8sConfigSchema.safeParse({}).success).toBe(true);
  });

  test("the schema accepts the documented shape", () => {
    const parsed = k8sConfigSchema.safeParse({
      profiles: { prod: { context: "prod-eks" }, staging: { context: "staging-eks" } },
      execCredentialPlugins: ["aws", "my-org-oidc-helper"],
    });
    expect(parsed.success).toBe(true);
  });

  test("an unknown key at the top of the namespace is rejected, not ignored", () => {
    // Core applies `.strict()` when validating a declared namespace
    // (`validateLexiconConfig`), so `profile` instead of `profiles` errors
    // rather than silently leaving every environment unbound.
    expect(k8sConfigSchema.strict().safeParse({ profile: { local: { context: "x" } } }).success).toBe(false);
  });

  test("a typo inside a profile is rejected too — the nesting is strict", () => {
    // `contxt` used to be accepted and ignored, which meant the ambient
    // kubectl context won and the wrong cluster was read (#1488's setup).
    const parsed = k8sConfigSchema.safeParse({ profiles: { prod: { contxt: "prod-eks" } } });
    expect(parsed.success).toBe(false);
  });

  test("a wrong value type is rejected", () => {
    expect(k8sConfigSchema.safeParse({ profiles: { prod: { context: 42 } } }).success).toBe(false);
    expect(k8sConfigSchema.safeParse({ execCredentialPlugins: "aws" }).success).toBe(false);
  });

  test("the schema and the exported interface describe the same namespace", () => {
    const value: K8sChantConfig = {
      profiles: { local: { context: "k3d-fountain-local" } },
      execCredentialPlugins: ["aws"],
    };
    expect(k8sConfigSchema.safeParse(value).success).toBe(true);
  });
});
