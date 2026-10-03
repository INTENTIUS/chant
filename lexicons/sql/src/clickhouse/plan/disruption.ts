/**
 * `classifyDisruption()`: what applying a pending update costs, from the
 * paths `chant lifecycle plan` reports changed, mapped onto the classifier's
 * rules (`./rules.ts`). A metadata-only change is `in-place`, a background
 * rewrite `rolling`, a rebuild `replace`.
 *
 * A path alone cannot always say which rule applies: a column type change is a
 * rewrite, or a rebuild when the column is in a key. Those answer `unknown`,
 * naming both rules; `chant sql plan` resolves them with the whole definition
 * in hand.
 */

import type { DisruptionQuery, DisruptionVerdict } from "@intentius/chant/lifecycle/disruption";
import { MERGE_TREE_SETTINGS } from "../../generated/clickhouse";
import { classifyDisruptionWith } from "../../core/classifier";
import { CHANGE_CLASSES, CLASSIFIER_RULES, type ClassifierRuleId } from "./rules";

function ruleFor(path: string): ClassifierRuleId | "ambiguous" | undefined {
  const root = path.split(/[.[]/)[0]!;
  if (root === "name" || root === "database") return "SQLCH230";
  if (root === "comment") return "SQLCH203";
  if (root === "engine") return "SQLCH223";
  if (root === "orderBy") return "ambiguous";
  if (root === "primaryKey") return "SQLCH221";
  if (root === "partitionBy") return "SQLCH222";
  if (root === "sampleBy") return "SQLCH217";
  if (root === "ttl") return "SQLCH205";
  if (root === "indexes") return "SQLCH204";
  if (root === "projections") return "SQLCH214";
  if (root === "constraints") return "SQLCH215";
  if (root === "select") return "SQLCH240";
  if (root === "refresh") return "SQLCH244";
  if (root === "settings") {
    const key = path.split(".")[1];
    const spec = key ? (MERGE_TREE_SETTINGS as Record<string, { readonly: boolean } | undefined>)[key] : undefined;
    return spec?.readonly ? "SQLCH218" : "SQLCH206";
  }
  if (root === "columns") {
    const field = /^columns\[\d+\]\.(\w+)/.exec(path)?.[1];
    if (field === undefined) return "ambiguous"; // a column added, dropped or moved
    if (field === "type" || field === "nullable" || field === "name") return "ambiguous";
    if (field === "default") return "SQLCH207";
    if (field === "codec") return "SQLCH208";
    if (field === "ttl") return "SQLCH205";
    if (field === "comment") return "SQLCH203";
  }
  return undefined;
}

export function classifyDisruption(options: { environment: string; changes: DisruptionQuery[] }): Record<string, DisruptionVerdict> {
  return classifyDisruptionWith(
    {
      typePrefix: "ClickHouse::",
      rules: CLASSIFIER_RULES,
      classes: CHANGE_CLASSES,
      ruleFor,
      ambiguousDetail: "a sorting-key or column change is metadata, a rewrite or a rebuild depending on the whole definition; `chant sql plan` classifies it",
    },
    options,
  );
}
