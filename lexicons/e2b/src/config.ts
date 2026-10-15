/**
 * The `e2b` namespace in `chant.config.ts`.
 *
 * ```ts
 * import type { ChantConfig } from "@intentius/chant/config";
 * import "@intentius/chant-lexicon-e2b";   // brings the `e2b` key into ChantConfig
 *
 * export default {
 *   lexicons: ["e2b"],
 *   e2b: {
 *     profiles: {
 *       prod: {
 *         apiKey: { env: "E2B_API_KEY" },
 *         domain: "e2b.loam.example.com",     // omit for hosted E2B
 *         steward: "prod-steward",
 *         gitToken: { env: "GITHUB_TOKEN" },
 *       },
 *     },
 *     defaultProfile: "prod",
 *   },
 * } satisfies ChantConfig;
 * ```
 *
 * One schema, three consumers, as for fountain's namespace: core validates the
 * namespace against it at load, the type below is derived from it, and that
 * type augments `ChantConfig`. A project with no `e2b.profiles` keeps working:
 * the runtime falls back to `E2B_API_KEY`, `E2B_DOMAIN` and `CHANT_GIT_TOKEN`.
 */

import { z } from "zod";
import type { ChantConfig } from "@intentius/chant/config";

/** A secret named by its environment variable, never a literal value. */
const envRef = z.strictObject({ env: z.string() });

export const e2bProfileSchema = z.strictObject({
  /** The E2B API key, by environment variable. Default `E2B_API_KEY`. */
  apiKey: envRef.optional(),
  /**
   * The E2B domain the SDK talks to: `api.<domain>` and `<port>-<id>.<domain>`.
   * Omitted, the SDK's own default (hosted E2B, or `E2B_DOMAIN`).
   */
  domain: z.string().optional(),
  /** The template a steward's sandbox is made from. Default `base`. It needs git and Node. */
  template: z.string().optional(),
  /**
   * The steward's name: the one sandbox every run of this profile lands on,
   * found again by its `chant/steward` metadata. Default: the repository's name.
   */
  steward: z.string().optional(),
  /**
   * The repository the sandbox clones, as an https URL. Default: `origin`'s
   * URL, with an ssh URL rewritten to https.
   */
  repo: z.string().optional(),
  /**
   * A token for that repository, by environment variable, so the sandbox can
   * fetch a private repo and push chant's ledger branch. It is handed to each
   * command in the sandbox and never written to its disk.
   */
  gitToken: envRef.optional(),
});

export const e2bConfigSchema = z.strictObject({
  profiles: z.record(z.string(), e2bProfileSchema).optional(),
  /** Profile used when a run names none. */
  defaultProfile: z.string().optional(),
});

export type E2bProfile = z.infer<typeof e2bProfileSchema>;
export type E2bConfig = z.infer<typeof e2bConfigSchema>;

declare module "@intentius/chant/config" {
  interface ChantConfig {
    e2b?: E2bConfig;
  }
}

/** Compile-time proof that the augmentation reaches `ChantConfig`, as in fountain's config. */
export type E2bConfigNamespace = NonNullable<ChantConfig["e2b"]>;

/**
 * The named profile, else `defaultProfile`, else `undefined`. A name that is
 * not declared is an error rather than a fall back to the default: running
 * against the wrong steward because a profile name was misspelt is the one
 * mistake a runtime must not make.
 */
export function resolveProfile(config: Pick<ChantConfig, "e2b"> | undefined, name?: string): E2bProfile | undefined {
  const profiles = config?.e2b?.profiles;
  if (name !== undefined) {
    const named = profiles?.[name];
    if (!named) {
      throw new Error(
        `e2b runtime: no profile "${name}" under e2b.profiles in chant.config.ts. ` +
          `Declare it, or drop --profile to use e2b.defaultProfile.`,
      );
    }
    return named;
  }
  const fallback = config?.e2b?.defaultProfile;
  return fallback !== undefined ? profiles?.[fallback] : undefined;
}
