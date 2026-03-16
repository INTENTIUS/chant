/**
 * Flyway TOML template parser.
 *
 * Parses flyway.toml files into intermediate representation for import.
 */

import type { TemplateParser, TemplateIR, ResourceIR } from "@intentius/chant/import/parser";
import { parseTOML } from "@intentius/chant/toml";

/**
 * Parse a Flyway TOML config into template IR.
 */
export class FlywayParser implements TemplateParser {
  parse(content: string): TemplateIR {
    const config = parseTOML(content);
    const resources: ResourceIR[] = [];

    // Extract project-level properties
    const projectProps: Record<string, unknown> = {};
    for (const key of ["id", "name", "databaseType"]) {
      if (config[key] !== undefined) {
        projectProps[key] = config[key];
      }
    }
    if (Object.keys(projectProps).length > 0) {
      resources.push({
        logicalId: "project",
        type: "Flyway::Project",
        properties: projectProps,
      });
    }

    // Extract [flyway] config
    if (config.flyway && typeof config.flyway === "object") {
      resources.push({
        logicalId: "config",
        type: "Flyway::Config",
        properties: config.flyway as Record<string, unknown>,
      });
    }

    // Extract environments
    if (config.environments && typeof config.environments === "object") {
      const envs = config.environments as Record<string, unknown>;
      for (const [envName, envConfig] of Object.entries(envs)) {
        if (typeof envConfig === "object" && envConfig !== null) {
          const props = { ...(envConfig as Record<string, unknown>), displayName: envName };
          resources.push({
            logicalId: envName,
            type: "Flyway::Environment",
            properties: props,
          });

          // Extract resolvers as separate resources
          const resolvers = (envConfig as Record<string, unknown>).resolvers;
          if (resolvers && typeof resolvers === "object") {
            for (const [resolverType, resolverConfig] of Object.entries(resolvers as Record<string, unknown>)) {
              if (typeof resolverConfig === "object" && resolverConfig !== null) {
                const typeMap: Record<string, string> = {
                  vault: "Flyway::Resolver.Vault",
                  googlesecrets: "Flyway::Resolver.Gcp",
                  dapr: "Flyway::Resolver.Dapr",
                  clone: "Flyway::Resolver.Clone",
                  azuread: "Flyway::Resolver.AzureAd",
                  env: "Flyway::Resolver.Env",
                  git: "Flyway::Resolver.Git",
                  localSecret: "Flyway::Resolver.LocalSecret",
                };
                const type = typeMap[resolverType] ?? `Flyway::Resolver.${resolverType}`;
                resources.push({
                  logicalId: `${envName}_${resolverType}`,
                  type,
                  properties: resolverConfig as Record<string, unknown>,
                });
              }
            }
          }
        }
      }
    }

    // Extract [flywayDesktop]
    if (config.flywayDesktop && typeof config.flywayDesktop === "object") {
      resources.push({
        logicalId: "flywayDesktop",
        type: "Flyway::FlywayDesktop",
        properties: config.flywayDesktop as Record<string, unknown>,
      });
    }

    // Extract [redgateCompare]
    if (config.redgateCompare && typeof config.redgateCompare === "object") {
      resources.push({
        logicalId: "redgateCompare",
        type: "Flyway::RedgateCompare",
        properties: config.redgateCompare as Record<string, unknown>,
      });
    }

    return {
      resources,
      parameters: [],
    };
  }
}
