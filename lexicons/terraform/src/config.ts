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
 * chant's cross-lexicon delete-mode vocabulary (`lexicons/k8s/src/op/
 * activities/kubectl.ts`'s `ApplyDeleteMode`, `lexicons/temporal/src/op/
 * activities/apply.ts`'s `DeleteMode`), read here for a live root and mapped
 * onto choudoufu's `policy` block (#2106): `"never"` requires the root's
 * `policy` to set `undeclared_tagged` to `"keep"`, `"untag"` or `"report"`
 * (TF026 enforces this at build time); `"owned-only"` is choudoufu's own
 * default verb for that quadrant (`delete`) and needs nothing; `"gated"`
 * needs nothing beyond `TerraformApplyOp`'s own approval gate. Inert on a
 * stock root: choudoufu's `policy` block does not exist there.
 */
export const terraformDeleteModeSchema = z.enum(["never", "owned-only", "gated"]);
export type TerraformDeleteMode = z.infer<typeof terraformDeleteModeSchema>;

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
  /** This root's declared delete mode. See {@link terraformDeleteModeSchema}. */
  delete: terraformDeleteModeSchema.optional(),
});

export const terraformConfigSchema = z.strictObject({
  /**
   * Which CLI drives the roots. `terraform` and `tofu` are wire-compatible
   * for everything this lexicon does, so the choice is recorded rather than
   * inferred. `choudoufu` (#2103) is an OpenTofu fork: a root running it also
   * needs a declared estate (a `live` block or an `estate.chdf.hcl` sidecar,
   * seen by the shared HCL parse) before it counts as live. Declaring the
   * binary alone runs the root stock, exactly as `terraform`/`tofu` do.
   */
  binary: z.enum(["terraform", "tofu", "choudoufu"]).optional(),
  /**
   * How far a root's parse follows its `module` calls (#2112), spelled the
   * way tflint spells it. `local` (the default) reads modules sourced from a
   * relative path, so TF014, TF015 and TF020 see inside them; `none` reads
   * only each root's own directory; `all` is reserved for fetching registry
   * and git modules and is refused with a message, since chant fetches
   * nothing. See `hcl/descend.ts`.
   */
  callModuleType: z.enum(["local", "none", "all"]).optional(),
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
