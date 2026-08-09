/**
 * Shared helpers for the k3s post-synth checks.
 *
 * These checks read the chant model (`ctx.entities`), not the emitted
 * YAML: an emitted config.yaml carries no marker naming its own role, so
 * the entity type is the only honest way to know a document is a server
 * config, an agent config, or a registries file. The audit catalog marks
 * every entity-based check `yamlBased: false` accordingly.
 */

import type { PostSynthContext } from "@intentius/chant/lint/post-synth";

export interface K3sEntity {
  name: string;
  entityType: string;
  props: Record<string, unknown>;
}

/** Every declared k3s entity of one type, with its props. */
export function entitiesOfType(ctx: PostSynthContext, entityType: string): K3sEntity[] {
  const out: K3sEntity[] = [];
  for (const [name, entity] of ctx.entities) {
    const e = entity as { entityType?: string; props?: unknown };
    if (e.entityType !== entityType) continue;
    const props =
      typeof e.props === "object" && e.props !== null ? (e.props as Record<string, unknown>) : {};
    out.push({ name, entityType, props });
  }
  return out;
}

export function configEntities(ctx: PostSynthContext): K3sEntity[] {
  return [...entitiesOfType(ctx, "K3s::Server"), ...entitiesOfType(ctx, "K3s::Agent")];
}
