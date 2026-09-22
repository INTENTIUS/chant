import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { propsOf } from "../../entity-props";

/**
 * FTN023: `runtime: "acp"` and `runtime_command` come as a pair.
 *
 * An ACP agent is defined by the process it launches — there is no default
 * command to fall back on, so an `acp` agent without `runtime_command` is an
 * agent fountain cannot start. The other direction is the same mistake read
 * backwards: a `runtime_command` on a claude or codex agent is a line someone
 * expects to run that nothing will ever execute, which is worse than an error
 * because it looks configured.
 *
 * Both fields are in the spec since fountain v0.21.0, and the server refuses
 * either half without the other at apply. The rule moves that refusal to
 * build, where it is a diagnostic in review instead of a 422 in a run.
 */
export const acpRuntimeCommandCheck: PostSynthCheck = {
  id: "FTN023",
  description: "Agent runtime \"acp\" requires runtime_command, and no other runtime accepts one",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== "Fountain::V1::Agent") continue;
      const agent = propsOf(entity) as { runtime?: unknown; runtime_command?: unknown };
      const isAcp = agent.runtime === "acp";
      const hasCommand = typeof agent.runtime_command === "string" && agent.runtime_command.trim().length > 0;

      if (isAcp && !hasCommand) {
        diagnostics.push({
          checkId: "FTN023",
          severity: "error",
          message:
            `Agent "${name}" has runtime "acp" but no runtime_command — ` +
            `there is no default process for fountain to speak the protocol to`,
          entity: name,
          lexicon: "fountain",
        });
      }

      if (!isAcp && hasCommand && typeof agent.runtime === "string") {
        diagnostics.push({
          checkId: "FTN023",
          severity: "error",
          message:
            `Agent "${name}" sets runtime_command on runtime "${String(agent.runtime)}" — ` +
            `only an "acp" agent launches a command, so this one would never run`,
          entity: name,
          lexicon: "fountain",
        });
      }
    }

    return diagnostics;
  },
};
