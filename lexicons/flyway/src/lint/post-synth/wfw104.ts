/**
 * WFW104: Unresolved Resolver Reference
 *
 * Detects `${resolver.key}` patterns in environment values that don't have
 * a corresponding resolver configured in that environment or globally.
 * Missing resolvers cause runtime failures when Flyway tries to resolve
 * the reference.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML } from "./flyway-helpers";

const RESOLVER_REF_PATTERN = /\$\{([a-zA-Z][a-zA-Z0-9]*)\.([^}]+)\}/g;

/**
 * Recursively collect all string values from an object.
 */
function collectStringValues(obj: unknown, results: string[]): void {
  if (typeof obj === "string") {
    results.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      collectStringValues(item, results);
    }
  } else if (typeof obj === "object" && obj !== null) {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      collectStringValues(value, results);
    }
  }
}

/**
 * Collect all resolver names configured in a config object.
 */
function collectResolverNames(config: Record<string, unknown>): Set<string> {
  const resolvers = new Set<string>();

  // Check top-level resolvers
  const topResolvers = config.resolvers as Record<string, unknown> | undefined;
  if (topResolvers && typeof topResolvers === "object") {
    for (const name of Object.keys(topResolvers)) {
      resolvers.add(name);
    }
  }

  // Check environment-level resolvers
  const environments = config.environments as Record<string, unknown> | undefined;
  if (environments && typeof environments === "object") {
    for (const envConfig of Object.values(environments)) {
      if (typeof envConfig !== "object" || envConfig === null) continue;
      const envResolvers = (envConfig as Record<string, unknown>).resolvers as Record<string, unknown> | undefined;
      if (envResolvers && typeof envResolvers === "object") {
        for (const name of Object.keys(envResolvers)) {
          resolvers.add(name);
        }
      }
    }
  }

  return resolvers;
}

export const wfw104: PostSynthCheck = {
  id: "WFW104",
  description: "Unresolved resolver reference — ${resolver.key} used without corresponding resolver configuration",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);

      const configuredResolvers = collectResolverNames(config);
      const allStrings: string[] = [];
      collectStringValues(config, allStrings);

      // Built-in prefixes that are not resolvers
      const builtinPrefixes = new Set(["flyway"]);

      for (const str of allStrings) {
        let match: RegExpExecArray | null;
        RESOLVER_REF_PATTERN.lastIndex = 0;
        while ((match = RESOLVER_REF_PATTERN.exec(str)) !== null) {
          const resolverName = match[1];
          if (builtinPrefixes.has(resolverName)) continue;

          if (!configuredResolvers.has(resolverName)) {
            diagnostics.push({
              checkId: "WFW104",
              severity: "error",
              message: `Resolver reference "\${${resolverName}.${match[2]}}" used but resolver "${resolverName}" is not configured`,
              entity: name,
              lexicon: "flyway",
            });
          }
        }
      }
    }

    return diagnostics;
  },
};
