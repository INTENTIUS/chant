import { PseudoParameter, createPseudoParameters } from "@intentius/chant/pseudo-parameter";

export { PseudoParameter };

/**
 * Fly pseudo-parameters — environment-resolved values a project references
 * without hard-coding. Each serializes to a `{ Ref: "Fly::..." }` marker that
 * the serializer resolves from an environment variable at build time (see
 * PSEUDO_ENV_MAP in ./serializer.ts), mirroring gcp's `GCP.Region` /
 * `GCP.ProjectId`.
 *
 *   - Region  → the target Fly region (FLY_REGION), e.g. `iad`.
 *   - OrgSlug → the owning org slug (FLY_ORG / FLY_ORG_SLUG).
 *   - AppName → the target app name (FLY_APP_NAME).
 */
export const { Region, OrgSlug, AppName } = createPseudoParameters({
  Region: "Fly::Region",
  OrgSlug: "Fly::OrgSlug",
  AppName: "Fly::AppName",
});

/**
 * Fly namespace containing all pseudo-parameters.
 */
export const Fly = {
  Region,
  OrgSlug,
  AppName,
} as const;
