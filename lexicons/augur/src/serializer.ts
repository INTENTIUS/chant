/**
 * augur serializer: the declared traffic levels, as a document.
 *
 * The estate's own artifacts are aws's template and k8s's manifest. This
 * lexicon's artifact is the question those estates are to be asked — one JSON
 * document naming every {@link Profile} a project declared, which is what
 * #2358's Op iterates and what a reader can diff to see that a level changed.
 *
 * It is not the engine's request. A serializer is handed its own lexicon's
 * partition of the build (`packages/core/src/build.ts`, step 7), so it can see
 * augur's profiles and none of the estate; the request is assembled from the
 * whole build by `./request.ts` on the `predictBehaviour` path, where the whole
 * build is what the caller hands over. Trying to build the request here would
 * produce one containing nothing but profiles.
 *
 * Byte-stable: profiles sorted by name, object keys written in a fixed order,
 * two-space indent, one trailing newline. `chant build` claims byte-identical
 * output on re-run and this output is part of that claim.
 */

import type { Declarable } from "@intentius/chant/declarable";
import { isResourceDeclarable } from "@intentius/chant/declarable";
import type { Serializer } from "@intentius/chant/serializer";
import { PROFILE_TYPE } from "./resources";

/** The wire version of the emitted document. */
export const AUGUR_PROFILES_VERSION = "augur/profiles/v1" as const;

/** One profile, as it appears in the emitted document. */
export interface SerializedProfile {
  name: string;
  traffic: string;
  description?: string;
}

/** Pull the declared profiles out of a partition, sorted and normalized. */
export function collectProfiles(entities: Map<string, Declarable>): SerializedProfile[] {
  const profiles: SerializedProfile[] = [];
  for (const [name, entity] of entities) {
    if (!isResourceDeclarable(entity) || entity.entityType !== PROFILE_TYPE) continue;
    const props = (entity.props ?? {}) as Record<string, unknown>;
    const traffic = typeof props.traffic === "string" ? props.traffic : "";
    const description = typeof props.description === "string" ? props.description : undefined;
    profiles.push({ name, traffic, ...(description ? { description } : {}) });
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

export const augurSerializer: Serializer = {
  name: "augur",
  rulePrefix: "AUG",

  serialize(entities: Map<string, Declarable>): string {
    const profiles = collectProfiles(entities);
    return `${JSON.stringify({ augur: AUGUR_PROFILES_VERSION, profiles }, null, 2)}\n`;
  },
};
