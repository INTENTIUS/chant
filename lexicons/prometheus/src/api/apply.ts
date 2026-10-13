/**
 * The ruler apply target (#3372): `nativeApply`'s `ruler` target, reached
 * through `@intentius/chant-lexicon-prometheus/api/apply` the way core
 * reaches the grafana and sql appliers. Core imports no lexicon; it loads
 * this module by name at call time.
 *
 * One transport with observe and export ({@link bindEndpoints}), so the
 * tenant (`X-Scope-OrgID`) and the Mimir, Cortex and Loki path variants are
 * the profile's: `prometheus.profiles.<env>.ruler`.
 *
 * The ownership boundary is {@link declaredNamespaces}. The plan reads only
 * those namespaces, a group is written only into the namespace
 * {@link namespaceOfGroup} gives it, and an owned-only delete removes a
 * group the ruler has and the project does not declare, one group at a
 * time, only inside those namespaces. A namespace the project does not
 * declare is never listed, read, written or deleted. This is the difference
 * from `mimirtool rules sync`, which deletes every remote namespace missing
 * from the local files unless `--namespaces` is set.
 *
 * Rollback re-applies the previous group set. Before the first write an
 * apply saves, beside the build file, what each changed or pruned group
 * looked like (and which groups it creates); {@link rulerRollback} puts the
 * first back and deletes the second.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  applyResult,
  type AppliedAction,
  type ApplyResult,
  type NotAttemptedReason,
} from "@intentius/chant/apply";
import { loadPrometheusYaml } from "../import/parser";
import { declaredNamespaces, isUnresolvedTarget, namespaceOfGroup, type RulerTarget } from "../config";
import { bindEndpoints, classifyPromFailure, type BindOptions } from "./bind";
import { PromApiError } from "./client";
import type { RawRuleGroup, RulerApi } from "./ruler";
import type { AlertmanagerApi } from "./alertmanager";

type Json = Record<string, unknown>;

export interface RulerApplyArgs {
  /** The build's primary file: the rule file (`groups:`), or an `alertmanager.yml` when no rules are declared. */
  buildPath: string;
  /** The chant environment whose `prometheus.profiles.<env>` names the ruler. */
  environment?: string;
  /** Delete groups the ruler has in a declared namespace and the project does not declare. */
  prune?: boolean;
}

export interface RulerApplyDeps extends BindOptions {}

export interface RulerPlanEntry {
  kind: "RuleGroup" | "AlertmanagerConfig";
  /** `<namespace>/<group>`, or the Alertmanager tenant. */
  name: string;
  namespace?: string;
  group?: string;
  action: "create" | "update" | "unchanged" | "delete";
}

export interface RulerOutcome {
  applied: Array<{ kind: string; name: string; action: AppliedAction }>;
  pruned: Array<{ kind: string; name: string; deleted: boolean }>;
  notAttempted: Array<{ kind: string; name: string; reason: NotAttemptedReason; detail?: string }>;
}

/** What a rollback needs: the previous form of what an apply wrote, and what it created. */
export interface RulerSnapshot {
  environment: string;
  /** The previous form of every group the apply replaced or deleted. */
  restore: Array<{ namespace: string; group: RawRuleGroup }>;
  /** Groups the apply created. */
  remove: Array<{ namespace: string; name: string }>;
  /** The Alertmanager config before an upload, when there was one. */
  alertmanager?: { text: string; templateFiles?: Record<string, string> };
}

