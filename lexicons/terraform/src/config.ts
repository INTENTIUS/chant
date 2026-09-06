/**
 * The `terraform` namespace in `chant.config.ts` (#1344).
 *
 * ```ts
 * import type { ChantConfig } from "@intentius/chant/config";
 * import "@intentius/chant-lexicon-terraform";  // brings the `terraform` key into ChantConfig
 *
 * export default {
 *   lexicons: ["terraform"],
 *   terraform: {
 *     binary: "tofu",
 *     roots: {
 *       app: { dir: "./terraform/app", workspace: "prod", varFiles: ["prod.tfvars"] },
 *     },
 *   },
 * } satisfies ChantConfig;
 * ```
 *
 * One schema, three consumers: core validates the namespace against it at load,
 * the type below is derived from it, and that derived type is what augments
 * `ChantConfig`, so an unknown key fails at build time and at compile time for
 * the same reason, rather than being silently ignored at both.
 */

import { z } from "zod";
import type { ChantConfig } from "@intentius/chant/config";

/**
 * One Terraform root module chant reads. `dir` is the only required field:
 * everything else names how the root is invoked rather than what it declares.
 *
 * `strictObject`, not `object`. Core applies `.strict()` to the top level of a
 * declared namespace itself, but nested objects are the lexicon's own to make
 * strict, and a root entry is exactly where a typo (`varfiles`) would
 * otherwise land silently.
 */
export const terraformRootSchema = z.strictObject({
  /** Root module directory, relative to the project root (where `chant.config.*` lives). */
  dir: z.string(),
  /** Terraform workspace to select for this root. Omitted means `default`. */
  workspace: z.string().optional(),
  /** `-var-file` arguments, in order, relative to `dir`. */
  varFiles: z.array(z.string()).optional(),
  /** `-backend-config` key/value pairs handed to `init`. */
  backendConfig: z.record(z.string(), z.string()).optional(),
});

export const terraformConfigSchema = z.strictObject({
  /**
   * Which CLI drives the roots. The two are wire-compatible for everything
   * this lexicon does, so the choice is recorded rather than inferred.
   */
  binary: z.enum(["terraform", "tofu"]).optional(),
  /** Named root modules. The name is the entity-key prefix, so keep it stable. */
  roots: z.record(z.string(), terraformRootSchema),
});

export type TerraformRootConfig = z.infer<typeof terraformRootSchema>;
export type TerraformConfig = z.infer<typeof terraformConfigSchema>;

declare module "@intentius/chant/config" {
  interface ChantConfig {
    terraform?: TerraformConfig;
  }
}

/**
 * Compile-time proof that the augmentation above reaches `ChantConfig` (#1344).
 *
 * Without it this line is `Property 'terraform' does not exist on type
 * 'ChantConfig'`, which is exactly the error a user's `chant.config.ts` gets.
 * It lives here rather than in a test because the root tsconfig excludes test
 * files from typechecking, so a compile-time claim asserted in one is checked
 * by nothing.
 */
export type TerraformConfigNamespace = NonNullable<ChantConfig["terraform"]>;
