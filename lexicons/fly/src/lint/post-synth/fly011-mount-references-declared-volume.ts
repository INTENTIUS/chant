/**
 * FLY011: A machine mount must reference a declared volume.
 *
 * Every machine `config.mounts[].volume` must resolve to a `Volume` declared in
 * the stack. A mount pointing at a volume that does not exist is rejected at
 * apply time, so catch it at synth. This is a whole-stack check: it reads all
 * entities in the build (`ctx.entities`), so the mount and the Volume can be
 * declared in different files.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readProps, entityTypeOf } from "./fly-helpers";

const MACHINE_ENTITY_TYPE = "Fly::Machines::Machine";
const VOLUME_ENTITY_TYPE = "Fly::Machines::Volume";

export const fly011: PostSynthCheck = {
  id: "FLY011",
  description: "A machine mount's volume must resolve to a Volume declared in the stack",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    // A mount can name a declared volume by the Volume's `name` or by its
    // logical (declaration) name — collect both.
    const declaredVolumes = new Set<string>();
    for (const [logicalName, entity] of ctx.entities) {
      if (entityTypeOf(entity) !== VOLUME_ENTITY_TYPE) continue;
      declaredVolumes.add(logicalName);
      const name = readProps(entity).name;
      if (typeof name === "string" && name.length > 0) declaredVolumes.add(name);
    }

    for (const [machineName, entity] of ctx.entities) {
      if (entityTypeOf(entity) !== MACHINE_ENTITY_TYPE) continue;
      const config = readProps(entity).config;
      if (!config) continue;
      const mounts = readProps(config).mounts;
      if (!Array.isArray(mounts)) continue;

      for (const mount of mounts) {
        const volume = readProps(mount).volume;
        // Only a string names a volume by value. A Declarable/AttrRef is a live
        // reference to a Volume that exists in the stack by construction, so it
        // never dangles — skip it to avoid false positives.
        if (typeof volume !== "string" || volume.length === 0) continue;
        if (!declaredVolumes.has(volume)) {
          diagnostics.push({
            checkId: "FLY011",
            severity: "error",
            message: `Machine "${machineName}" mounts volume "${volume}", which is not declared as a Volume in the stack.`,
            entity: machineName,
            lexicon: "fly",
          });
        }
      }
    }

    return diagnostics;
  },
};
