import { CODECS } from "../../generated/clickhouse";
import { checkOf, codecNames, isTable } from "./clickhouse-helpers";
import { clickhouseObjects } from "./sql-helpers";

const SENSITIVE = /(^|_)(password|passwd|pwd|secret|api_?key|access_?key|private_?key|token|ssn|social_?security|credit_?card|card_?number|iban)(_|$)/i;

/**
 * SQLCH115: a column named like a secret or personal data has no COMMENT, no
 * TTL and no encryption codec.
 *
 * Docs: https://clickhouse.com/docs/sql-reference/statements/create/table
 * (column COMMENT, column TTL, and the AES_128_GCM_SIV / AES_256_GCM_SIV
 * encryption codecs). The marker is the author saying the column was
 * considered: a COMMENT stating what it holds, a TTL that bounds how long it
 * is kept, or a codec that encrypts it. The table's own TTL counts for the
 * whole row.
 */
export const sqlch115 = checkOf({ id: "SQLCH115", description: "A secret- or PII-named column carries no comment, TTL or encryption" }, (ctx, report) => {
  const encryption = new Set(Object.entries(CODECS).filter(([, s]) => s.encryption).map(([n]) => n.toLowerCase()));
  for (const t of clickhouseObjects(ctx).filter(isTable)) {
    for (const c of t.columns) {
      if (!SENSITIVE.test(c.name) || c.comment || c.ttl || t.ttl) continue;
      if (c.codec && codecNames(c.codec).some((n) => encryption.has(n.toLowerCase()))) continue;
      report({
        severity: "warning",
        message: `${t.export} (${t.name}): column ${c.name} looks like a secret or personal data; add a COMMENT, a TTL or an encryption codec`,
        entity: t.export,
      });
    }
  }
});
