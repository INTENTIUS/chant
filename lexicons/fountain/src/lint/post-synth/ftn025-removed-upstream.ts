import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { propsOf } from "../../entity-props";
import { RETIRED_KINDS } from "../../retired";

/**
 * FTN025: a declaration uses something Managoat removed (managoat/managoat#2793).
 *
 * Three ways an older project reaches for it:
 *
 *   - a `Teammate`, `Schedule` or `Webhook`. Their routes answer 404. The kinds
 *     are stubs (`retired.ts`) that the serializer leaves out of the manifest,
 *     so this rule is what tells the author, with what replaced each one.
 *   - an Agent with `sandbox_mode: "persistent"`. fountain v0.29.0, the pinned
 *     spec, still lists the value, deprecated, and the server answers 422:
 *     every conversation gets a sandbox of its own (ADR 0073). A conversation
 *     resumed by `channel_id` keeps its sandbox's disk across park and wake,
 *     which is the long-lived machine a persistent agent stood for.
 *   - an Agent whose `sandbox_provider` is `daytona` or `runner`, or whose
 *     runtime is `opencode`. The generated types no longer allow them, so this
 *     backstops untyped construction the way FTN016 does.
 */

const REMOVED_PROVIDERS = new Set(["daytona", "runner"]);

export const removedUpstreamCheck: PostSynthCheck = {
  id: "FTN025",
  description: "A declaration uses a kind or value Managoat removed",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];
    const report = (entity: string, message: string) =>
      diagnostics.push({ checkId: "FTN025", severity: "error", message, entity, lexicon: "fountain" });

    for (const [name, entity] of ctx.entities) {
      const retired = RETIRED_KINDS[entity.entityType];
      if (retired) {
        report(name, `${retired.kind} "${name}" is a kind Managoat removed, and chant no longer emits it. ${retired.replacement}.`);
        continue;
      }
      if (entity.entityType !== "Fountain::V1::Agent") continue;

      const agent = propsOf(entity) as { sandbox_mode?: unknown; sandbox_provider?: unknown; runtime?: unknown };
      if (agent.sandbox_mode === "persistent") {
        report(
          name,
          `Agent "${name}" has sandbox_mode "persistent", which Managoat refuses with 422: every conversation ` +
            `gets a sandbox of its own. Drop sandbox_mode. For a long-lived machine, resume one conversation by ` +
            `channel_id (a Steward's runs do), or run the Op on a sandbox of your own with --on e2b.`,
        );
      }
      if (typeof agent.sandbox_provider === "string" && REMOVED_PROVIDERS.has(agent.sandbox_provider)) {
        report(
          name,
          `Agent "${name}" has sandbox_provider "${agent.sandbox_provider}", which Managoat removed. ` +
            `Use "sprites" or "e2b", or leave it unset for the instance's default.`,
        );
      }
      if (agent.runtime === "opencode") {
        report(name, `Agent "${name}" has runtime "opencode", which Managoat removed. Use claude, codex, gemini or acp.`);
      }
    }

    return diagnostics;
  },
};
