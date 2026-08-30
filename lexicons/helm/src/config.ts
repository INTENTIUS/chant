/**
 * Helm capability profiles — the `helm` namespace in `chant.config.ts` (#1235,
 * epic #1228 Phase 1).
 *
 * `helm template` looks like a pure function of (chart, values) and is not:
 * `.Capabilities.KubeVersion` defaults to a version baked into the helm
 * binary (v1.31.0 on helm 3.16.2, v1.35.0 on 4.1.1), and
 * `.Capabilities.APIVersions` is silently empty offline. Two engineers on
 * different helm versions therefore render different bytes from identical
 * inputs unless the capability profile is declared. Declaring it closes both
 * inputs: `--kube-version` and `--api-versions` are passed on every render
 * that references a profile, so the render is a function of
 * (chart, values, profile) and its digest means something.
 *
 * Profiles are scoped **per cluster** (see the epic's Decisions): each
 * cluster declares its own `kubeVersion` / `apiVersions`, and a render is
 * pinned against exactly one profile. This mirrors how the k8s lexicon binds
 * environments to clusters (`k8s.profiles.<env>.context`, chant #1100) — a
 * capability profile is the same per-cluster fact seen from the render side.
 *
 * ```ts
 * export default {
 *   lexicons: ["helm", "k8s"],
 *   helm: {
 *     capabilityProfiles: {
 *       prod: { kubeVersion: "1.33.6", apiVersions: ["monitoring.coreos.com/v1"] },
 *       staging: { kubeVersion: "1.31.4", apiVersions: [] },
 *     },
 *   },
 * };
 * ```
 *
 * A `HelmRender` references a profile by name (`capabilityProfile: "prod"`)
 * or carries one inline. No profile keeps today's unpinned behavior; a
 * reference that resolves to nothing is a build error naming the profile —
 * never a silent fallback to the binary's default.
 *
 * Follows the k8s lexicon's config seam (#1344): the zod schema is the
 * runtime half core validates the namespace with, the interface is the
 * compile-time half projects write `satisfies` against, and the agreement
 * type at the bottom keeps the two from drifting.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import type { ChantConfig } from "@intentius/chant/config";
import { findProjectConfig } from "@intentius/chant/project-root";
import { evaluateProjectConfigSync } from "@intentius/chant/config-sandbox";

/**
 * What `--kube-version` accepts: `1.33`, `1.33.6`, `v1.33.6`. Deliberately
 * looser than full semver (no prerelease/build tags — helm's capability
 * parsing does not want them) and tighter than "any string" (a typo like
 * `"latest"` must fail at declaration, not render as garbage).
 */
export const KUBE_VERSION_PATTERN = /^v?\d+\.\d+(\.\d+)?$/;

/**
 * One cluster's declared capabilities, as written in
 * `helm.capabilityProfiles.<name>`. The profile's name is the record key.
 */
export interface HelmCapabilityProfileConfig {
  /** Kubernetes version the cluster runs, e.g. `"1.33.6"` — passed as `--kube-version`. */
  kubeVersion: string;
  /**
   * API versions available on the cluster beyond the core set, e.g.
   * `"monitoring.coreos.com/v1"` — each passed as `--api-versions`. Omit (or
   * declare empty) for a cluster with no extra API groups charts probe for.
   */
  apiVersions?: string[];
}

/** A resolved capability profile: the declared facts plus the name they were declared under. */
export interface HelmCapabilityProfile extends HelmCapabilityProfileConfig {
  /** The profile's declared name (the `helm.capabilityProfiles` key, or the inline `name`). */
  name: string;
}

/**
 * How a `HelmRender` names its profile: a string resolved against
 * `helm.capabilityProfiles`, or an inline profile object for the rare render
 * whose cluster facts live nowhere else.
 */
export type HelmCapabilityProfileRef = string | HelmCapabilityProfile;

export interface HelmChantConfig {
  /** Per-cluster capability profiles, keyed by profile (cluster/environment) name. */
  capabilityProfiles?: Record<string, HelmCapabilityProfileConfig>;
}

export const helmCapabilityProfileSchema = z.strictObject({
  kubeVersion: z
    .string()
    .regex(KUBE_VERSION_PATTERN, 'must be a Kubernetes version like "1.33.6" or "v1.33"'),
  apiVersions: z.array(z.string().min(1, "apiVersions entries must be non-empty strings")).optional(),
});

export const helmConfigSchema = z.strictObject({
  capabilityProfiles: z.record(z.string(), helmCapabilityProfileSchema).optional(),
});

declare module "@intentius/chant/config" {
  interface ChantConfig {
    helm?: HelmChantConfig;
  }
}

