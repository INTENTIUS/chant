/**
 * AZR019: SQL Server missing Transparent Data Encryption (TDE)
 *
 * Warns when a SQL Server database does not have TDE configured.
 * TDE provides encryption at rest for the entire database, backups,
 * and transaction log files.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const SQL_DB_TYPE = "Microsoft.Sql/servers/databases";
const TDE_TYPE = "Microsoft.Sql/servers/databases/transparentDataEncryption";

export const azr019: PostSynthCheck = {
  id: "AZR019",
  description: "SQL Server database missing TDE — enable Transparent Data Encryption to protect data at rest",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      const databases = template.resources.filter((r) => r.type === SQL_DB_TYPE);
      const tdeSettings = template.resources.filter((r) => r.type === TDE_TYPE);

      for (const db of databases) {
        const dbName = typeof db.name === "string" ? db.name : String(db.name);

        const hasTde = tdeSettings.some((t) => {
          const tdeName = typeof t.name === "string" ? t.name : String(t.name);
          return tdeName.startsWith(`${dbName}/`);
        });

        if (!hasTde) {
          diagnostics.push({
            checkId: "AZR019",
            severity: "warning",
            message: `SQL database "${dbName}" does not have TDE configured — add transparentDataEncryption resource`,
            entity: dbName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
