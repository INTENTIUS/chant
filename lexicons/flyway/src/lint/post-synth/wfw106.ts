/**
 * WFW106: Invalid Callback Event
 *
 * Detects callback names that are not in the known set of Flyway callback
 * events. Invalid callback names are silently ignored by Flyway, making
 * typos hard to diagnose.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, getFlywaySection } from "./flyway-helpers";
import { CALLBACK_EVENTS } from "../../variables";

export const wfw106: PostSynthCheck = {
  id: "WFW106",
  description: "Invalid callback event name — callback not in known Flyway events set",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);
      const flyway = getFlywaySection(config);
      if (!flyway) continue;

      const callbacks = flyway.callbacks as unknown;
      if (!callbacks || typeof callbacks !== "object") continue;

      // Callbacks can be an object with event names as keys
      if (!Array.isArray(callbacks)) {
        for (const eventName of Object.keys(callbacks as Record<string, unknown>)) {
          if (!CALLBACK_EVENTS.has(eventName as any)) {
            diagnostics.push({
              checkId: "WFW106",
              severity: "warning",
              message: `Unknown callback event "${eventName}" — not a recognized Flyway callback event`,
              entity: name,
              lexicon: "flyway",
            });
          }
        }
      }

      // Also check callback strings in arrays (e.g., callbackLocations values)
      const callbackLocations = flyway.callbackLocations as unknown;
      if (Array.isArray(callbackLocations)) {
        for (const loc of callbackLocations) {
          if (typeof loc === "string") {
            // Extract event name from callback file pattern like "beforeMigrate__xxx.sql"
            const match = (loc as string).match(/^([a-zA-Z]+?)(?:__|\.|$)/);
            if (match && !CALLBACK_EVENTS.has(match[1] as any)) {
              diagnostics.push({
                checkId: "WFW106",
                severity: "warning",
                message: `Unknown callback event "${match[1]}" in callback location "${loc}"`,
                entity: name,
                lexicon: "flyway",
              });
            }
          }
        }
      }
    }

    return diagnostics;
  },
};