/**
 * Compile-time proof the augmentation above reaches `ChantConfig` — the same
 * guard the k8s and forgejo lexicons carry (#1344). Without it, a project
 * writing the documented snippet with `satisfies ChantConfig` fails to
 * compile and nothing in this repo notices.
 */
export type HelmConfigNamespace = NonNullable<ChantConfig["helm"]>;

/**
 * The schema and the documented interface describe the same namespace. If a
 * field is added to one and not the other, this stops compiling.
 */
type SchemaMatchesInterface = z.infer<typeof helmConfigSchema> extends HelmChantConfig
  ? HelmChantConfig extends z.infer<typeof helmConfigSchema>
    ? true
    : never
  : never;
export type _SchemaAgreesWithInterface = SchemaMatchesInterface;

/**
 * Validate a resolved profile's fields. Returns one message per problem,
 * each naming the profile — empty when the profile is sound.
 *
 * Config-declared profiles are already schema-checked at config load
 * (`helmConfigSchema` via the plugin's `configSchema`); this covers inline
 * profiles handed straight to `HelmRender`, and re-checks resolved ones so a
 * config loaded outside the CLI (a bare API caller) fails identically.
 */
export function validateCapabilityProfile(profile: HelmCapabilityProfile): string[] {
  const errors: string[] = [];
  const label = typeof profile.name === "string" && profile.name.length > 0 ? `"${profile.name}"` : "(unnamed)";
  if (typeof profile.name !== "string" || profile.name.length === 0) {
    errors.push("helm capability profile: name must be a non-empty string");
  }
  if (typeof profile.kubeVersion !== "string" || !KUBE_VERSION_PATTERN.test(profile.kubeVersion)) {
    errors.push(
      `helm capability profile ${label}: kubeVersion must be a Kubernetes version like "1.33.6" or "v1.33", got ${JSON.stringify(profile.kubeVersion)}`,
    );
  }
  if (profile.apiVersions !== undefined) {
    if (!Array.isArray(profile.apiVersions)) {
      errors.push(`helm capability profile ${label}: apiVersions must be an array of non-empty strings`);
    } else {
      for (const entry of profile.apiVersions) {
        if (typeof entry !== "string" || entry.length === 0) {
          errors.push(
            `helm capability profile ${label}: apiVersions entries must be non-empty strings, got ${JSON.stringify(entry)}`,
          );
        }
      }
    }
  }
  return errors;
}

/**
 * Synchronously load the nearest project config's raw object, walking upward
 * from `startDir` exactly like `loadChantConfigUpward` (`findProjectConfig`
 * is the shared walk). Synchronous because `HelmRender` resolves at synth
 * time inside a composite factory — the same constraint that gave
 * `chant lint` `evaluateProjectConfigSync`, which this reuses so the
 * sandbox boundary (chant #1113) stays in one place.
 */
function loadProjectConfigSync(startDir: string): { config: ChantConfig; configPath?: string } {
  const { dir, configPath } = findProjectConfig(startDir);
  if (!configPath) return { config: {} };
  if (configPath.endsWith(".json")) {
    return { config: JSON.parse(readFileSync(configPath, "utf8")) as ChantConfig, configPath };
  }
  return { config: evaluateProjectConfigSync(configPath, dir) as ChantConfig, configPath };
}

/**
 * Resolve a `HelmRender`'s profile reference to a concrete profile.
 *
 * - An inline profile object is validated and returned as-is.
 * - A string is looked up in `helm.capabilityProfiles` of the nearest
 *   `chant.config.ts`/`.json` above `opts.startDir` (default: cwd).
 *
 * A reference that resolves to nothing throws, naming the missing profile,
 * the profiles that ARE declared, and where to declare it — a declared but
 * unresolvable profile must be a build error, never a silent fall-through to
 * the helm binary's default capabilities (epic #1228, finding 1).
 */
export function resolveCapabilityProfile(
  ref: HelmCapabilityProfileRef,
  opts?: { startDir?: string },
): HelmCapabilityProfile {
  if (typeof ref !== "string") {
    const errors = validateCapabilityProfile(ref);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    return ref;
  }

  const startDir = opts?.startDir ?? process.cwd();
  const { config, configPath } = loadProjectConfigSync(startDir);
  const profiles = config.helm?.capabilityProfiles;
  const declared = profiles?.[ref];
  if (!declared) {
    const names = Object.keys(profiles ?? {});
    const where = configPath ?? `chant.config.ts (no config found above ${startDir})`;
    throw new Error(
      `helm capability profile "${ref}" is not declared` +
        (names.length > 0 ? ` — declared profiles: ${names.join(", ")}` : "") +
        `. Declare it as helm.capabilityProfiles.${ref} = { kubeVersion, apiVersions } in ${where}.`,
    );
  }

  const profile: HelmCapabilityProfile = { name: ref, ...declared };
  const errors = validateCapabilityProfile(profile);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return profile;
}
