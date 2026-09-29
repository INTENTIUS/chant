/**
 * Shared plumbing for the grafana post-synth checks: find the dashboards,
 * provisioned datasources and alerting provisioning files in a build's
 * output, and run the plain-function checks in `validate-output.ts` over
 * them.
 *
 * Any output file shaped like a dashboard or a datasource provisioning file
 * counts, not only the grafana lexicon's own, so a dashboard another lexicon
 * embeds is checked the same way. `ExternalDatasource` declarations are never
 * written to a provisioning file, so they come from the build's entities.
 */

import type { PostSynthContext, PostSynthDiagnostic } from "@intentius/chant/lint/post-synth";
import type { SerializerResult } from "@intentius/chant/serializer";
import { loadAll } from "js-yaml";
import { looksLikeAlertingProvisioning, looksLikeDashboard, looksLikeDatasourceProvisioning } from "../../detect";
import { externalDatasourceRecord, type ProvisionedDatasource } from "../../build";
import { isExternalDatasource } from "../../datasource";
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

/** Every dashboard, provisioned datasource and alerting provisioning file in the build's output, and every `ExternalDatasource` it declares. */
export function grafanaArtifacts(ctx: PostSynthContext): GrafanaArtifacts {
  const externalDatasources = [...(ctx.entities?.values() ?? [])].filter(isExternalDatasource).map(externalDatasourceRecord);
  const out: GrafanaArtifacts = { dashboards: [], datasources: [], externalDatasources, alerting: [] };
  for (const [lexicon, output] of ctx.outputs) {
    const texts: Array<[string, string]> =
      typeof output === "string"
        ? [[lexicon, output]]
        : [[lexicon, (output as SerializerResult).primary], ...Object.entries((output as SerializerResult).files ?? {})];
    for (const [source, text] of texts) {
      if (!text) continue;
      for (const doc of parse(text, source)) {
        if (looksLikeDashboard(doc)) out.dashboards.push({ source, json: doc });
        else if (looksLikeAlertingProvisioning(doc)) out.alerting!.push({ source, json: doc });
        else if (looksLikeDatasourceProvisioning(doc)) {
          for (const d of doc.datasources) {
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

/** Diagnostics for one check across the build's output. */
export function grafanaDiagnostics(ctx: PostSynthContext, code: GrafanaIssueCode): PostSynthDiagnostic[] {
  return issuesFor(code, grafanaArtifacts(ctx)).map((i) => ({
    checkId: i.code,
    severity: i.severity,
    message: i.message,
    ...(i.entity ? { entity: i.entity } : {}),
    lexicon: "grafana",
  }));
}