interface Built {
  groups: Array<Json & { name: string }>;
  alertmanager?: string;
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read the build: the rule groups, and an Alertmanager config (the primary itself, or `alertmanager.yml` beside it). */
export function readBuilt(buildPath: string): Built {
  const text = readFileSync(buildPath, "utf8");
  const doc = loadPrometheusYaml(text);
  const out: Built = { groups: [] };
  if (isObject(doc) && Array.isArray(doc.groups)) {
    out.groups = doc.groups.filter((g): g is Json & { name: string } => isObject(g) && typeof g.name === "string");
  } else if (isObject(doc) && ("route" in doc || "receivers" in doc)) {
    out.alertmanager = text;
  }
  const sibling = join(dirname(buildPath), "alertmanager.yml");
  if (out.alertmanager === undefined && basename(buildPath) !== "alertmanager.yml" && existsSync(sibling)) {
    out.alertmanager = readFileSync(sibling, "utf8");
  }
  return out;
}

/**
 * True when every key the declared value carries is in the live one with an
 * equal value. A ruler adds fields of its own to a group it returns
 * (`source_tenants`, say), and those are not a difference.
 */
export function covers(declared: unknown, live: unknown): boolean {
  if (Array.isArray(declared)) {
    return Array.isArray(live) && declared.length === live.length && declared.every((d, i) => covers(d, live[i]));
  }
  if (isObject(declared)) {
    return isObject(live) && Object.entries(declared).every(([k, v]) => covers(v, live[k]));
  }
  return declared === live;
}

/** The snapshot file an apply to `environment` writes beside the build file. */
export function snapshotPath(buildPath: string, environment: string): string {
  return join(dirname(buildPath), `.chant-ruler-previous.${environment.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

interface Plan {
  entries: RulerPlanEntry[];
  /** The declared groups to write, with their namespace. */
  writes: Array<{ namespace: string; group: Json & { name: string }; action: "create" | "update"; previous?: RawRuleGroup }>;
  deletes: Array<{ namespace: string; group: RawRuleGroup }>;
  notAttempted: RulerOutcome["notAttempted"];
}

async function planGroups(ruler: RulerApi, built: Built, prune: boolean): Promise<Plan> {
  const target: RulerTarget = ruler.target;
  const plan: Plan = { entries: [], writes: [], deletes: [], notAttempted: [] };
  const declaredNs = declaredNamespaces(target);
  // Read only the declared namespaces. A namespace the project does not
  // declare is never listed, so nothing below can reach it.
  const live = new Map<string, RawRuleGroup[]>();
  for (const ns of declaredNs) live.set(ns, (await ruler.readNamespace(ns)) ?? []);

  const declaredByNs = new Map<string, Set<string>>();
  for (const group of built.groups) {
    const ns = namespaceOfGroup(target, group.name);
    if (ns === undefined || !declaredNs.includes(ns)) {
      plan.notAttempted.push({
        kind: "RuleGroup",
        name: group.name,
        reason: "no-binding",
        detail: `no ruler namespace is declared for group "${group.name}": set prometheus.profiles.<env>.ruler.namespace or groupNamespaces`,
      });
      continue;
    }
    (declaredByNs.get(ns) ?? declaredByNs.set(ns, new Set()).get(ns)!).add(group.name);
    const previous = live.get(ns)?.find((g) => g.name === group.name);
    const name = `${ns}/${group.name}`;
    if (previous === undefined) {
      plan.writes.push({ namespace: ns, group, action: "create" });
      plan.entries.push({ kind: "RuleGroup", name, namespace: ns, group: group.name, action: "create" });
    } else if (!covers(group, previous)) {
      plan.writes.push({ namespace: ns, group, action: "update", previous });
      plan.entries.push({ kind: "RuleGroup", name, namespace: ns, group: group.name, action: "update" });
    } else {
      plan.entries.push({ kind: "RuleGroup", name, namespace: ns, group: group.name, action: "unchanged" });
    }
  }
  if (prune) {
    for (const ns of declaredNs) {
      for (const g of live.get(ns) ?? []) {
        if (declaredByNs.get(ns)?.has(g.name)) continue;
        plan.deletes.push({ namespace: ns, group: g });
        plan.entries.push({ kind: "RuleGroup", name: `${ns}/${g.name}`, namespace: ns, group: g.name, action: "delete" });
      }
    }
  }
  return plan;
}

async function planAlertmanager(
  am: AlertmanagerApi,
  declared: string,
): Promise<{ entry: RulerPlanEntry; previous?: { text: string; templateFiles?: Record<string, string> } }> {
  const name = am.target.tenant ?? "alertmanager";
  const current = await am.readConfig();
  if (current === undefined) return { entry: { kind: "AlertmanagerConfig", name, action: "create" } };
  const same = JSON.stringify(loadPrometheusYaml(current.text)) === JSON.stringify(loadPrometheusYaml(declared));
  return {
    entry: { kind: "AlertmanagerConfig", name, action: same ? "unchanged" : "update" },
    previous: { text: current.text, ...(current.templateFiles ? { templateFiles: current.templateFiles } : {}) },
  };
}

/** What an apply would do, per declared namespace. Reads the ruler; writes nothing. */
export async function planRuler(args: RulerApplyArgs, deps: RulerApplyDeps = {}): Promise<RulerPlanEntry[]> {
  const bound = await bindEndpoints({ ...deps, environment: args.environment });
  if (isUnresolvedTarget(bound.ruler)) throw new Error(bound.ruler.detail);
  const built = readBuilt(args.buildPath);
  const plan = await planGroups(bound.ruler, built, args.prune ?? false);
  const entries = [...plan.entries];
  if (built.alertmanager !== undefined && !isUnresolvedTarget(bound.alertmanager) && bound.alertmanager.target.kind !== "alertmanager") {
    entries.push((await planAlertmanager(bound.alertmanager, built.alertmanager)).entry);
  }
  return entries;
}

function allNotAttempted(built: Built, reason: NotAttemptedReason, detail: string): RulerOutcome {
  return {
    applied: [],
    pruned: [],
    notAttempted: [
      ...built.groups.map((g) => ({ kind: "RuleGroup", name: g.name, reason, detail })),
      ...(built.alertmanager !== undefined ? [{ kind: "AlertmanagerConfig", name: "alertmanager", reason, detail }] : []),
    ],
  };
}

/** Apply the build to the environment's ruler (and Alertmanager). */
export async function rulerApply(args: RulerApplyArgs, deps: RulerApplyDeps = {}): Promise<RulerOutcome> {
  const environment = args.environment ?? "default";
  const built = readBuilt(args.buildPath);
  const bound = await bindEndpoints({ ...deps, environment: args.environment });
  const out: RulerOutcome = { applied: [], pruned: [], notAttempted: [] };

  let snapshot: RulerSnapshot = { environment, restore: [], remove: [] };
  let writeSnapshot = false;

  if (built.groups.length > 0 || args.prune) {
    if (isUnresolvedTarget(bound.ruler)) {
      const failed = allNotAttempted({ groups: built.groups }, bound.ruler.reason, bound.ruler.detail);
      out.notAttempted.push(...failed.notAttempted);
    } else if (bound.ruler.target.kind === "prometheus") {
      const failed = allNotAttempted({ groups: built.groups }, "unsupported-kind", `a plain Prometheus (${bound.ruler.target.source}) has no rule group API`);
      out.notAttempted.push(...failed.notAttempted);
    } else {
      const ruler = bound.ruler;
      try {
        const plan = await planGroups(ruler, built, args.prune ?? false);
        out.notAttempted.push(...plan.notAttempted);
        snapshot.restore = [
          ...plan.writes.filter((w) => w.previous).map((w) => ({ namespace: w.namespace, group: w.previous! })),
          ...plan.deletes.map((d) => ({ namespace: d.namespace, group: d.group })),
        ];
        snapshot.remove = plan.writes.filter((w) => w.action === "create").map((w) => ({ namespace: w.namespace, name: w.group.name }));
        writeSnapshot = plan.writes.length > 0 || plan.deletes.length > 0;
        if (writeSnapshot) saveSnapshot(args.buildPath, snapshot);

        for (const e of plan.entries) {
          if (e.action === "unchanged") out.applied.push({ kind: e.kind, name: e.name, action: "unchanged" });
        }
        for (const w of plan.writes) {
          const name = `${w.namespace}/${w.group.name}`;
          try {
            await ruler.setGroup(w.namespace, w.group as unknown as RawRuleGroup);
            out.applied.push({ kind: "RuleGroup", name, action: w.action === "create" ? "created" : "updated" });
          } catch (err) {
            out.notAttempted.push({ kind: "RuleGroup", name, ...failure(err) });
          }
        }
        for (const d of plan.deletes) {
          const name = `${d.namespace}/${d.group.name}`;
          try {
            await ruler.deleteGroup(d.namespace, d.group.name);
            out.pruned.push({ kind: "RuleGroup", name, deleted: true });
          } catch (err) {
            if (err instanceof PromApiError && err.status === 404) out.pruned.push({ kind: "RuleGroup", name, deleted: false });
            else out.notAttempted.push({ kind: "RuleGroup", name, ...failure(err) });
          }
        }
      } catch (err) {
        const f = failure(err);
        out.notAttempted.push(...built.groups.map((g) => ({ kind: "RuleGroup", name: g.name, ...f })));
      }
    }
  }

  if (built.alertmanager !== undefined) {
    const amName = isUnresolvedTarget(bound.alertmanager) ? "alertmanager" : (bound.alertmanager.target.tenant ?? "alertmanager");
    if (isUnresolvedTarget(bound.alertmanager)) {
      out.notAttempted.push({ kind: "AlertmanagerConfig", name: amName, reason: bound.alertmanager.reason, detail: bound.alertmanager.detail });
    } else if (bound.alertmanager.target.kind === "alertmanager") {
      out.notAttempted.push({
        kind: "AlertmanagerConfig",
        name: amName,
        reason: "unsupported-kind",
        detail: `a plain Alertmanager (${bound.alertmanager.target.source}) has no config API; only Mimir and Cortex take an upload`,
      });
    } else {
      try {
        const { entry, previous } = await planAlertmanager(bound.alertmanager, built.alertmanager);
        if (entry.action === "unchanged") {
          out.applied.push({ kind: entry.kind, name: entry.name, action: "unchanged" });
        } else {
          if (previous) {
            snapshot = { ...snapshot, alertmanager: previous };
          }
          saveSnapshot(args.buildPath, snapshot);
          await bound.alertmanager.setConfig(built.alertmanager);
          out.applied.push({ kind: entry.kind, name: entry.name, action: entry.action === "create" ? "created" : "updated" });
        }
      } catch (err) {
        out.notAttempted.push({ kind: "AlertmanagerConfig", name: amName, ...failure(err) });
      }
    }
  }
  return out;
}

function failure(err: unknown): { reason: NotAttemptedReason; detail: string } {
  const { reason, detail } = classifyPromFailure(err);
  return { reason: reason === "no-credentials" || reason === "no-binding" ? reason : "dependency-failed", detail };
}

function saveSnapshot(buildPath: string, snapshot: RulerSnapshot): void {
  const path = snapshotPath(buildPath, snapshot.environment);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(snapshot, null, 2));
}

export interface RulerRollbackOutcome {
  /** Groups put back to their previous form. */
  restored: number;
  /** Groups the apply created, deleted again. */
  removed: number;
  alertmanagerRestored: boolean;
  /** False when no apply to this environment left a snapshot. */
  hadSnapshot: boolean;
}

/**
 * Re-apply the previous group set: put back every group the last apply
 * replaced or deleted, and delete the ones it created. Touches only the
 * groups the snapshot names, so a namespace the project does not declare is
 * as untouched here as in the apply.
 */
export async function rulerRollback(args: { buildPath: string; environment?: string }, deps: RulerApplyDeps = {}): Promise<RulerRollbackOutcome> {
  const environment = args.environment ?? "default";
  const path = snapshotPath(args.buildPath, environment);
  const outcome: RulerRollbackOutcome = { restored: 0, removed: 0, alertmanagerRestored: false, hadSnapshot: existsSync(path) };
  if (!outcome.hadSnapshot) return outcome;
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as RulerSnapshot;
  const bound = await bindEndpoints({ ...deps, environment: args.environment });
  if (snapshot.restore.length > 0 || snapshot.remove.length > 0) {
    if (isUnresolvedTarget(bound.ruler)) throw new Error(bound.ruler.detail);
    const declared = declaredNamespaces(bound.ruler.target);
    for (const r of snapshot.restore) {
      if (!declared.includes(r.namespace)) continue;
      await bound.ruler.setGroup(r.namespace, r.group);
      outcome.restored++;
    }
    for (const r of snapshot.remove) {
      if (!declared.includes(r.namespace)) continue;
      try {
        await bound.ruler.deleteGroup(r.namespace, r.name);
        outcome.removed++;
      } catch (err) {
        if (!(err instanceof PromApiError && err.status === 404)) throw err;
      }
    }
  }
  if (snapshot.alertmanager !== undefined && !isUnresolvedTarget(bound.alertmanager) && bound.alertmanager.target.kind !== "alertmanager") {
    await bound.alertmanager.setConfig(snapshot.alertmanager.text, snapshot.alertmanager.templateFiles ?? {});
    outcome.alertmanagerRestored = true;
  }
  return outcome;
}

/** The outcome as core's apply envelope (#1446). */
export function toApplyResult(outcome: RulerOutcome): ApplyResult {
  return applyResult(
    outcome.applied.map((a) => ({ kind: a.kind, name: a.name, action: a.action })),
    outcome.pruned,
    outcome.notAttempted,
  );
}
