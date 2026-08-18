import { PseudoParameter, createPseudoParameters } from "@intentius/chant/pseudo-parameter";

export { PseudoParameter };

/**
 * Render pseudo-parameters — environment-resolved values a project references
 * without hard-coding. Each serializes to a `{ Ref: "Render::..." }` marker
 * that the serializer resolves from an environment variable at build time (see
 * PSEUDO_ENV_MAP in ./serializer.ts), mirroring fly's `Fly.OrgSlug`.
 *
 *   - OwnerId → the workspace (team or personal) id (RENDER_OWNER_ID), e.g. `tea-…`.
 *     Every ownerId chant fills in defaults to this, so a stack rarely names it.
 *   - Region  → the target region (RENDER_REGION), default `oregon`.
 */
export const { OwnerId, Region } = createPseudoParameters({
  OwnerId: "Render::OwnerId",
  Region: "Render::Region",
});

/**
 * Render namespace containing all pseudo-parameters.
 */
export const Render = {
  OwnerId,
  Region,
} as const;
