/**
 * Shared plumbing for the grafana post-synth checks: find the dashboards,
 * provisioned datasources, dashboard providers and alerting provisioning
 * files in a build's output, and run the plain-function checks in
 * `validate-output.ts` over them.
 *
 * Any output file shaped like a dashboard or a datasource provisioning file
 * counts, not only the grafana lexicon's own, so a dashboard another lexicon
 * embeds is checked the same way. `ExternalDatasource` declarations are never
 * written to a provisioning file, so they come from the build's entities.
 */

import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { loadAll } from "js-yaml";
import { looksLikeAlertingProvisioning, looksLikeDashboard, looksLikeDashboardProvisioning, looksLikeDatasourceProvisioning } from "../../detect";
import { dashboardUid, externalDatasourceRecord, type ProvisionedDatasource } from "../../build";
import { isAlertRuleEntity, isAlertRuleGroupEntity } from "../../alerting";
import { isDashboardEntity } from "../../dashboard";
import { isDatasourceDeclaration, isExternalDatasource } from "../../datasource";
import { isFolderEntity } from "../../folder";
import { slugUid } from "../../util";
import { issuesFor, type GrafanaArtifacts, type GrafanaIssueCode } from "../../validate-output";

function parse(text: string, name: string): unknown[] {
  if (name.endsWith(".json") || /^\s*[{[]/.test(text)) {
    try {
      return [JSON.parse(text)];
    } catch {
      // fall through to YAML
    }
  }
  try {
    return loadAll(text);
  } catch {
    return [];
  }
}

/** The grafana serializer's primary output (build.ts `GrafanaIndex`), which lists the folders the build resolved. */
function isGrafanaIndex(doc: unknown): doc is { folders?: Array<{ uid: string; title: string; path?: string; parentUid?: string }> } {
  return typeof doc === "object" && doc !== null && typeof (doc as { grafanaSchema?: unknown }).grafanaSchema === "string" && Array.isArray((doc as { dashboards?: unknown }).dashboards);
}

/** Every dashboard, provisioned datasource and dashboard provider and alerting provisioning file in the build's output, and every `ExternalDatasource` it declares. */
export function grafanaArtifacts(ctx: PostSynthContext): GrafanaArtifacts {
  const externalDatasources = [...(ctx.entities?.values() ?? [])].filter(isExternalDatasource).map(externalDatasourceRecord);
  const out: GrafanaArtifacts = { dashboards: [], datasources: [], externalDatasources, providers: [], alerting: [], folders: [], deleteDatasources: [] };
  for (const [lexicon, output] of ctx.outputs) {
    const texts: Array<[string, string]> =
      typeof output === "string"
        ? [[lexicon, output]]
        : [[lexicon, (output as SerializerResult).primary], ...Object.entries((output as SerializerResult).files ?? {})];
    for (const [source, text] of texts) {
      if (!text) continue;
      for (const doc of parse(text, source)) {
        if (looksLikeDashboard(doc)) out.dashboards.push({ source, json: doc });
        else if (looksLikeDashboardProvisioning(doc)) {
          for (const p of doc.providers) if (p && typeof p === "object" && !Array.isArray(p)) out.providers!.push(p as Record<string, unknown>);
        } else if (looksLikeAlertingProvisioning(doc)) out.alerting!.push({ source, json: doc });
        else if (isGrafanaIndex(doc)) {
          for (const f of doc.folders ?? []) if (f && typeof f.uid === "string" && typeof f.title === "string") out.folders!.push(f);
        } else if (looksLikeDatasourceProvisioning(doc)) {
          for (const d of doc.deleteDatasources ?? []) {
            if (d && typeof d === "object" && typeof (d as { name?: unknown }).name === "string") out.deleteDatasources!.push(d as { name: string; orgId?: number });
          }
          for (const d of doc.datasources ?? []) {
            if (d && typeof d === "object" && typeof (d as ProvisionedDatasource).name === "string") {
              const ds = d as ProvisionedDatasource;
              out.datasources.push({ ...ds, uid: typeof ds.uid === "string" ? ds.uid : ds.name });
            }
          }
        }
      }
    }
  }
  return out;
}

/**
 * The entities-map key (the export name, which names the declaring file in
 * provenance) for each name a grafana finding carries as its `entity`: a
 * dashboard's, folder's or alert rule's uid, a datasource's uid or name. The
 * build output has no export names, so a finding that names the uid alone
 * would not resolve to a source file and would be reported at chant.config.ts.
 * An alert rule declared only inside a rule group resolves to the group.
 * A name that is not declared in the build is left out.
 */
export function declaredKeys(entities: ReadonlyMap<string, unknown> | undefined): Map<string, string> {
  const own = new Map<string, string>();
  const viaGroup = new Map<string, string>();
  for (const [key, e] of entities ?? []) {
    if (isDashboardEntity(e)) own.set(dashboardUid(e, key), key);
    else if (isFolderEntity(e)) own.set(e.uid, key);
    else if (isDatasourceDeclaration(e)) {
      own.set(e.uid, key);
      const name = (e.props as { name?: unknown }).name;
      if (typeof name === "string" && !own.has(name)) own.set(name, key);
    } else if (isAlertRuleEntity(e)) own.set(e.props.uid ?? slugUid(e.props.title), key);
    else if (isAlertRuleGroupEntity(e)) {
      for (const rule of e.props.rules) if (isAlertRuleEntity(rule)) viaGroup.set(rule.props.uid ?? slugUid(rule.props.title), key);
    }
  }
  for (const [name, key] of viaGroup) if (!own.has(name)) own.set(name, key);
  return own;
}

/** Diagnostics for one check across the build's output. */
export function grafanaDiagnostics(ctx: PostSynthContext, code: GrafanaIssueCode): PostSynthDiagnostic[] {
  const keys = declaredKeys(ctx.entities);
  return issuesFor(code, grafanaArtifacts(ctx)).map((i) => ({
    checkId: i.code,
    severity: i.severity,
    message: i.message,
    ...(i.entity ? { entity: keys.get(i.entity) ?? i.entity } : {}),
    lexicon: "grafana",
  }));
}
