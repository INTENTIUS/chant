import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { readArray, readPath, readString } from "../../entity-props";
import { GVC, entitiesOfType } from "./helpers";

/** Location links look like `/org/ORG/location/aws-us-east-1` or `//location/aws-us-east-1`. */
const LOCATION_LINK = /\/location\/((aws|gcp|azure)-[a-z0-9-]+|[a-z0-9-]+)$/;

/**
 * CPL042: a GVC with nowhere to run.
 *
 * Placement is a GVC-level decision, and a GVC with neither `locationLinks` nor
 * a `locationQuery` accepts workloads and schedules them nowhere. The workloads
 * apply cleanly and never become ready.
 */
export const gvcPlacementCheck: PostSynthCheck = {
  id: "CPL042",
  description: "A GVC must declare where its workloads run",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [entityName, entity] of entitiesOfType(ctx.entities, GVC)) {
      const name = readString(entity, "name") ?? entityName;
      const links = readArray(entity, "spec", "staticPlacement", "locationLinks");
      const query = readPath(entity, "spec", "staticPlacement", "locationQuery");

      if (links.length === 0 && query === undefined) {
        diagnostics.push({
          checkId: "CPL042",
          severity: "error",
          message:
            `GVC "${name}" declares no placement. Set spec.staticPlacement.locationLinks (or a ` +
            `locationQuery) — without one, its workloads apply cleanly and are scheduled nowhere.`,
          entity: entityName,
          lexicon: "cpln",
        });
        continue;
      }

      for (const link of links) {
        if (typeof link !== "string") continue;
        if (LOCATION_LINK.test(link)) continue;
        diagnostics.push({
          checkId: "CPL042",
          severity: "warning",
          message:
            `GVC "${name}" has location link "${link}", which does not look like a location. Expected ` +
            `/org/<org>/location/<provider>-<region>, e.g. /org/acme/location/aws-us-east-1.`,
          entity: entityName,
          lexicon: "cpln",
        });
      }
    }

    return diagnostics;
  },
};
