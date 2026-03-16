/**
 * WFW114: Missing Undo Scripts When baselineOnMigrate Is Enabled
 *
 * Warns when `baselineOnMigrate` is set to true in the [flyway] section or
 * in any environment, but `undoSqlMigrationPrefix` is not configured. Without
 * undo scripts, rolling back past the baseline becomes difficult.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseFlywayTOML, forEachEnvironment, getFlywaySection } from "./flyway-helpers";

export const wfw114: PostSynthCheck = {
  id: "WFW114",
  description: "Missing undo migration prefix when baselineOnMigrate is enabled",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, output] of ctx.outputs) {
      const config = parseFlywayTOML(output);
      const flyway = getFlywaySection(config);

      // Check [flyway] section
      if (flyway) {
        if (flyway.baselineOnMigrate === true && !("undoSqlMigrationPrefix" in flyway)) {
          diagnostics.push({
            checkId: "WFW114",
            severity: "info",
            message:
              "baselineOnMigrate is enabled in [flyway] but undoSqlMigrationPrefix is not set — consider configuring undo scripts for rollback safety",
            entity: name,
            lexicon: "flyway",
          });
        }
      }

      // Check each environment
      forEachEnvironment(config, (envName, env) => {
        if (env.baselineOnMigrate === true && !("undoSqlMigrationPrefix" in env)) {
          // Also check if the [flyway] section has it set globally
          const globalUndo = flyway && "undoSqlMigrationPrefix" in flyway;
          if (!globalUndo) {
            diagnostics.push({
              checkId: "WFW114",
              severity: "info",
              message: `baselineOnMigrate is enabled in [environments.${envName}] but undoSqlMigrationPrefix is not set — consider configuring undo scripts for rollback safety`,
              entity: name,
              lexicon: "flyway",
            });
          }
        }
      });
    }

    return diagnostics;
  },
};
