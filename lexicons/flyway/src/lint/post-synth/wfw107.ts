/**
 * WFW107: Enterprise-Only Callback
 *
 * Detects usage of undo callbacks (beforeUndo, afterUndo) which require
 * Flyway Teams or Enterprise edition. Using these with Community edition
 * causes runtime errors.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, getFlywaySection } from "./flyway-helpers";
import { ENTERPRISE_CALLBACK_EVENTS } from "../../variables";

export const wfw107: PostSynthCheck = {
  id: "WFW107",
  description: "Enterprise-only callback event used — undo callbacks require Flyway Teams/Enterprise",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);
      const flyway = getFlywaySection(config);
      if (!flyway) continue;

      const callbacks = flyway.callbacks as unknown;
      if (callbacks && typeof callbacks === "object" && !Array.isArray(callbacks)) {
        for (const eventName of Object.keys(callbacks as Record<string, unknown>)) {
          if (ENTERPRISE_CALLBACK_EVENTS.has(eventName as any)) {
            diagnostics.push({
              checkId: "WFW107",
              severity: "info",
              message: `Callback event "${eventName}" requires Flyway Teams/Enterprise edition`,
              entity: name,
              lexicon: "flyway",
            });
          }
        }
      }

      // Check callback locations for enterprise event patterns
      const callbackLocations = flyway.callbackLocations as unknown;
      if (Array.isArray(callbackLocations)) {
        for (const loc of callbackLocations) {
          if (typeof loc === "string") {
            const match = (loc as string).match(/^([a-zA-Z]+?)(?:__|\.|$)/);
            if (match && ENTERPRISE_CALLBACK_EVENTS.has(match[1] as any)) {
              diagnostics.push({
                checkId: "WFW107",
                severity: "info",
                message: `Callback location "${loc}" uses enterprise-only event "${match[1]}" — requires Flyway Teams/Enterprise`,
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
