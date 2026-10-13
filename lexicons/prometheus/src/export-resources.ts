/**
 * Live export for prometheus (#3371): `chant import --from <env>` writes the
 * environment's rule groups and Alertmanager config as chant TypeScript.
 *
 * All I/O is here. What is read goes through the file importer's own parse
 * (./import/parser.ts) into the same IR, so a group read from a ruler and
 * the same group in a rule file generate the same source through the same
 * `PrometheusGenerator`, `Slo` recognition (./import/slo.ts) included.
 *
 * - Rule groups, from the environment's ruler (./api/ruler.ts). On Mimir,
 *   Cortex and Loki only the namespaces the profile declares are read
 *   (`namespace` and `groupNamespaces`, see ./config.ts); that is the
 *   ownership boundary, as a stack bounds a CloudFormation export. An ad-hoc
 *   read with no namespace declared reads every namespace of the tenant and
 *   says so, and with `owned` reads none. On a plain Prometheus the groups
 *   come from `/api/v1/rules` and are mapped back to the rule-file shape
 *   (./api/evaluated.ts), which is lossy, and the export says how.
 * - The Alertmanager config, from `/api/v2/status` or, on Mimir and
 *   Cortex, `/api/v1/alerts` (./api/alertmanager.ts). Alertmanager's status
 *   config is its loaded config marshalled again; unless `verbatim`, what
 *   that adds is taken out (./import/alertmanager-live.ts). Secrets read
 *   `<secret>` and are named in a warning.
 * - `selector.type` is `Prometheus::Rules::RuleGroup` (with `selector.name`
 *   a group name) or any `Prometheus::Alertmanager::*` type, which selects
 *   the whole config.
 *
 * Neither endpoint being bound is an error; one of them being unbound is a
 * warning, so a project with only rule groups imports them.
 */

import type { ExportedTemplate, ResourceSelector } from "@intentius/chant/lexicon";
import type { ResourceIR } from "@intentius/chant/import/parser";
import { bindEndpoints, type BindOptions } from "./api/bind";
import { EVALUATED_IMPORT_WARNING, evaluatedToRuleGroup } from "./api/evaluated";
import type { RulerApi, RawRuleGroup } from "./api/ruler";
import type { AlertmanagerApi } from "./api/alertmanager";
import { declaredNamespaces, isUnresolvedTarget, namespaceOfGroup } from "./config";
import {
  ALERTMANAGER_RESOURCE_TYPE,
  RULE_FILE_RESOURCE_TYPE,
  loadPrometheusYaml,
  parseAlertmanagerDocument,
  parseRuleFileDocument,
  type AlertmanagerResourceProperties,
  type RuleFileResourceProperties,
} from "./import/parser";
import { maskedSecretPaths, stripAlertmanagerDefaults } from "./import/alertmanager-live";
import type { RuleGroupConfig } from "./model";
import { RULE_GROUP_TYPE } from "./rules";

export interface PrometheusExportOptions extends Omit<BindOptions, "environment"> {
  environment: string;
  stack?: string;
  region?: string;
  selector?: ResourceSelector;
  owned?: boolean;
  verbatim?: boolean;
}

const ALERTMANAGER_TYPE_PREFIX = "Prometheus::Alertmanager::";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The groups of the declared namespaces (or, ad hoc, of every namespace), each with where it came from. */
async function rulerGroups(ruler: RulerApi, owned: boolean | undefined, warnings: string[]): Promise<Array<{ namespace: string; raw: RawRuleGroup[] }>> {
  const declared = declaredNamespaces(ruler.target);
  if (declared.length === 0) {
    if (owned) {
      warnings.push(`no rule groups are imported with --owned: ${ruler.target.source} declares no ruler namespace, and the namespace is the ownership boundary`);
      return [];
    }
    const all = await ruler.listNamespaces();
    const names = Object.keys(all);
    if (names.length > 0) {
      warnings.push(
        `${ruler.target.source} declares no ruler namespace, so every namespace of the tenant was read (${names.join(", ")}); ` +
          "set prometheus.profiles.<env>.ruler.namespace to bound what is imported and what an apply may change",
      );
    }
    return names.map((namespace) => ({ namespace, raw: all[namespace] }));
  }
  const out: Array<{ namespace: string; raw: RawRuleGroup[] }> = [];
  for (const namespace of declared) {
    const raw = await ruler.readNamespace(namespace);
    if (raw === undefined) warnings.push(`ruler namespace "${namespace}" has no rule groups on ${ruler.target.url}`);
    else out.push({ namespace, raw });
  }
  return out;
}

