/**
 * REN010: A native-runtime service must say how to build and start.
 *
 * Render's native runtimes (node, python, ruby, go, rust, elixir) need a
 * `buildCommand` and a `startCommand` in `envSpecificDetails`; without them the
 * API rejects the create (or, on some paths, accepts it and the first deploy
 * fails). `docker` reads a Dockerfile and `image` pulls a prebuilt image, so
 * neither needs commands. Static sites have no runtime.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { ENTITY_TYPES } from "../../catalog";
import { readProps, entityTypeOf, isService, kindOf } from "./render-helpers";

const NATIVE_RUNTIMES = new Set(["node", "python", "ruby", "go", "rust", "elixir"]);

export const ren010: PostSynthCheck = {
  id: "REN010",
  description: "A native-runtime service must set envSpecificDetails.buildCommand and startCommand",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (!isService(entity) || entityTypeOf(entity) === ENTITY_TYPES.staticSite) continue;
      const details = readProps(readProps(entity).serviceDetails);
      const runtime = details.runtime;
      if (typeof runtime !== "string" || !NATIVE_RUNTIMES.has(runtime)) continue;

      const env = readProps(details.envSpecificDetails);
      const missing: string[] = [];
      if (typeof env.buildCommand !== "string" || env.buildCommand.length === 0) missing.push("buildCommand");
      if (typeof env.startCommand !== "string" || env.startCommand.length === 0) missing.push("startCommand");
      if (missing.length > 0) {
        diagnostics.push({
          checkId: "REN010",
          severity: "error",
          message: `${kindOf(entity)} "${name}" uses the ${runtime} runtime but sets no ${missing.join(" or ")} — add envSpecificDetails: new NativeEnvironmentDetails({ buildCommand, startCommand })`,
          entity: name,
          lexicon: "render",
        });
      }
    }

    return diagnostics;
  },
};
