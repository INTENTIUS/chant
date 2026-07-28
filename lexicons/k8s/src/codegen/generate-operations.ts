/**
 * The generated operation surface — chant #1074.
 *
 * `describeResources` used to reach the cluster through a hand-written
 * `entityType → kubectl resource` map with twenty entries in it. Every one of
 * the other ~180 generated resource types, and every CRD, fell off the end of
 * it. The map was hand-maintained precisely because nothing derived it, and
 * nothing derived it because the codegen pass that produces the types never
 * emitted the addressing half.
 *
 * It does now. This artifact is written by the same `generate()` run that
 * writes `lexicon-k8s.json` and `index.d.ts`, out of the same parsed results,
 * so a resource that has a declarable class necessarily has an operation entry
 * with the same apiVersion and kind. `operation-surface.test.ts` asserts that
 * correspondence rather than trusting it.
 *
 * What it is not: an authority on what a given cluster serves. `plural` and
 * `scope` are what the schema says; the live client confirms both against the
 * cluster's own discovery before addressing anything, because a cluster can
 * serve a different version of a CRD than the one chant generated from.
 */

import type { K8sParseResult } from "../spec/parse";
import { gvkToApiVersion } from "../spec/parse";
import { pluralizeKind, type K8sOperationDescriptor, type K8sOperationTable } from "../api/operation-surface";

export type { K8sOperationDescriptor, K8sOperationTable };

/** Build the operation table from the same parsed results the types come from. */
export function buildOperationTable(results: K8sParseResult[]): K8sOperationTable {
  const table: K8sOperationTable = {};
  for (const result of results) {
    if (result.isProperty) continue;
    const entityType = result.resource.typeName;
    // A later result for the same type wins nothing — the first parse of a
    // preferred version is canonical, matching the registry's own precedence.
    if (table[entityType]) continue;
    table[entityType] = {
      entityType,
      apiVersion: gvkToApiVersion(result.gvk),
      kind: result.gvk.kind,
      plural: result.operation?.plural ?? pluralizeKind(result.gvk.kind),
      scope: result.operation?.scope ?? "Namespaced",
      verbs: result.operation?.verbs ?? [],
    };
  }
  return table;
}

/** Serialize the table, key-sorted so regeneration produces a stable diff. */
export function generateOperationsJSON(results: K8sParseResult[]): string {
  const table = buildOperationTable(results);
  const sorted: K8sOperationTable = {};
  for (const key of Object.keys(table).sort()) sorted[key] = table[key];
  return `${JSON.stringify(sorted, null, 2)}\n`;
}
