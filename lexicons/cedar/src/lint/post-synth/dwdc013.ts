/**
 * DWDC013: a temporal statement embedded in AgentCore needs its event schema
 * registered
 *
 * `AWS::BedrockAgentCore::Policy` carries one string. When that string is `.dw`
 * text — `Definition.Policy.Statement`, the language-agnostic arm — the policy
 * engine at the other end has to know what an event *is* before any temporal
 * predicate in it can match: which kinds exist, what fields they carry, and
 * what is pinned to the deciding request. That is the `.dwschema` half of the
 * schema, and the resource has no property to put it in.
 *
 * So a build that embeds temporal text and emits no event schema has shipped
 * half a policy. Nothing fails: the statement deploys, the predicates match
 * nothing, and a `formerly`-guarded permit stops granting — or a
 * `formerly`-guarded forbid stops denying, which is the direction that
 * matters. That is the silent trap this check exists for — the emitted schema
 * is the artifact that makes the other half reviewable, whether it is
 * registered with the engine out of band or shipped to a `dogwood validate`
 * run.
 *
 * Warning rather than error, because "not emitted here" is not the same as
 * "does not exist": a project may register the service schema through a
 * separate pipeline, and failing that build would be chant asserting a fact it
 * cannot check. Emitting one with `TemporalEventSchema` silences it and makes
 * the assumption visible in the diff.
 *
 * The complement of DWDC010, which asks whether the kinds a `.dw` file names
 * are declared. This one asks the prior question, and only of statements that
 * left the `.dw` file behind.
 */
import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { embeddedAgentCorePolicyStatements } from "../../agentcore/scan";
import { dogwoodSchemaFiles, temporalRegions } from "../../dogwood/scan";

export const dwdc013: PostSynthCheck = {
  id: "DWDC013",
  description: "An embedded AgentCore temporal statement has its event schema emitted beside it",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    if (dogwoodSchemaFiles(ctx).length > 0) return [];

    const diagnostics: PostSynthDiagnostic[] = [];
    const seen = new Set<string>();

    for (const embedded of embeddedAgentCorePolicyStatements(ctx)) {
      if (temporalRegions(embedded.statement).length === 0) continue;

      const named = embedded.logicalId ?? embedded.source;
      const key = `${embedded.lexicon}:${embedded.source}:${named}`;
      if (seen.has(key)) continue;
      seen.add(key);

      diagnostics.push({
        checkId: "DWDC013",
        severity: "warning",
        message: `AgentCore policy "${named}" in "${embedded.source}" carries temporal text in Definition.Policy.Statement, but the build emitted no .dwschema event schema. The policy engine needs the event kinds and their pins registered before any temporal predicate can match; without them the clause never fires and the policy silently stops doing its job. Declare a TemporalEventSchema, or record where the service schema is registered.`,
        entity: named,
        lexicon: embedded.lexicon,
      });
    }

    return diagnostics;
  },
};
