import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { propsOf } from "../../entity-props";

/**
 * FTN013: `${VAR}` references in an Agent's config should resolve against
 * its Environment's declared keys.
 *
 * Fountain validates substitution fail-complete at *spawn* time; this
 * moves the same check to build time. Warning severity: a vault attached
 * at conversation create can legitimately supply keys the environment
 * does not declare (vault values win on collision), so an unresolved
 * reference is suspicious, not certainly wrong.
 */

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function collectVars(node: unknown, acc: Set<string>): void {
  if (typeof node === "string") {
    for (const m of node.matchAll(VAR_RE)) acc.add(m[1]);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectVars(item, acc);
    return;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectVars(v, acc);
  }
}

function declaredKeys(env: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  const envVars = env.env_vars;
  if (envVars && typeof envVars === "object") {
    for (const k of Object.keys(envVars)) keys.add(k);
  }
  const secrets = env.secrets;
  if (Array.isArray(secrets)) {
    for (const s of secrets) {
      const key = (s as { key?: unknown })?.key;
      if (typeof key === "string") keys.add(key);
    }
  }
  return keys;
}

export const substitutionResolvableCheck: PostSynthCheck = {
  id: "FTN013",
  description: "Agent ${VAR} references should resolve against the environment's declared keys",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== "Fountain::V1::Agent") continue;
      const agent = propsOf(entity);

      // Resolve the referenced environment entity when it is declared here.
      const envRef = agent.environment;
      let envEntity: Record<string, unknown> | undefined;
      if (envRef && typeof envRef === "object") {
        envEntity = propsOf(envRef);
      } else if (typeof envRef === "string") {
        const byName = ctx.entities.get(envRef);
        if (byName?.entityType === "Fountain::V1::Environment") {
          envEntity = propsOf(byName);
        }
      }
      if (!envEntity) continue; // external environment — nothing to check against

      const keys = declaredKeys(envEntity);
      const used = new Set<string>();
      collectVars(agent.mcp_servers, used);
      collectVars(agent.system, used);

      for (const v of used) {
        if (!keys.has(v)) {
          diagnostics.push({
            checkId: "FTN013",
            severity: "warning",
            message:
              `Agent "${name}" references \${${v}} but its environment declares no such ` +
              `key — it will only resolve if a vault supplies it at conversation create`,
            entity: name,
            lexicon: "fountain",
          });
        }
      }
    }

    return diagnostics;
  },
};
