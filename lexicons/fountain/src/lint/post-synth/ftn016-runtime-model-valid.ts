import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { propsOf } from "../../entity-props";

/**
 * FTN016: runtime and model must be valid before apply.
 *
 * The generated types make these compile-time checks for typed authoring;
 * this backstops untyped construction (imported templates, hand-built
 * plans) so a typo fails the build instead of a 422 at apply.
 */

const RUNTIMES = new Set(["claude", "codex", "gemini", "opencode"]);
const MODEL_RE = /^[a-z0-9_-]+\/[a-z0-9._-]+$/;

export const runtimeModelValidCheck: PostSynthCheck = {
  id: "FTN016",
  description: "Agent runtime must be a known runtime and model canonical provider/model_id",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== "Fountain::V1::Agent") continue;
      const agent = propsOf(entity) as { runtime?: unknown; model?: unknown };

      if (typeof agent.runtime === "string" && !RUNTIMES.has(agent.runtime)) {
        diagnostics.push({
          checkId: "FTN016",
          severity: "error",
          message:
            `Agent "${name}" runtime "${agent.runtime}" is not one of ` +
            `${[...RUNTIMES].join(", ")}`,
          entity: name,
          lexicon: "fountain",
        });
      }
      if (typeof agent.model === "string" && !MODEL_RE.test(agent.model)) {
        diagnostics.push({
          checkId: "FTN016",
          severity: "error",
          message: `Agent "${name}" model "${agent.model}" is not canonical provider/model_id form`,
          entity: name,
          lexicon: "fountain",
        });
      }
    }

    return diagnostics;
  },
};
