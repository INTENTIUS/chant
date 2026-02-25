/**
 * Flyway lexicon packaging — delegates to core packagePipeline.
 */

import { createRequire } from "module";
import { readFileSync } from "fs";
const require = createRequire(import.meta.url);
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  packagePipeline,
  collectSkills,
  type PackageOptions,
  type PackageResult,
} from "@intentius/chant/codegen/package";

export type { PackageOptions, PackageResult };

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Package the Flyway lexicon into a distributable BundleSpec.
 */
export async function packageLexicon(opts: PackageOptions = {}): Promise<PackageResult> {
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, "..", "package.json"), "utf-8"));

  return packagePipeline(
    {
      generate: async (_genOpts) => {
        const { generate } = await import("./generate");
        const result = await generate({ verbose: _genOpts.verbose });
        // Return a GenerateResult-compatible object
        const lexiconJSON = readFileSync(join(pkgDir, "generated", "lexicon-flyway.json"), "utf-8");
        const indexTS = readFileSync(join(pkgDir, "generated", "index.ts"), "utf-8");
        return {
          lexiconJSON,
          typesDTS: "", // Hand-authored types don't need separate .d.ts
          indexTS,
          resources: result.resources,
          properties: result.properties,
          enums: 0,
          warnings: result.warnings,
        };
      },

      buildManifest: (_genResult) => {
        return {
          name: "flyway",
          version: pkgJson.version ?? "0.0.0",
          chantVersion: ">=0.1.0",
          namespace: "Flyway",
          intrinsics: [
            { name: "resolve", description: "Resolver reference — ${resolverName.key}" },
            { name: "placeholder", description: "Built-in placeholder reference — ${flyway:name}" },
            { name: "env", description: "Environment variable reference — ${env.VAR_NAME}" },
          ],
          pseudoParameters: {
            "flyway:defaultSchema": "Default schema name",
            "flyway:user": "Database user",
            "flyway:database": "Database name",
            "flyway:timestamp": "Migration timestamp",
            "flyway:filename": "Migration filename",
            "flyway:workingDirectory": "Working directory",
            "flyway:table": "Schema history table name",
            "flyway:environment": "Current environment name",
          },
        };
      },

      srcDir: pkgDir,

      collectSkills: () => {
        const { flywayPlugin } = require("../plugin");
        const skillDefs = flywayPlugin.skills?.() ?? [];
        return collectSkills(skillDefs);
      },

      version: pkgJson.version ?? "0.0.0",
    },
    opts,
  );
}
