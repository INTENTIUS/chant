/**
 * AZR018: SQL Server missing auditing
 *
 * Warns when a SQL Server does not have auditing configured.
 * Azure SQL auditing tracks database events and writes them
 * to an audit log, helping meet compliance requirements.
 */

import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import { parseArmTemplate } from "./arm-refs";

const SQL_SERVER_TYPE = "Microsoft.Sql/servers";
const AUDIT_TYPE = "Microsoft.Sql/servers/auditingSettings";

export const azr018: PostSynthCheck = {
  id: "AZR018",
  description: "SQL Server missing auditing — enable auditing for compliance and threat detection",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [_lexicon, output] of ctx.outputs) {
      const template = parseArmTemplate(output);
      if (!template?.resources) continue;

      const sqlServers = template.resources.filter((r) => r.type === SQL_SERVER_TYPE);
      const auditSettings = template.resources.filter((r) => r.type === AUDIT_TYPE);

      for (const server of sqlServers) {
        const serverName = typeof server.name === "string" ? server.name : String(server.name);

        // Check for a matching auditing settings resource
        const hasAudit = auditSettings.some((a) => {
          const auditName = typeof a.name === "string" ? a.name : String(a.name);
          return auditName.startsWith(`${serverName}/`);
        });

        if (!hasAudit) {
          diagnostics.push({
            checkId: "AZR018",
            severity: "warning",
            message: `SQL Server "${serverName}" does not have auditing configured — add a Microsoft.Sql/servers/auditingSettings resource`,
            entity: serverName,
            lexicon: "azure",
          });
        }
      }
    }

    return diagnostics;
  },
};
