import type { PostSynthCheck, PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";

/**
 * FTN015: secret-shaped MCP server env keys must use `${VAR}` references.
 *
 * A literal value under TOKEN/SECRET/KEY/PASSWORD-shaped keys in
 * `mcp_servers.*.env` is a credential in source and in fountain's stored
 * agent config. FTN001 catches known credential *shapes* at the AST;
 * this catches the key-name signal regardless of value shape.
 */

const SECRET_KEY_RE = /(TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL)/i;
const SUBSTITUTION_RE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export const mcpSecretEnvSubstitutionCheck: PostSynthCheck = {
  id: "FTN015",
  description: "Secret-shaped MCP env keys must be ${VAR} references, not literals",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const [name, entity] of ctx.entities) {
      if (entity.entityType !== "Fountain::V1::Agent") continue;
      const servers = (entity as unknown as { mcp_servers?: Record<string, unknown> }).mcp_servers;
      if (!servers || typeof servers !== "object") continue;

      for (const [serverName, server] of Object.entries(servers)) {
        const env = (server as { env?: Record<string, unknown> })?.env;
        if (!env || typeof env !== "object") continue;
        for (const [key, value] of Object.entries(env)) {
          if (!SECRET_KEY_RE.test(key)) continue;
          if (typeof value === "string" && SUBSTITUTION_RE.test(value)) continue;
          diagnostics.push({
            checkId: "FTN015",
            severity: "error",
            message:
              `Agent "${name}" mcp_servers.${serverName}.env.${key} looks secret-shaped ` +
              `but is not a \${VAR} reference — literals here land in stored agent config`,
            entity: name,
            lexicon: "fountain",
          });
        }
      }
    }

    return diagnostics;
  },
};
