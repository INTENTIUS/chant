/**
 * The `forgejo` namespace in `chant.config.ts` (#1344).
 *
 * ```ts
 * import type { ChantConfig } from "@intentius/chant/config";
 * import "@intentius/chant-lexicon-forgejo";   // brings the `forgejo` key into ChantConfig
 *
 * export default {
 *   lexicons: ["forgejo"],
 *   forgejo: {
 *     runnerLabels: { "ubuntu-latest": "docker" },
 *     actionsRoot: "https://code.forgejo.org",
 *   },
 * } satisfies ChantConfig;
 * ```
 *
 * One schema, three consumers: core validates the namespace against it at load,
 * the type below is derived from it, and that derived type is what augments
 * `ChantConfig` — so an unknown key fails at build time and at compile time for
 * the same reason, rather than being silently ignored at both.
 */

import { z } from "zod";
import type { ChantConfig } from "@intentius/chant/config";

/**
 * `strictObject`, not `object`. Core applies `.strict()` to the top level of a
 * declared namespace itself, but nested objects are the lexicon's own to make
 * strict — and `runnerLabels` is exactly where a typo would otherwise land.
 */
export const forgejoConfigSchema = z.strictObject({
  /**
   * GitHub-hosted runner label → Forgejo label. A label with no mapping falls
   * back to the default Forgejo label and is flagged by WFJ011.
   */
  runnerLabels: z.record(z.string(), z.string()).optional(),
  /** Root the common `actions/*` refs are rewritten under. */
  actionsRoot: z.string().optional(),
});

export type ForgejoConfig = z.infer<typeof forgejoConfigSchema>;

declare module "@intentius/chant/config" {
  interface ChantConfig {
    forgejo?: ForgejoConfig;
  }
}

/**
 * Compile-time proof that the augmentation above reaches `ChantConfig` (#1344).
 *
 * Without it this line is `Property 'forgejo' does not exist on type
 * 'ChantConfig'` — which is exactly the error a user's `chant.config.ts` got.
 * It lives here rather than in a test because the root tsconfig excludes test
 * files from typechecking, so a compile-time claim asserted in one is checked
 * by nothing.
 */
export type ForgejoConfigNamespace = NonNullable<ChantConfig["forgejo"]>;