async function exportRuleGroups(ruler: RulerApi, options: PrometheusExportOptions, warnings: string[]): Promise<RuleGroupConfig[]> {
  const name = options.selector?.name;
  const groups: RuleGroupConfig[] = [];
  const seen = new Map<string, string>();
  const keep = (group: RuleGroupConfig, from: string) => {
    if (name !== undefined && group.name !== name) return;
    const first = seen.get(group.name);
    if (first !== undefined) {
      warnings.push(`rule group "${group.name}" is in both ${first} and ${from}; the one in ${first} is imported, since a rule file holds one group of a name`);
      return;
    }
    seen.set(group.name, from);
    groups.push(group);
  };

  if (ruler.target.kind === "prometheus") {
    const files = declaredNamespaces(ruler.target);
    if (files.length === 0 && options.owned) {
      warnings.push(`no rule groups are imported with --owned: ${ruler.target.source} names no rule file, and a rule file carries no ownership marker`);
      return [];
    }
    const evaluated = (await ruler.evaluated()).filter((g) => files.length === 0 || files.includes(g.file));
    if (evaluated.length > 0) warnings.push(EVALUATED_IMPORT_WARNING);
    for (const g of evaluated) keep(evaluatedToRuleGroup(g), `rule file "${g.file}"`);
    return groups;
  }

  for (const { namespace, raw } of await rulerGroups(ruler, options.owned, warnings)) {
    const parsed = parseRuleFileDocument({ groups: raw });
    for (const w of parsed.warnings) warnings.push(`ruler namespace "${namespace}": ${w}`);
    for (const g of parsed.file.groups) {
      keep(g, `namespace "${namespace}"`);
      if (seen.get(g.name) === `namespace "${namespace}"` && namespaceOfGroup(ruler.target, g.name) !== namespace) {
        warnings.push(
          `rule group "${g.name}" was read from ruler namespace "${namespace}", which a rule file cannot say; ` +
            `name it under prometheus.profiles.<env>.ruler.groupNamespaces so it is observed and applied there`,
        );
      }
    }
  }
  return groups;
}

async function exportAlertmanager(am: AlertmanagerApi, verbatim: boolean | undefined, warnings: string[]): Promise<ResourceIR | undefined> {
  const live = await am.readConfig();
  if (live === undefined) {
    warnings.push(`${am.target.url} has no Alertmanager config for this tenant`);
    return undefined;
  }
  const loaded = loadPrometheusYaml(live.text);
  if (!isObject(loaded)) throw new Error(`the Alertmanager config read from ${live.address} is not a YAML mapping`);
  const doc = live.remarshalled && !verbatim ? stripAlertmanagerDefaults(loaded) : loaded;
  const masked = maskedSecretPaths(doc);
  if (masked.length > 0) {
    warnings.push(
      `Alertmanager masks secrets in ${live.address}; these read "<secret>" and need their real values (a *_file path, say): ${masked.join(", ")}`,
    );
  }
  if (live.templateFiles) {
    warnings.push(`the Alertmanager's notification templates (${Object.keys(live.templateFiles).join(", ")}) are not imported; templates: names files, not their contents`);
  }
  const parsed = parseAlertmanagerDocument(doc);
  warnings.push(...parsed.warnings.map((w) => `alertmanager: ${w}`));
  return {
    logicalId: "alertmanager",
    type: ALERTMANAGER_RESOURCE_TYPE,
    properties: { config: parsed.config } satisfies AlertmanagerResourceProperties as unknown as Record<string, unknown>,
  };
}

export async function exportResources(options: PrometheusExportOptions): Promise<ExportedTemplate> {
  const { ruler, alertmanager } = await bindEndpoints(options);
  const type = options.selector?.type;
  const wantRules = type === undefined || type === RULE_GROUP_TYPE || type === RULE_FILE_RESOURCE_TYPE;
  const wantAlertmanager = (type === undefined || type.startsWith(ALERTMANAGER_TYPE_PREFIX)) && options.selector?.name === undefined;

  const unbound = [
    ...(wantRules && isUnresolvedTarget(ruler) ? [`rule groups: ${ruler.detail}`] : []),
    ...(wantAlertmanager && isUnresolvedTarget(alertmanager) ? [`Alertmanager: ${alertmanager.detail}`] : []),
  ];
  const wanted = (wantRules ? 1 : 0) + (wantAlertmanager ? 1 : 0);
  if (wanted > 0 && unbound.length === wanted) throw new Error(`nothing to read for environment "${options.environment}": ${unbound.join("; ")}`);

  const warnings: string[] = unbound.map((u) => `not imported, ${u}`);
  const resources: ResourceIR[] = [];
  if (wantRules && !isUnresolvedTarget(ruler)) {
    const groups = await exportRuleGroups(ruler, options, warnings);
    if (groups.length > 0) {
      resources.push({
        logicalId: "ruleFile",
        type: RULE_FILE_RESOURCE_TYPE,
        properties: { file: { groups } } satisfies RuleFileResourceProperties as unknown as Record<string, unknown>,
      });
    }
  }
  if (wantAlertmanager && !isUnresolvedTarget(alertmanager)) {
    const resource = await exportAlertmanager(alertmanager, options.verbatim, warnings);
    if (resource) resources.push(resource);
  }
  return { resources, parameters: [], warnings };
}
