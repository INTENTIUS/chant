/**
 * `classifyDisruption()` for MySQL (#5449): what applying a pending update
 * costs, from the paths `chant lifecycle plan` reports changed, mapped onto
 * the classifier's rules (`./rules.ts`). A path that alone cannot say which
 * rule applies (a column added or changed, a key, a view's query) answers
 * `unknown`, and `chant sql plan` classifies it with both definitions in hand.
 */

import type { DisruptionQuery, DisruptionVerdict } from "@intentius/chant/lifecycle/disruption";
import { classifyDisruptionWith } from "../../core/classifier";
import { MYSQL_CHANGE_CLASSES, MYSQL_CLASSIFIER_RULES, type MysqlClassifierRuleId } from "./rules";

function ruleFor(path: string): MysqlClassifierRuleId | "ambiguous" | undefined {
  const root = path.split(/[.[]/)[0]!;
  if (root === "name" || root === "database") return "SQLMY221";
  if (root === "comment") return "SQLMY217";
  if (root === "engine") return "SQLMY218";
  if (root === "charset" || root === "collate") return "SQLMY219";
  if (root === "rowFormat" || root === "options") return "SQLMY220";
  if (root === "algorithm" || root === "security" || root === "checkOption" || root === "definer") return "SQLMY222";
  if (["select", "columns", "primaryKey", "indexes", "foreignKeys", "checks"].includes(root)) {
    if (root === "columns") {
      const field = /^columns\[(?:\d+|#[^\]]*)\]\.(\w+)/.exec(path)?.[1];
      if (field === "default") return "SQLMY205";
      if (field === "comment" || field === "onUpdate" || field === "invisible" || field === "srid") return "SQLMY207";
      if (field === "charset" || field === "collate") return "SQLMY208";
      if (field === "nullable") return "SQLMY206";
    }
    return "ambiguous";
  }
  return undefined;
}

export function classifyMysqlDisruption(options: { environment: string; changes: DisruptionQuery[] }): Record<string, DisruptionVerdict> {
  return classifyDisruptionWith(
    {
      typePrefix: "MySQL::",
      rules: MYSQL_CLASSIFIER_RULES,
      classes: MYSQL_CHANGE_CLASSES,
      ruleFor,
      ambiguousDetail: "a column, key, constraint or view change takes a different algorithm depending on both definitions; `chant sql plan` classifies it",
    },
    options,
  );
}
