import type { LintContext, LintDiagnostic, LintRule } from "@intentius/chant/lint/rule";
import { isTrivia, SqlSyntaxError, type Token } from "../../postgres/tokens";
import { isPostgresProvider, providerAllowsExtension, providerData } from "../../postgres/providers";
import type { PostgresProvider } from "../../postgres/providers";
import { findPostgresTemplates, postgresTokensOf, tokenPosition } from "./postgres-templates";

/**
 * The provider a lint run is for: `sql.provider`, else the one provider every
 * profile that names one agrees on. No answer (self-hosted, or profiles that
 * disagree) leaves the rule silent. The lint engine passes the whole project
 * config as `projectConfig`.
 */
export function providerFromConfig(config: unknown): PostgresProvider | undefined {
  const sql = (config as { sql?: { provider?: unknown; profiles?: Record<string, { provider?: unknown }> } } | undefined)?.sql;
  if (!sql) return undefined;
  if (isPostgresProvider(sql.provider)) return sql.provider;
  const named = new Set(Object.values(sql.profiles ?? {}).map((p) => p.provider).filter(isPostgresProvider));
  return named.size === 1 ? [...named][0] : undefined;
}

const unquote = (t: Token): string => (t.kind === "qident" ? t.text.slice(1, -1).replace(/""/g, '"') : t.text.toLowerCase());

/**
 * SQLPG004: a declared extension the configured provider does not allow.
 *
 * `extension\`CREATE EXTENSION pg_stat_monitor\`` builds, and fails when
 * applied to a provider whose list lacks it. The lists are the providers'
 * documentation snapshots (see postgres/providers/types.ts), so a provider
 * that added an extension since reports it here until the list is refreshed;
 * disable the rule for that line. When a provider's list is partial, a name
 * outside it is not reported.
 */
export const sqlpg004: LintRule = {
  id: "SQLPG004",
  severity: "error",
  category: "correctness",
  description: "A declared extension the configured Postgres provider does not allow",

  check(context: LintContext): LintDiagnostic[] {
    const provider = providerFromConfig(context.projectConfig);
    if (!provider) return [];
    const label = providerData(provider).label;
    const source = context.sourceFile;
    const out: LintDiagnostic[] = [];
    for (const found of findPostgresTemplates(source)) {
      if (found.tag !== "extension") continue;
      let tokens: Token[];
      try {
        tokens = postgresTokensOf(found);
      } catch (err) {
        if (err instanceof SqlSyntaxError) continue;
        throw err;
      }
      const sig = tokens.filter((t) => !isTrivia(t));
      const word = (k: number) => (sig[k]?.kind === "ident" ? sig[k]!.text.toUpperCase() : "");
      if (word(0) !== "CREATE" || word(1) !== "EXTENSION") continue;
      let k = 2;
      if (word(k) === "IF" && word(k + 1) === "NOT" && word(k + 2) === "EXISTS") k += 3;
      const nameToken = sig[k];
      if (!nameToken || (nameToken.kind !== "ident" && nameToken.kind !== "qident")) continue;
      const name = unquote(nameToken);
      if (providerAllowsExtension(provider, name) !== false) continue;
      out.push({
        ruleId: "SQLPG004",
        severity: "error",
        message: `${label} does not allow the extension "${name}"; CREATE EXTENSION would fail there. Use an extension it lists, or change sql.provider`,
        file: context.filePath,
        ...tokenPosition(source, found, nameToken),
      });
    }
    return out;
  },
};
