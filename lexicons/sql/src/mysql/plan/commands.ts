/**
 * `chant sql diff` and `chant sql plan` for MySQL (#5449): the classified
 * change between two builds, or between a build and the environment's server.
 *
 * `diff` is offline and needs no server. `plan` reads the server
 * `sql.profiles.<env>` binds. MySQL makes every change it classifies in place
 * (instant, in place, or by copying the table), so nothing is refused: the
 * exit code is 0.
 */

import { readFileSync } from "node:fs";
import type { OwnershipMarker } from "@intentius/chant/ownership";
import { renderChangeSet } from "../../core/classifier";
import { bindMysql, type MysqlBindOptions } from "../live/bind";
import { buildObjects, declaredObjects, planAgainstClient, requireDefaultDatabase } from "../apply/apply";
import { diffMysqlSchemas, type MysqlChange } from "./diff";
import { MYSQL_CHANGE_CLASSES, MYSQL_CLASSIFIER_RULES } from "./rules";

export interface MysqlPlanResult {
  changes: MysqlChange[];
  hints: string[];
  /** Always empty: MySQL makes every classified change in place. */
  refused: MysqlChange[];
  /** Declared objects whose server definition chant cannot read, with why. */
  unreadable: Array<{ object: string; reason: string }>;
}

export function renderMysqlPlan(plan: Pick<MysqlPlanResult, "changes" | "hints">, title: string): string {
  return renderChangeSet({ changes: plan.changes, hints: plan.hints }, { title, rules: MYSQL_CLASSIFIER_RULES, classes: MYSQL_CHANGE_CLASSES });
}

export function emitMysql(plan: MysqlPlanResult, json: boolean, title: string): number {
  console.log(json ? JSON.stringify(plan, null, 2) : renderMysqlPlan(plan, title));
  return plan.unreadable.length > 0 ? 2 : 0;
}

/** Offline: two build outputs, unqualified names in one placeholder database. */
export function diffMysqlBuildFiles(before: string, after: string): MysqlPlanResult {
  const read = (path: string) => declaredObjects(readFileSync(path, "utf-8"), "(default)");
  const a = read(before);
  const b = read(after);
  const diff = diffMysqlSchemas(
    a.map((o) => ({ key: o.exportName, canonical: o.canonical })),
    b.map((o) => ({ key: o.exportName, canonical: o.canonical })),
    { droppable: () => true },
  );
  return { changes: diff.changes, hints: diff.hints, refused: [], unreadable: [] };
}

/** The declared objects against the server, labelled `export (key)`. */
export async function planMysqlAgainstServer(
  environment: string,
  buildFile: string,
  options: Omit<MysqlBindOptions, "environment"> & { marker?: OwnershipMarker; prune?: boolean } = {},
): Promise<MysqlPlanResult> {
  const { target, client } = await bindMysql({ ...options, environment });
  try {
    const json = readFileSync(buildFile, "utf-8");
    const declared = declaredObjects(json, requireDefaultDatabase(target, buildObjects(json)));
    const plan = await planAgainstClient(client, target, declared, { ...(options.marker ? { marker: options.marker } : {}), ...(options.prune ? { prune: true } : {}) });
    const label = new Map(declared.map((o) => [o.key, `${o.exportName} (${o.key.slice(o.key.indexOf(" ") + 1)})`]));
    const changes = plan.changes.map((c) => ({ ...c, object: label.get(c.object) ?? c.object }));
    return { changes, hints: plan.hints, refused: [], unreadable: plan.unreadable.map((u) => ({ object: label.get(u.key) ?? u.key, reason: u.reason })) };
  } finally {
    await client.end();
  }
}
