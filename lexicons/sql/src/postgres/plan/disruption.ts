/**
 * `classifyDisruption()` for Postgres: what applying a pending update costs,
 * from the paths `chant lifecycle plan` reports changed, mapped onto the
 * classifier's rules (`./rules.ts`). A path alone cannot always say which rule
 * applies (a column's type change is metadata, a rewrite or expand and
 * contract depending on both types); those answer `unknown`, and `chant sql
 * plan` classifies them with both definitions in hand.
 */

import type { DisruptionQuery, DisruptionVerdict } from "@intentius/chant/lifecycle/disruption";
import { classifyDisruptionWith } from "../../core/classifier";
import { PG_CHANGE_CLASSES, PG_CLASSIFIER_RULES, type PgClassifierRuleId } from "./rules";

function ruleFor(path: string): PgClassifierRuleId | "ambiguous" | undefined {
  const root = path.split(/[.[]/)[0]!;
  if (root === "name" || root === "schema") return "SQLPG228";
  if (root === "comment" || root === "columnComments") return "SQLPG216";
  if (root === "with") return "SQLPG224";
  if (root === "persistence") return "SQLPG225";
  if (root === "using" || root === "tablespace") return "SQLPG226";
  if (["partitionBy", "partitionOf", "partitionBound", "inherits", "ofType"].includes(root)) return "SQLPG227";
  if (root === "query") return "ambiguous";
  if (root === "labels") return "ambiguous";
  if (root === "dataType") return "SQLPG264";
  if (root === "default") return "SQLPG263";
  if (["increment", "minValue", "maxValue", "start", "cache", "cycle", "ownedBy"].includes(root)) return "SQLPG265";
  if (root === "version") return "SQLPG266";
  if (root === "elements" || root === "where" || root === "include" || root === "unique" || root === "method") return "SQLPG243";
  if (["primaryKey", "uniques", "checks", "foreignKeys", "exclusions"].includes(root)) return "ambiguous";
  if (root === "columns") {
    const field = /^columns\[\d+\]\.(\w+)/.exec(path)?.[1];
    if (field === undefined || field === "type" || field === "name" || field === "notNull" || field === "generated") return "ambiguous";
    if (field === "default") return "SQLPG209";
    if (field === "comment") return "SQLPG216";
    if (field === "collate") return "SQLPG214";
    if (field === "storage" || field === "compression") return "SQLPG215";
  }
  return undefined;
}

export function classifyPgDisruption(options: { environment: string; changes: DisruptionQuery[] }): Record<string, DisruptionVerdict> {
  return classifyDisruptionWith(
    {
      typePrefix: "Postgres::",
      rules: PG_CLASSIFIER_RULES,
      classes: PG_CHANGE_CLASSES,
      ruleFor,
      ambiguousDetail: "a column, constraint, view or enum change takes a different lock depending on both definitions; `chant sql plan` classifies it",
    },
    options,
  );
}
