import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { propsOf } from "../../entity-props";

/**
 * FTN016: runtime and model must be valid before apply.
 *
 * The generated types make these compile-time checks for typed authoring;
 * this backstops untyped construction (imported templates, hand-built
 * plans) so a typo fails the build instead of a 422 at apply.
 *
 * Every runtime but `acp` needs a model: fountain v0.21.0, the pinned spec,
 * refuses such an Agent at apply with `model: can't be blank` (#2776), and the
 * generated type leaves `model` optional because `acp` does not take one.
 *
 * `acp` is the exception on the model. The runtime is in the spec since
 * fountain v0.21.0, and it names a process rather than a hosted model: the
 * model is whatever the command on the other end of the protocol decides to
 * use, so a `model` on an acp agent is a value nothing reads. The command
 * itself is FTN023's business.
 */

const RUNTIMES = new Set(["claude", "codex", "gemini", "opencode", "acp"]);
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
      if (agent.runtime === "acp") {
        if (agent.model !== undefined) {
          diagnostics.push({
            checkId: "FTN016",
            severity: "error",
            message:
              `Agent "${name}" has runtime "acp" and a model — an acp agent's model is ` +
              `the command's own choice, so nothing reads this one`,
            entity: name,
            lexicon: "fountain",
          });
        }
        continue;
      }

      if (agent.model === undefined || agent.model === null || agent.model === "") {
        diagnostics.push({
          checkId: "FTN016",
          severity: "error",
          message:
            `Agent "${name}" has runtime "${typeof agent.runtime === "string" ? agent.runtime : "(unset)"}" and no model — ` +
            `fountain v0.21.0 refuses it at apply ("model: can't be blank"); every runtime but acp needs a ` +
            `canonical provider/model_id`,
          entity: name,
          lexicon: "fountain",
        });
        continue;
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
