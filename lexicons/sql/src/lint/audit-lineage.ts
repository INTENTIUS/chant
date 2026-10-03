/**
 * Prior art for the sql lexicon's audit rules: the tools whose checks cover the
 * same condition, credited per rule. See packages/core/src/audit/prior-art.ts
 * for the registry and the relation vocabulary. Kept by hand.
 *
 * Mapped against #3285's seed list (squawk, strong_migrations,
 * django-pg-zero-downtime-migrations). Those tools are migration linters: the
 * rules that overlap a schema-level check are the type preferences.
 *
 * - squawk (https://squawkhq.com/docs/rules) prefer-identity,
 *   prefer-timestamptz, ban-char-field and prefer-text-field.
 * - strong_migrations "Adding a json column": the json type has no equality
 *   operator, the same reason SQLPG105 prefers jsonb.
 * - django-pg-zero-downtime-migrations has no rule on a column's type or an
 *   index's shape; its rules are about locks, which the lock classifier
 *   (SQLPG2xx) covers, so it is not credited here.
 * - The Postgres wiki "Don't Do This" page names serial, timestamp, char(n),
 *   money and varchar(n) as types to avoid.
 *
 * SQLPG101-102, 109-118 have no tool credit: the checks come from the
 * Postgres documentation each one cites.
 */
import type { Lineage } from "@intentius/chant/audit/catalog";

const squawk = (rule: string, relation: Lineage["relation"]): Lineage => ({ tool: "squawk", rule, url: `https://squawkhq.com/docs/${rule}`, relation });
const wiki = (rule: string, anchor: string): Lineage => ({
  tool: "postgres-wiki-dont-do-this",
  rule,
  url: `https://wiki.postgresql.org/wiki/Don%27t_Do_This#${anchor}`,
  relation: "overlaps",
});

export const sqlAuditLineage: Record<string, Lineage[]> = {
  SQLPG103: [squawk("prefer-identity", "equivalent"), wiki("Don't use serial", "Don.27t_use_serial")],
  SQLPG104: [squawk("prefer-timestamptz", "equivalent"), wiki("Don't use timestamp (without time zone)", "Don.27t_use_timestamp_.28without_time_zone.29")],
  SQLPG105: [
    {
      tool: "strong_migrations",
      rule: "Adding a json column",
      url: "https://github.com/ankane/strong_migrations#adding-a-json-column",
      relation: "overlaps",
    },
  ],
  SQLPG106: [squawk("ban-char-field", "equivalent"), wiki("Don't use char(n)", "Don.27t_use_char.28n.29")],
  SQLPG107: [wiki("Don't use money", "Don.27t_use_money")],
  SQLPG108: [squawk("prefer-text-field", "overlaps"), wiki("Don't use varchar(n) by default", "Don.27t_use_varchar.28n.29_by_default")],
};
