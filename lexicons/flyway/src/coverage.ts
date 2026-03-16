/**
 * Coverage analysis for the Flyway lexicon.
 *
 * Reports coverage of known Flyway parameters.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Known Flyway TOML configuration parameters from the Redgate docs.
 * This is the reference set for coverage analysis.
 */
const KNOWN_FLYWAY_PARAMS = [
  // [flyway] namespace
  "locations", "defaultSchema", "schemas", "encoding",
  "validateMigrationNaming", "validateOnMigrate", "outOfOrder",
  "cleanDisabled", "baselineOnMigrate", "baselineVersion",
  "baselineDescription", "sqlMigrationPrefix", "sqlMigrationSeparator",
  "sqlMigrationSuffixes", "repeatableMigrationPrefix", "table",
  "tablespace", "group", "mixed", "cherryPick", "callbackLocations",
  "skipExecutingMigrations", "placeholders",
  // Environment properties
  "url", "user", "password", "displayName", "provisioner", "resolvers",
  // Resolver properties
  "token", "engineName", "engineVersion", "project",
  "dataImage", "dataContainer", "dataContainerLifetime",
  "authenticationToken", "operationTimeout", "tenantId",
  // Provisioner properties
  "filePath",
  // Desktop & Compare
  "developmentEnvironment", "shadowEnvironment", "schemaModel",
  "undoScripts", "verifyUndoScripts", "includeDependencies",
];

/**
 * Analyze coverage of the Flyway lexicon.
 */
export async function analyzeFlywyCoverage(opts?: {
  verbose?: boolean;
  minOverall?: number;
}): Promise<void> {
  const generatedDir = join(pkgDir, "src", "generated");
  const lexiconJSON = JSON.parse(
    readFileSync(join(generatedDir, "lexicon-flyway.json"), "utf-8"),
  );

  const totalTypes = Object.keys(lexiconJSON).length;
  const totalParams = KNOWN_FLYWAY_PARAMS.length;
  const pct = (totalTypes / totalParams * 100);

  console.error(`Flyway lexicon coverage:`);
  console.error(`  Types defined: ${totalTypes}`);
  console.error(`  Known params: ${totalParams}`);
  console.error(`  Coverage estimate: ${pct.toFixed(1)}%`);

  if (opts?.minOverall && pct < opts.minOverall) {
    console.error(`Coverage ${pct.toFixed(1)}% is below minimum ${opts.minOverall}%`);
    process.exit(1);
  }
}
