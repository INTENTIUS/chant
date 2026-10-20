/**
 * The `fountain` namespace in `chant.config.ts` (#2124).
 *
 * ```ts
 * import type { ChantConfig } from "@intentius/chant/config";
 * import "@intentius/chant-lexicon-fountain";   // brings the `fountain` key into ChantConfig
 *
 * export default {
 *   lexicons: ["fountain"],
 *   fountain: {
 *     profiles: {
 *       staging: {
 *         endpoint: "https://fountain-staging.example.com",
 *         token: { env: "FOUNTAIN_STAGING_TOKEN" },
 *         steward: "staging-steward",
 *       },
 *       prod: {
 *         endpoint: "https://fountain.inevitable.fyi",
 *         token: { env: "FOUNTAIN_PROD_TOKEN" },
 *       },
 *     },
 *     defaultProfile: "staging",
 *   },
 * } satisfies ChantConfig;
 * ```
 *
 * One schema, three consumers: core validates the namespace against it at load,
 * the type below is derived from it, and that derived type is what augments
 * `ChantConfig` — so an unknown key fails at build time and at compile time for
 * the same reason, rather than being silently ignored at both.
 *
 * A project that declares no `fountain.profiles` at all keeps working exactly
 * as before: `resolveProfile` returns `undefined`, and `fountainApply` /
 * `fountainRun` fall back to `FOUNTAIN_ENDPOINT` / `FOUNTAIN_TOKEN` /
 * `DEFAULT_FOUNTAIN_BASE_URL`, same as pre-#2124.
 */

import { z } from "zod";
import type { ChantConfig } from "@intentius/chant/config";

/**
 * `strictObject`, not `object`. Core applies `.strict()` to the top level of a
 * declared namespace itself, but nested objects are the lexicon's own to make
 * strict — and a profile is exactly where a typo'd field would otherwise land
 * silently.
 */
export const fountainProfileSchema = z.strictObject({
  /** Base URL of the fountain instance this profile targets. */
  endpoint: z.string(),
  /**
   * The bearer token, named by its environment variable — never a literal
   * value. FTN001 refuses a literal string here.
   */
  token: z.strictObject({ env: z.string() }),
  /**
   * Default steward (a `Steward`'s name, which is its Agent's) that `chant run
   * --on fountain` posts to when the op has no steward of its own. Its runs go
   * to the one conversation bound to the channel `chant:steward:<name>`.
   */
  steward: z.string().optional(),
  /**
   * @deprecated The name of `steward` while a steward was a `Teammate`, which
   * Managoat removed with the team (managoat/managoat#2793). Read as
   * `steward`, with a warning; `steward` wins when both are set.
   */
  team: z.string().optional(),
});

export const fountainConfigSchema = z.strictObject({
  profiles: z.record(z.string(), fountainProfileSchema).optional(),
  /** Profile used when a call names none. */
  defaultProfile: z.string().optional(),
});

export type FountainProfile = z.infer<typeof fountainProfileSchema>;
export type FountainConfig = z.infer<typeof fountainConfigSchema>;

declare module "@intentius/chant/config" {
  interface ChantConfig {
    fountain?: FountainConfig;
  }
}

/**
 * Compile-time proof that the augmentation above reaches `ChantConfig` (#1344).
 *
 * Without it this line is `Property 'fountain' does not exist on type
 * 'ChantConfig'` — which is exactly the error a user's `chant.config.ts` got.
 * It lives here rather than in a test because the root tsconfig excludes test
 * files from typechecking, so a compile-time claim asserted in one is checked
 * by nothing.
 */
export type FountainConfigNamespace = NonNullable<ChantConfig["fountain"]>;

/**
 * Resolve a fountain profile: the named profile, then `defaultProfile`, then
 * `undefined`. Pure — never reads the environment or touches disk, so callers
 * (the activities, and the `opRuntime` provider in #2126) decide what
 * `undefined` means for them. `fountainApply` / `fountainRun` fall back to
 * `FOUNTAIN_ENDPOINT` / `FOUNTAIN_TOKEN` when this returns `undefined`.
 */
export function resolveProfile(
  config: Pick<ChantConfig, "fountain"> | undefined,
  name?: string,
): FountainProfile | undefined {
  const profiles = config?.fountain?.profiles;
  if (!profiles) return undefined;

  if (name !== undefined) {
    const named = profiles[name];
    if (named) return named;
  }

  const defaultName = config?.fountain?.defaultProfile;
  if (defaultName !== undefined) {
    return profiles[defaultName];
  }

  return undefined;
}

let warnedTeam = false;

/**
 * A profile's default steward: `steward`, else the deprecated `team` (#2793).
 * `team` warns once per process, so a run that resolves the steward several
 * times says it once.
 */
export function stewardOfProfile(
  profile: FountainProfile | undefined,
  warn: (msg: string) => void = (msg) => console.error(msg),
): string | undefined {
  if (profile?.steward) return profile.steward;
  if (!profile?.team) return undefined;
  if (!warnedTeam) {
    warnedTeam = true;
    warn(
      `[fountain] fountain.profiles.<name>.team is deprecated: Managoat has no team. ` +
        `Rename it to steward; it means the same steward.`,
    );
  }
  return profile.team;
}

/** Tests only: let the next `team` read warn again. */
export function __resetTeamWarningForTests(): void {
  warnedTeam = false;
}
